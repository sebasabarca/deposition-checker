// Direct discovery: one model reads both sessions whole and proposes possible inconsistencies. It
// proposes only: code verifies every citation, sorts each finding into a lane, and a person decides.
// Only this file and model.ts talk to the adjudication models.
//
// One attempt, plus at most one fallback after a confirmed refusal. Each attempt is a Batch API
// request, and each step here is safe to repeat: the row and its reservation are written before the
// provider is called, the batch ID right after, and the result is stored in one transaction. A
// restarted worker polls the batch it already has, so a crash can't submit a second paid request. If
// it died between the two writes, nobody can know whether the batch exists, so nothing more is sent.

import Anthropic from "@anthropic-ai/sdk";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { BudgetExceeded, closeFailed, failureIsUnbilled, maxBatchRequestCost, recordCall, releaseUnbilled, reserve, settle } from "../costs";
import type { Database } from "../db/client";
import { analyses, candidates, depositions, discoveryRuns, exchangeLines, exchanges, findings, lines, verdicts, witnesses } from "../db/schema";
import { hasPhysicalLines } from "../ingest";
import { EVIDENCE_STRENGTH_VERSION, evidenceStrength, unscoredReasonOf } from "../score";
import { evidenceKey, groupDuplicates, verifyDirectFinding, type DirectCheck, type DirectSide, type StoredLine, type StoredSession } from "../verify";
import { DISCOVERY_PROMPT_VERSION, DISCOVERY_SYSTEM, discoveryUserPrompt, promptHash } from "./discoverPrompt";
import { DISCOVERY_JSON_SCHEMA, readDiscoveryOutput, type DiscoveryFinding, type DiscoveryOutput } from "./discoverSchema";

export const DISCOVERY_MODEL = "claude-fable-5-1";
export const DISCOVERY_FALLBACK_MODEL = "claude-opus-5-5";
export const DISCOVERY_EFFORT = "xhigh";
export const DISCOVERY_MAX_OUTPUT_TOKENS = 64_000;
export const DISCOVERY_CONTEXT_TOKENS = 1_000_000; // both models' published context window
const CONTEXT_LINES = 5;
// A failed check doesn't mean a failed batch: it may still be running, and billing. With a check every
// 30 seconds, this rides out about five minutes of provider trouble.
export const MAX_POLL_FAILURES = 10;

export type DiscoveryRequest = { customId: string; model: string; user: string; maxOutputTokens: number };
export type DiscoveryMessage = Pick<Anthropic.Message, "model" | "stop_reason" | "content" | "usage"> & { stop_details?: { category?: string | null; explanation?: string | null } | null };
export type DiscoveryResult =
  | { type: "succeeded"; message: DiscoveryMessage }
  | { type: "errored"; error: string }
  | { type: "expired" }
  | { type: "canceled" }
  | { type: "missing" };

export type DiscoveryProvider = {
  maxOutputTokens?: number; // a lower output cap, for a run under a tight ceiling
  submit(request: DiscoveryRequest): Promise<{ batchId: string }>;
  poll(batchId: string): Promise<{ ended: boolean; latencyMs: number | null }>;
  result(batchId: string, customId: string): Promise<DiscoveryResult>;
  cancel(batchId: string): Promise<void>;
};

export function anthropicDiscovery(client = new Anthropic({ maxRetries: 0 }), maxOutputTokens?: number): DiscoveryProvider {
  const batches = client.messages.batches;
  return {
    maxOutputTokens,
    async submit({ customId, model, user, maxOutputTokens: limit }) {
      const batch = await batches.create({
        requests: [{
          custom_id: customId,
          params: {
            model,
            max_tokens: limit,
            system: [{ type: "text", text: DISCOVERY_SYSTEM, cache_control: { type: "ephemeral" } }],
            output_config: { effort: DISCOVERY_EFFORT, format: { type: "json_schema", schema: DISCOVERY_JSON_SCHEMA } },
            messages: [{ role: "user", content: user }],
          },
        }],
      });
      return { batchId: batch.id };
    },
    async poll(batchId) {
      const batch = await batches.retrieve(batchId);
      const ended = batch.processing_status === "ended";
      return { ended, latencyMs: ended && batch.ended_at ? new Date(batch.ended_at).getTime() - new Date(batch.created_at).getTime() : null };
    },
    async result(batchId, customId) {
      for await (const item of await batches.results(batchId)) {
        if (item.custom_id !== customId) continue;
        if (item.result.type === "succeeded") return { type: "succeeded", message: item.result.message };
        if (item.result.type === "errored") return { type: "errored", error: JSON.stringify(item.result.error).slice(0, 1000) };
        return { type: item.result.type };
      }
      return { type: "missing" };
    },
    async cancel(batchId) {
      await batches.cancel(batchId);
    },
  };
}

export type RunStatus = (typeof discoveryRuns.$inferSelect)["status"];
type Classified =
  | { status: "succeeded"; output: DiscoveryOutput; text: string }
  | { status: "refused"; category: string | null; detail: string | null; text: string | null }
  | { status: "invalid_output"; error: string; text: string | null }
  | { status: "incomplete"; error: string; text: string | null }
  | { status: "provider_failed" | "expired" | "cancelled"; error: string };

// What came back. Pure. A valid answer with no findings is a success, never a refusal: only the
// provider's explicit refusal can lead to a fallback.
export function classifyDiscovery(result: DiscoveryResult): Classified {
  if (result.type === "errored") return { status: "provider_failed", error: result.error };
  if (result.type === "expired") return { status: "expired", error: "The batch expired before the request ran." };
  if (result.type === "canceled") return { status: "cancelled", error: "The batch was cancelled before the request finished." };
  if (result.type === "missing") return { status: "provider_failed", error: "The ended batch holds no result for this request." };
  const { message } = result;
  const block = message.content.find((b) => b.type === "text");
  const text = block?.type === "text" ? block.text : null;
  if (message.stop_reason === "refusal") return { status: "refused", category: message.stop_details?.category ?? null, detail: message.stop_details?.explanation ?? null, text };
  if (message.stop_reason !== "end_turn") return { status: "incomplete", error: `The model stopped with ${message.stop_reason ?? "no stop reason"} before finishing its answer.`, text };
  const read = readDiscoveryOutput(text);
  return read.output ? { status: "succeeded", output: read.output, text: text! } : { status: "invalid_output", error: read.error!, text };
}

type Analysis = typeof analyses.$inferSelect;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type DiscoveryStep = { outcome: "polling" | "completed" } | { outcome: "failed" | "blocked_budget" | "interrupted" | "cancelled"; error: string };

export async function loadSessions(db: Database, a: Pick<Analysis, "witnessId" | "depositionA" | "depositionB">) {
  const [witness] = await db.select({ name: witnesses.name }).from(witnesses).where(eq(witnesses.id, a.witnessId));
  const docs = await db.select({ id: depositions.id, takenOn: depositions.takenOn, sha: depositions.fileSha256, validation: depositions.validation }).from(depositions).where(inArray(depositions.id, [a.depositionA, a.depositionB]));
  const session = async (label: "A" | "B", depositionId: number): Promise<StoredSession & { description: string }> => {
    const rows = await db
      .select({ id: lines.id, page: lines.printedPage, line: lines.lineNo, pdfPage: lines.pdfPage, text: lines.rawText, role: lines.speakerRole, ocrConfidence: lines.ocrConfidence })
      .from(lines)
      .where(eq(lines.depositionId, depositionId))
      .orderBy(asc(lines.printedPage), asc(lines.lineNo));
    const doc = docs.find((d) => d.id === depositionId);
    return { label, depositionId, lines: rows as StoredLine[], physicalLines: hasPhysicalLines(doc?.validation), description: `session of ${doc?.takenOn ?? "date not stated"}` };
  };
  const pair: [Awaited<ReturnType<typeof session>>, Awaited<ReturnType<typeof session>>] = [await session("A", a.depositionA), await session("B", a.depositionB)];
  return { witness: witness.name, sessions: pair, hashes: Object.fromEntries(docs.map((d) => [d.id, d.sha])) };
}

// An upper bound on the prompt from its characters (no tokenizer produces more tokens than
// characters), so testimony that might not fit is refused rather than cut.
export function inputTokensBound(user: string) {
  return DISCOVERY_SYSTEM.length + user.length + JSON.stringify(DISCOVERY_JSON_SCHEMA).length;
}
export const fitsContext = (inputTokens: number, maxOutputTokens = DISCOVERY_MAX_OUTPUT_TOKENS) => inputTokens + maxOutputTokens <= DISCOVERY_CONTEXT_TOKENS;

async function submitAttempt(db: Database, a: Analysis, provider: DiscoveryProvider, attempt: 1 | 2): Promise<DiscoveryStep> {
  const { witness, sessions, hashes } = await loadSessions(db, a);
  if (sessions.some((s) => s.lines.length === 0)) return { outcome: "failed", error: "A deposition has no stored testimony, so nothing was sent." };
  const user = discoveryUserPrompt(witness, sessions[0], sessions[1]);
  const inputTokens = inputTokensBound(user);
  const maxOutputTokens = provider.maxOutputTokens ?? DISCOVERY_MAX_OUTPUT_TOKENS;
  // Applies to both attempts: a fallback can't help testimony too large for the model.
  if (!fitsContext(inputTokens, maxOutputTokens)) return { outcome: "failed", error: `Insufficient context capacity: these sessions may need up to ${inputTokens} input tokens, and the model allows ${DISCOVERY_CONTEXT_TOKENS - maxOutputTokens} with the output budget. Nothing was sent, and the testimony was not cut.` };
  // The analysis in hand was read when the job started, and Stop can come at any time since. This is
  // the last read before money is committed, for both attempts.
  const [fresh] = await db.select({ cancel: analyses.cancelRequestedAt }).from(analyses).where(eq(analyses.id, a.id));
  if (fresh.cancel !== null) return { outcome: "cancelled", error: "Cancelled before anything more was sent." };
  const model = attempt === 1 ? DISCOVERY_MODEL : DISCOVERY_FALLBACK_MODEL;
  const maxCostUsd = maxBatchRequestCost(model, { inputTokens, maxOutputTokens });
  let reservationId: number;
  try {
    reservationId = await reserve(db, a.budgetId!, maxCostUsd, `discovery ${model} analysis ${a.id}`);
  } catch (error) {
    if (!(error instanceof BudgetExceeded)) throw error;
    return { outcome: "blocked_budget", error: `Stopped before a ${attempt === 1 ? "discovery" : "fallback"} request that could cost $${maxCostUsd.toFixed(2)}: only $${error.availableUsd.toFixed(2)} of this analysis's budget remains. Nothing more was sent.` };
  }
  const customId = `analysis-${a.id}-attempt-${attempt}`;
  const [run] = await db
    .insert(discoveryRuns)
    .values({ analysisId: a.id, attempt, role: attempt === 1 ? "primary" : "fallback", model, promptVersion: DISCOVERY_PROMPT_VERSION, effort: DISCOVERY_EFFORT, maxOutputTokens, status: "submitting", customId, reservationId, maxCostUsd, sourceHashes: { depositions: hashes, prompt: promptHash(DISCOVERY_SYSTEM + user) } })
    .returning({ id: discoveryRuns.id });
  try {
    const { batchId } = await provider.submit({ customId, model, user, maxOutputTokens });
    await db.update(discoveryRuns).set({ status: "submitted", batchId }).where(eq(discoveryRuns.id, run.id));
    return { outcome: "polling" };
  } catch (error) {
    await closeFailed(db, reservationId, error);
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    const unbilled = failureIsUnbilled(error);
    await db.update(discoveryRuns).set({ status: unbilled ? "provider_failed" : "submission_unknown", error: message, finishedAt: new Date() }).where(eq(discoveryRuns.id, run.id));
    return { outcome: "failed", error: unbilled ? `The provider rejected the request: ${message}` : `The request failed in a way that may have started a paid batch, so nothing more was sent: ${message}` };
  }
}

const PAIR_TYPE: Record<DiscoveryFinding["classification"], string> = { direct_contradiction: "direct", inferential_contradiction: "inferential", compatible: "false_positive", insufficient_evidence: "insufficient_evidence", uncertain_needs_context: "insufficient_evidence" };

type Proposed = { finding: DiscoveryFinding; check: DirectCheck; a: DirectSide; b: DirectSide; lane: DirectCheck["lane"] };

// The side from each session, whichever way round the model cited them.
function bySession(finding: DiscoveryFinding, check: DirectCheck) {
  return finding.session_a === "A" ? { a: check.a, b: check.b, excerptA: finding.exact_excerpt_a, excerptB: finding.exact_excerpt_b } : { a: check.b, b: check.a, excerptA: finding.exact_excerpt_b, excerptB: finding.exact_excerpt_a };
}

function verdictOf(p: Proposed, keyA: string, keyB: string, ids: { a: number; b: number }) {
  const f = p.finding;
  return {
    classification: PAIR_TYPE[f.classification], modelClassification: f.classification,
    evidenceAId: `E${ids.a}`, evidenceBId: `E${ids.b}`, keyPhraseA: keyA, keyPhraseB: keyB,
    attributionA: "unclear", attributionB: "unclear", stanceA: "unclear", stanceB: "unclear",
    sameEvent: f.comparable, scopeAligned: "uncertain", conflictBasis: "none", conflictBasisText: f.conflict_basis, aboutTimingOfSameEvent: false,
    inferenceSteps: [], unestablishedAssumptions: f.missing_context ? [f.missing_context] : [], falsePositiveReason: null,
    explanation: f.explanation, alternativeExplanation: f.alternative_explanation || null, needsMoreContext: p.lane === "needs_context",
    sharedSubject: f.shared_subject, propositionA: f.factual_proposition_a, propositionB: f.factual_proposition_b, missingContext: f.missing_context, confidenceRationale: f.confidence_rationale,
  };
}

const sideChecks = (s: DirectSide) => ({
  source: { status: s.quote === "exact" ? "verified" : s.quote === "approximate" ? "approximate" : s.quote === "elsewhere_in_session" ? "wrong_reference" : "unsupported", reason: s.resolved ? null : "the citation doesn't resolve to stored lines", location: s.speaker, evidenceLineIds: s.lineIds, matchScore: s.matchScore },
  attribution: { level: s.level, codeRule: s.rule, disagreement: null, qualifier: s.qualifier, noRecall: s.noRecall, approximation: false },
});

async function storeFindings(tx: Tx, a: Analysis, llmCallId: number, modelAnswered: string, output: DiscoveryOutput, witness: string, sessions: readonly [StoredSession, StoredSession]) {
  const proposed: Proposed[] = output.findings.map((finding) => {
    const check = verifyDirectFinding(finding, sessions, witness);
    const { a: sideA, b: sideB } = bySession(finding, check);
    return { finding, check, a: sideA, b: sideB, lane: check.lane };
  });
  const lineIds = proposed.flatMap((p) => [...p.a.lineIds, ...p.b.lineIds]);
  const parts = lineIds.length === 0 ? [] : await tx
    .select({ lineId: exchangeLines.lineId, exchangeId: exchanges.id, groupId: exchanges.groupId })
    .from(exchangeLines)
    .innerJoin(exchanges, eq(exchanges.id, exchangeLines.exchangeId))
    .where(inArray(exchangeLines.lineId, lineIds));
  const partOf = new Map<number, (typeof parts)[number]>();
  for (const p of parts) if (!partOf.has(p.lineId) || p.exchangeId < partOf.get(p.lineId)!.exchangeId) partOf.set(p.lineId, p);
  const firstPart = (s: DirectSide) => s.lineIds.map((id) => partOf.get(id)).find((p) => p !== undefined);

  // Findings that can't be tied to stored exchanges have no row in the review tables. They stay in the audit.
  const placed = proposed.filter((p) => firstPart(p.a) && firstPart(p.b));
  const audit = proposed.map((p) => ({ findingId: p.finding.finding_id, classification: p.finding.classification, lane: p.lane, evidenceStatus: p.check.evidenceStatus, identityIssues: p.check.identityIssues, reasons: p.check.reasons, a: p.a, b: p.b, explanation: p.finding.explanation, shown: "not_stored" as "not_stored" | "shown" | "duplicate" }));
  for (const group of groupDuplicates(placed)) {
    const [p, ...copies] = group;
    const [pa, pb] = [firstPart(p.a)!, firstPart(p.b)!];
    const key = evidenceKey(p.a, p.b);
    // The database keeps pairs in deposition order, and a pair can hold several distinct findings.
    const ordered = p.a.depositionId <= p.b.depositionId;
    const [low, high] = ordered ? [{ s: p.a, x: pa }, { s: p.b, x: pb }] : [{ s: p.b, x: pb }, { s: p.a, x: pa }];
    const pair = { candidateSet: `analysis-${a.id}`, depositionA: low.s.depositionId, groupA: low.x.groupId, depositionB: high.s.depositionId, groupB: high.x.groupId };
    const [existing] = await tx.select({ id: candidates.id }).from(candidates).where(and(eq(candidates.candidateSet, pair.candidateSet), eq(candidates.depositionA, pair.depositionA), eq(candidates.groupA, pair.groupA), eq(candidates.depositionB, pair.depositionB), eq(candidates.groupB, pair.groupB)));
    const candidateId = existing?.id ?? (await tx.insert(candidates).values({ ...pair, jobId: a.id, witnessId: a.witnessId, exchangeA: low.x.exchangeId, exchangeB: high.x.exchangeId, sources: ["direct"], rrfScore: 0, mergedRank: placed.indexOf(p) + 1, evidence: [], status: "adjudicated", retrievalVersion: DISCOVERY_PROMPT_VERSION }).returning({ id: candidates.id }))[0].id;
    const { excerptA, excerptB } = bySession(p.finding, p.check);
    const context = (s: DirectSide) => {
      const all = sessions.find((x) => x.depositionId === s.depositionId)!.lines;
      const [first, last] = [all.findIndex((l) => l.id === s.lineIds[0]), all.findIndex((l) => l.id === s.lineIds[s.lineIds.length - 1])];
      return all.slice(Math.max(0, first - CONTEXT_LINES), last + 1 + CONTEXT_LINES).map((l) => l.id).filter((id) => !s.lineIds.includes(id));
    };
    const sidePacket = (session: "A" | "B", s: DirectSide, x: typeof pa) => ({ id: `E${x.exchangeId}`, session, depositionId: s.depositionId, groupId: x.groupId, partIds: [...new Set(s.lineIds.map((id) => partOf.get(id)?.exchangeId).filter((e): e is number => e !== undefined))], lineIds: s.lineIds, contextLineIds: context(s) });
    const [verdict] = await tx
      .insert(verdicts)
      .values({ candidateId, model: modelAnswered, promptVersion: DISCOVERY_PROMPT_VERSION, effort: DISCOVERY_EFFORT, status: "valid", raw: JSON.stringify(p.finding), parsed: verdictOf(p, excerptA, excerptB, { a: pa.exchangeId, b: pb.exchangeId }), packet: { sides: [sidePacket("A", p.a, pa), sidePacket("B", p.b, pb)] }, origin: "model", llmCallId })
      .returning({ id: verdicts.id });
    const [ca, cb] = [sideChecks(p.a), sideChecks(p.b)];
    const lane = p.lane;
    const type = PAIR_TYPE[p.finding.classification];
    const strength = evidenceStrength({ classification: p.finding.classification, comparable: p.finding.comparable, lane, a: p.a, b: p.b });
    // A person's decision on these same passages carries into a new report of them.
    const [decided] = await tx.select({ state: findings.reviewState, note: findings.reviewNote, at: findings.reviewedAt }).from(findings).where(and(eq(findings.caseId, a.caseId), sql`${findings.checks}->'direct'->>'evidenceKey' = ${key}`, sql`${findings.reviewState} <> 'unreviewed'`)).orderBy(desc(findings.reviewedAt)).limit(1);
    await tx.insert(findings).values({
      caseId: a.caseId, candidateId, verdictId: verdict.id, type, evidenceStatus: p.check.evidenceStatus, attributionA: p.a.level, attributionB: p.b.level, score: strength.score, band: strength.band,
      unscoredReason: unscoredReasonOf(lane, p.check.evidenceStatus, strength.score),
      factors: strength.checks, caps: [],
      checks: {
        source: { status: p.check.evidenceStatus, a: ca.source, b: cb.source }, attribution: { a: ca.attribution, b: cb.attribution }, context: { detail: `${CONTEXT_LINES} lines either side of each citation, for reading. The model read both sessions whole.` },
        timeCheck: null, notCorroborated: [], reasons: p.check.reasons, consistencyIssues: [],
        direct: { lane, evidenceKey: key, a: p.a, b: p.b, identityIssues: p.check.identityIssues, modelClassification: p.finding.classification, duplicates: copies.map((c) => ({ findingId: c.finding.finding_id, classification: c.finding.classification, a: c.a.citation, b: c.b.citation, explanation: c.finding.explanation })) },
      },
      rubricVersion: EVIDENCE_STRENGTH_VERSION,
      priority: strength.priority,
      contextRequested: lane === "needs_context",
      ...(decided ? { reviewState: decided.state, reviewNote: decided.note, reviewedAt: decided.at } : {}),
    });
    audit[proposed.indexOf(p)].shown = "shown";
    for (const c of copies) audit[proposed.indexOf(c)].shown = "duplicate";
  }
  return audit;
}

// Takes one result, once: a repeat finds the row already closed and does nothing.
async function reconcile(db: Database, a: Analysis, run: typeof discoveryRuns.$inferSelect, result: DiscoveryResult, latencyMs: number | null) {
  const classified = classifyDiscovery(result);
  const loaded = classified.status === "succeeded" ? await loadSessions(db, a) : null;
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(discoveryRuns).where(eq(discoveryRuns.id, run.id)).for("update");
    if (current.status !== "submitted") return;
    const changes: Partial<typeof discoveryRuns.$inferInsert> = { status: classified.status, latencyMs, finishedAt: new Date() };
    if (result.type === "succeeded") {
      const call = await recordCall(tx as unknown as Database, { jobId: a.id, stage: "discovery", model: result.message.model, usage: result.message.usage as Anthropic.Usage, attempt: run.attempt, items: 1, batch: true, rawOutput: "text" in classified ? classified.text : null, effort: run.effort, latencyMs });
      await settle(tx as unknown as Database, run.reservationId!, { id: call.id, costUsd: call.costUsd });
      changes.llmCallId = call.id;
      changes.stopReason = result.message.stop_reason;
      if (classified.status === "succeeded") {
        changes.output = classified.output;
        changes.audit = await storeFindings(tx, a, call.id, result.message.model, classified.output, loaded!.witness, loaded!.sessions);
      }
    } else {
      // The provider ran nothing for an expired or cancelled item. An errored one is kept in full.
      if (result.type === "errored" || result.type === "missing") await closeFailed(tx as unknown as Database, run.reservationId!, new Error("error" in classified ? classified.error : "failed"));
      else await releaseUnbilled(tx as unknown as Database, run.reservationId!, `batch item ${result.type}`);
    }
    if (classified.status === "refused") {
      changes.refusalCategory = classified.category;
      changes.error = classified.detail;
    } else if ("error" in classified) changes.error = classified.error;
    await tx.update(discoveryRuns).set(changes).where(eq(discoveryRuns.id, run.id));
  });
}

const FAILURE_LABEL: Partial<Record<RunStatus, string>> = {
  invalid_output: "The model's answer wasn't valid structured output",
  incomplete: "The model stopped before finishing its answer",
  provider_failed: "The provider reported a failure",
  expired: "The batch expired",
};

const setPollFailures = (db: Database, analysisId: number, pollFailures: number) =>
  db.update(analyses).set({ progress: sql`${analyses.progress} || ${JSON.stringify({ pollFailures })}::jsonb` }).where(eq(analyses.id, analysisId));

// Keeps polling through a short outage. After that the run closes, and its reservation counts in full
// whatever the error was: the batch may have run, so no error from a check proves it wasn't billed.
async function pollFailed(db: Database, a: Analysis, run: typeof discoveryRuns.$inferSelect, error: unknown): Promise<DiscoveryStep> {
  const failures = ((a.progress as { pollFailures?: number }).pollFailures ?? 0) + 1;
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  if (failures < MAX_POLL_FAILURES) {
    await setPollFailures(db, a.id, failures);
    return { outcome: "polling" };
  }
  const detail = `Batch ${run.batchId} couldn't be checked ${failures} times in a row, so it may have run and been billed: ${message}`;
  await closeFailed(db, run.reservationId!, new Error(detail));
  await db.update(discoveryRuns).set({ status: "provider_failed", error: detail, finishedAt: new Date() }).where(eq(discoveryRuns.id, run.id));
  return { outcome: "failed", error: `${detail} Nothing more was sent. Start a new analysis if the provider shows no result.`.slice(0, 2000) };
}

// One step of a direct analysis. The job calls this until it stops polling.
export async function advanceDiscovery(db: Database, a: Analysis, provider: DiscoveryProvider): Promise<DiscoveryStep> {
  const runs = await db.select().from(discoveryRuns).where(eq(discoveryRuns.analysisId, a.id)).orderBy(asc(discoveryRuns.attempt));
  const latest = runs[runs.length - 1];
  const cancelled = a.cancelRequestedAt !== null;
  if (!latest) return cancelled ? { outcome: "cancelled", error: "Cancelled before anything was sent." } : submitAttempt(db, a, provider, 1);

  if (latest.status === "submitting") {
    // The last worker died between the write and the provider's answer. Don't guess: stop paying.
    if (latest.reservationId !== null) await closeFailed(db, latest.reservationId, new Error("the worker stopped while submitting"));
    const error = "The worker stopped while submitting this request, so it may have started a paid batch. Nothing more was sent. Start a new analysis if the provider shows no batch.";
    await db.update(discoveryRuns).set({ status: "submission_unknown", error, finishedAt: new Date() }).where(eq(discoveryRuns.id, latest.id));
    return { outcome: "interrupted", error };
  }
  if (latest.status === "submitted") {
    let finished: { result: DiscoveryResult; latencyMs: number | null } | null = null;
    try {
      const { ended, latencyMs } = await provider.poll(latest.batchId!);
      if (ended) finished = { result: await provider.result(latest.batchId!, latest.customId), latencyMs };
      else if (cancelled) await provider.cancel(latest.batchId!).catch(() => undefined); // best effort: polling continues until it ends
    } catch (error) {
      return pollFailed(db, a, latest, error);
    }
    await setPollFailures(db, a.id, 0);
    if (!finished) return { outcome: "polling" };
    await reconcile(db, a, latest, finished.result, finished.latencyMs);
    const [closed] = await db.select().from(discoveryRuns).where(eq(discoveryRuns.id, latest.id));
    return afterAttempt(db, a, provider, closed, cancelled);
  }
  return afterAttempt(db, a, provider, latest, cancelled);
}

// Whether resuming can make progress. A direct analysis can after a budget or credentials stop, or if
// it was cancelled before anything was sent. Any other stop is final, because no attempt repeats.
export function directCanResume(status: string, attempts: number) {
  return status === "blocked_budget" || status === "blocked_credentials" || (status === "cancelled" && attempts === 0);
}

async function afterAttempt(db: Database, a: Analysis, provider: DiscoveryProvider, run: typeof discoveryRuns.$inferSelect, cancelled: boolean): Promise<DiscoveryStep> {
  if (run.status === "succeeded") return { outcome: "completed" };
  if (run.status === "submission_unknown") return { outcome: "interrupted", error: run.error ?? "The request may have started a paid batch. Nothing more was sent." };
  if (run.status === "cancelled" || cancelled) return { outcome: "cancelled", error: "Cancelled. Anything the provider had finished was recorded." };
  // The only way to a second request: a confirmed refusal of the first.
  if (run.status === "refused" && run.attempt === 1) return submitAttempt(db, a, provider, 2);
  if (run.status === "refused") return { outcome: "failed", error: `Both ${DISCOVERY_MODEL} and the fallback ${DISCOVERY_FALLBACK_MODEL} refused this request. No findings were produced.` };
  return { outcome: "failed", error: `${FAILURE_LABEL[run.status] ?? "The request failed"}${run.attempt === 2 ? " on the fallback" : ""}: ${run.error ?? "no detail"}`.slice(0, 2000) };
}

// What each attempt did, for the API. Read-only.
export async function discoveryRunsOf(db: Database, analysisId: number) {
  return db.execute<{ attempt: number; role: string; model: string; status: string; prompt_version: string; stop_reason: string | null; refusal_category: string | null; error: string | null; latency_ms: number | null; cost_usd: string | null; input_tokens: number | null; output_tokens: number | null; thinking_tokens: number | null; answered_by: string | null; audit: unknown; source_hashes: unknown; batch_id: string | null }>(sql`
    select r.attempt, r.role, r.model, r.status, r.prompt_version, r.stop_reason, r.refusal_category, r.error, r.latency_ms, r.audit, r.source_hashes, r.batch_id,
      l.cost_usd, l.input_tokens + l.cache_write_5m_tokens + l.cache_write_1h_tokens + l.cache_read_tokens as input_tokens, l.output_tokens, l.thinking_tokens, l.model as answered_by
    from discovery_runs r left join llm_calls l on l.id = r.llm_call_id
    where r.analysis_id = ${analysisId} order by r.attempt
  `).then((r) => r.rows);
}
