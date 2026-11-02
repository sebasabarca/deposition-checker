// Analysis and findings endpoints. Starting an analysis records it and queues its job in one
// transaction; the worker does the work. Reading an analysis or a finding only reads stored rows.
// Every quotation in a response is a stored transcript line; model text is returned only in fields
// named as the model's (explanation, alternativeExplanation), with where the verdict came from.

import { Router } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Pool } from "pg";
import { z } from "zod";
import { DEFAULT_EFFORT, DEFAULT_PROMPT_VERSION, DEFAULT_STRATEGY, directCanResume, discoveryRunsOf, DISCOVERY_EFFORT, DISCOVERY_FALLBACK_MODEL, DISCOVERY_MODEL, DISCOVERY_PROMPT_VERSION, EFFORTS, MAX_CONCURRENCY, PRODUCTION_STRATEGY_IDS, PROMPT_VERSIONS, STRATEGIES, type Verdict } from "../adjudicate";
import { withTransaction, type Database } from "../db/client";
import { analyses, budgets, candidates, depositions, discoveryRuns, exchangeLines, findings, lines, verdicts, witnesses } from "../db/schema";
import { analysisCost, candidateSetOf, DIRECT_FABLE, enqueueAnalysis } from "../jobs";
import { cardSummary, latestMapVersion, mapMembers, topicReport } from "../claims";
import { candidateCoverage, compareFindings, directSourceLabel, findingGroup, GROUP_LABELS, GROUP_ORDER, modelName, SOURCE_LABELS, UNSCORED_REASONS, type FindingGroup, type VerdictSource } from "./present";

const Id = z.coerce.number().int().positive();
export const MAX_BUDGET_USD = 20;
export const DEFAULT_BUDGET_USD = 3; // DESIGN.md's default per two-session analysis
// Covers the worst case of a long pair at batch prices, and of a fallback after a refusal.
export const DEFAULT_DIRECT_BUDGET_USD = 6;
export const MAX_CANDIDATES = 300;

const StartAnalysis = z.object({
  depositionA: z.number().int().positive(),
  depositionB: z.number().int().positive(),
  mode: z.enum(["demo", "live"]).default("demo"),
  method: z.enum(["direct_fable", "hybrid"]).optional(), // live defaults to direct_fable; a demo replays stored hybrid verdicts
  budgetUsd: z.number().min(0).max(MAX_BUDGET_USD).optional(),
  maxCandidates: z.number().int().min(1).max(MAX_CANDIDATES).default(MAX_CANDIDATES),
  promptVersion: z.enum(PROMPT_VERSIONS).default(DEFAULT_PROMPT_VERSION),
  effort: z.enum(EFFORTS).default(DEFAULT_EFFORT),
  strategy: z.enum(PRODUCTION_STRATEGY_IDS).default(DEFAULT_STRATEGY as (typeof PRODUCTION_STRATEGY_IDS)[number]),
  maxConcurrency: z.number().int().min(1).max(MAX_CONCURRENCY).optional(), // overrides the strategy's; A stays sequential
});
const ACTIVE = ["queued", "parsing", "retrieving", "adjudicating"] as const;
const RESUMABLE = ["blocked_budget", "blocked_credentials", "failed", "cancelled", "interrupted"];

const ref = (page: number, line: number) => `${page}:${String(line).padStart(2, "0")}`;

// Every candidate's status, and for a hybrid analysis what its cards and topic map cover.
async function analysisCoverage(db: Database, a: typeof analyses.$inferSelect) {
  const rows = await db
    .select({ status: candidates.status, sources: candidates.sources, deferredReason: candidates.deferredReason, exclusionReason: candidates.exclusionReason, selectedBy: candidates.selectedBy, n: sql<number>`count(*)::int` })
    .from(candidates)
    .where(eq(candidates.candidateSet, candidateSetOf(a.id)))
    .groupBy(candidates.status, candidates.sources, candidates.deferredReason, candidates.exclusionReason, candidates.selectedBy);
  if (a.retrieval !== "hybrid") return { candidates: candidateCoverage(rows), cards: null, topics: null };
  const mapVersion = await latestMapVersion(db, a.witnessId);
  return {
    candidates: candidateCoverage(rows),
    cards: await Promise.all([a.depositionA, a.depositionB].map((d) => cardSummary(db, d))),
    topics: mapVersion === null ? null : { mapVersion, ...topicReport(await mapMembers(db, a.witnessId, mapVersion)) },
  };
}

export async function analysisView(db: Database, id: number) {
  const [a] = await db.select().from(analyses).where(eq(analyses.id, id));
  if (!a) return null;
  const docs = await db
    .select({ id: depositions.id, takenOn: depositions.takenOn, status: depositions.status, originalFilename: depositions.originalFilename, witness: witnesses.name })
    .from(depositions)
    .innerJoin(witnesses, eq(witnesses.id, depositions.witnessId))
    .where(inArray(depositions.id, [a.depositionA, a.depositionB]));
  const rows = await db
    .select({ type: findings.type, evidenceStatus: findings.evidenceStatus, score: findings.score, unscoredReason: findings.unscoredReason, priority: findings.priority })
    .from(findings)
    .innerJoin(candidates, eq(candidates.id, findings.candidateId))
    .where(eq(candidates.candidateSet, candidateSetOf(id)));
  const groups: Record<FindingGroup, number> = { contradictions: 0, needs_context: 0, compatible: 0, unverified: 0 };
  for (const r of rows) groups[findingGroup(r)]++;
  const cost = await analysisCost(db, a);
  const runs = a.retrieval === DIRECT_FABLE ? await discoveryRunsOf(db, a.id) : [];
  return {
    id: a.id,
    caseId: a.caseId,
    witnessId: a.witnessId,
    mode: a.mode,
    retrieval: a.retrieval,
    discovery: a.retrieval === DIRECT_FABLE ? discoveryView(runs) : null,
    resumable: a.retrieval === DIRECT_FABLE ? directCanResume(a.status, runs.length) : RESUMABLE.includes(a.status),
    status: a.status,
    error: a.error,
    progress: a.progress,
    coverage: await analysisCoverage(db, a),
    promptVersion: a.promptVersion,
    effort: a.effort,
    maxCandidates: a.maxCandidates,
    strategy: a.strategy,
    candidatesPerRequest: a.candidatesPerRequest,
    maxConcurrency: a.maxConcurrency,
    cancelRequested: a.cancelRequestedAt !== null,
    depositions: [a.depositionA, a.depositionB].map((d) => docs.find((x) => x.id === d)!),
    findings: { total: rows.length, groups },
    cost: { calls: cost.calls, actualUsd: cost.actualUsd, budgetUsd: a.budgetUsd, budgetSpentUsd: cost.budget?.spentUsd ?? 0, budgetReservedUsd: cost.budget?.reservedUsd ?? 0 },
    createdAt: a.createdAt,
    startedAt: a.startedAt,
    finishedAt: a.finishedAt,
    updatedAt: a.updatedAt,
  };
}

// What each paid attempt did, and which model's results these are, in fields a lawyer can read.
function discoveryView(runs: Awaited<ReturnType<typeof discoveryRunsOf>>) {
  const fallback = runs.find((r) => r.role === "fallback");
  const answered = [...runs].reverse().find((r) => r.status === "succeeded");
  return {
    resultModel: answered ? (answered.answered_by ?? answered.model) : null,
    resultModelName: answered ? modelName(answered.answered_by ?? answered.model) : null,
    usedFallback: fallback !== undefined,
    fallbackModel: DISCOVERY_FALLBACK_MODEL,
    primaryModel: DISCOVERY_MODEL,
    promptVersion: runs[0]?.prompt_version ?? DISCOVERY_PROMPT_VERSION,
    sourceHashes: runs[0]?.source_hashes ?? null,
    attempts: runs.map((r) => ({ attempt: r.attempt, role: r.role, model: r.model, modelName: modelName(r.model), status: r.status, batchId: r.batch_id, stopReason: r.stop_reason, refusalCategory: r.refusal_category, error: r.error, costUsd: r.cost_usd === null ? null : Number(r.cost_usd), inputTokens: r.input_tokens, outputTokens: r.output_tokens, thinkingTokens: r.thinking_tokens, latencyMs: r.latency_ms })),
  };
}

type DirectChecks = { lane: FindingGroup; evidenceKey: string; a: DirectSideCheck; b: DirectSideCheck; modelClassification: string; duplicates: unknown[] };
type DirectSideCheck = { depositionId: number; citation: string; speaker: string; ocr: { read: boolean; minConfidence: number | null; lowLines: string[] }; reportedSpeech: boolean };

// The findings of an analysis, grouped for review, each with its references and where it came from.
export async function analysisFindings(db: Database, id: number) {
  const rows = await db
    .select({ f: findings, v: verdicts, c: candidates })
    .from(findings)
    .innerJoin(verdicts, eq(verdicts.id, findings.verdictId))
    .innerJoin(candidates, eq(candidates.id, findings.candidateId))
    .where(eq(candidates.candidateSet, candidateSetOf(id)));
  const firstLines = await firstLineRefs(db, rows.flatMap((r) => [r.c.exchangeA, r.c.exchangeB]));
  const items = rows
    .map(({ f, v, c }) => {
      const parsed = v.parsed as Verdict;
      const direct = (f.checks as { direct?: DirectChecks }).direct ?? null;
      return {
        id: f.id,
        group: findingGroup(f),
        model: v.model,
        modelName: modelName(v.model),
        direct: direct ? { modelClassification: direct.modelClassification, evidenceKey: direct.evidenceKey, duplicates: direct.duplicates.length, ocrRead: direct.a.ocr.read || direct.b.ocr.read, lowOcrLines: [...direct.a.ocr.lowLines, ...direct.b.ocr.lowLines], speakers: [direct.a.speaker, direct.b.speaker] } : null,
        classification: f.type,
        priority: f.priority,
        score: f.score,
        band: f.band,
        evidenceStatus: f.evidenceStatus,
        unscoredReason: f.unscoredReason,
        contextRequested: f.contextRequested,
        reviewState: f.reviewState,
        source: v.origin as VerdictSource,
        rank: c.mergedRank,
        // A direct finding cites exact lines, which may start well inside the exchange.
        a: direct ? { depositionId: direct.a.depositionId, ref: direct.a.citation } : { depositionId: c.depositionA, ref: firstLines.get(c.exchangeA) ?? null },
        b: direct ? { depositionId: direct.b.depositionId, ref: direct.b.citation } : { depositionId: c.depositionB, ref: firstLines.get(c.exchangeB) ?? null },
        sameEvent: parsed.sameEvent,
        explanation: parsed.explanation,
      };
    })
    .sort((x, y) => compareFindings(x, y));
  const groups = GROUP_ORDER.map((g) => ({ group: g, label: GROUP_LABELS[g], findings: items.filter((i) => i.group === g) }));
  // Proposed findings that couldn't be tied to stored lines have no finding row. They stay visible here.
  const runs = await discoveryRunsOf(db, id);
  const notStored = runs.flatMap((r) => ((r.audit ?? []) as { shown: string; findingId: string; classification: string; explanation: string; reasons: string[]; evidenceStatus: string; a: { citation: string }; b: { citation: string } }[])
    .filter((x) => x.shown === "not_stored")
    .map((x) => ({ findingId: x.findingId, model: r.answered_by ?? r.model, modelName: modelName(r.answered_by ?? r.model), classification: x.classification, evidenceStatus: x.evidenceStatus, reasons: x.reasons, citationA: x.a.citation, citationB: x.b.citation, explanation: x.explanation })));
  return { groups, notStored };
}

async function firstLineRefs(db: Database, partIds: number[]) {
  if (partIds.length === 0) return new Map<number, string>();
  const rows = await db.execute<{ exchange_id: string; page: number; line: number }>(sql`
    select distinct on (el.exchange_id) el.exchange_id, l.printed_page as page, l.line_no as line
    from exchange_lines el join lines l on l.id = el.line_id
    where el.exchange_id in (${sql.join(partIds.map((p) => sql`${p}`), sql`, `)})
    order by el.exchange_id, l.printed_page, l.line_no
  `);
  return new Map(rows.rows.map((r) => [Number(r.exchange_id), ref(r.page, r.line)]));
}

type PacketSide = { id: string; session: "A" | "B"; depositionId: number; groupId: number; partIds: number[]; lineIds: number[]; contextLineIds: number[]; gapBefore?: boolean; gapAfter?: boolean };

// One finding with both passages as stored: every line's page:line and text from the transcript,
// the lines code found the cited phrase on, and the context shown to the adjudicator.
export async function findingDetail(db: Database, id: number) {
  const [row] = await db
    .select({ f: findings, v: verdicts, c: candidates })
    .from(findings)
    .innerJoin(verdicts, eq(verdicts.id, findings.verdictId))
    .innerJoin(candidates, eq(candidates.id, findings.candidateId))
    .where(eq(findings.id, id));
  if (!row) return null;
  const { f, v, c } = row;
  const parsed = v.parsed as Verdict;
  const packet = v.packet as { sides: PacketSide[] };
  const checks = f.checks as {
    source: { status: string; a: SideCheck; b: SideCheck };
    attribution: { a: AttributionCheck; b: AttributionCheck };
    context: { detail: string };
    timeCheck: { status: string; detail: string } | null;
    notCorroborated: string[];
    reasons: string[];
    consistencyIssues?: string[];
  };
  const direct = (f.checks as { direct?: DirectChecks }).direct ?? null;
  const usedFallback = direct !== null && v.model === DISCOVERY_FALLBACK_MODEL;
  const allIds = packet.sides.flatMap((s) => [...s.lineIds, ...s.contextLineIds]);
  const stored = new Map(
    (allIds.length ? await db.select({ id: lines.id, page: lines.printedPage, line: lines.lineNo, text: lines.rawText, speaker: lines.speakerRole, ocrConfidence: lines.ocrConfidence, pdfPage: lines.pdfPage }).from(lines).where(inArray(lines.id, allIds)) : []).map((l) => [l.id, l]),
  );
  const roles = new Map(
    (allIds.length
      ? await db.select({ lineId: exchangeLines.lineId, role: exchangeLines.role }).from(exchangeLines).where(inArray(exchangeLines.exchangeId, packet.sides.flatMap((s) => s.partIds)))
      : []
    ).map((r) => [r.lineId, r.role]),
  );
  const docs = await db
    .select({ id: depositions.id, takenOn: depositions.takenOn, originalFilename: depositions.originalFilename, witness: witnesses.name, validation: depositions.validation })
    .from(depositions)
    .innerJoin(witnesses, eq(witnesses.id, depositions.witnessId))
    .where(inArray(depositions.id, [c.depositionA, c.depositionB]));

  const side = (which: "a" | "b") => {
    const p = packet.sides.find((s) => s.session === (which === "a" ? "A" : "B"))!;
    const source = checks.source[which];
    const highlight = new Set(source.evidenceLineIds);
    const inferred = new Set(docs.find((d) => d.id === p.depositionId)?.validation?.ocr?.inferredPages ?? []);
    const show = (ids: number[], kind: "context" | "exchange") =>
      ids.map((lid) => stored.get(lid)).filter((l) => l !== undefined).map((l) => ({ id: l.id, ref: ref(l.page, l.line), text: l.text, role: kind === "exchange" ? (roles.get(l.id) ?? "unknown") : "context", highlighted: highlight.has(l.id), ocrConfidence: l.ocrConfidence, pdfPage: l.pdfPage, pageInferred: inferred.has(l.pdfPage) }));
    const exchangeLineIds = new Set(p.lineIds);
    const firstId = p.lineIds[0];
    const lastId = p.lineIds[p.lineIds.length - 1];
    const before = p.contextLineIds.filter((lid) => !exchangeLineIds.has(lid) && (stored.get(lid)?.page ?? 0) * 100 + (stored.get(lid)?.line ?? 0) < (stored.get(firstId)?.page ?? 0) * 100 + (stored.get(firstId)?.line ?? 0));
    const after = p.contextLineIds.filter((lid) => !before.includes(lid));
    const doc = docs.find((d) => d.id === p.depositionId)!;
    const att = checks.attribution[which];
    return {
      exchangeId: p.id,
      deposition: { id: doc.id, takenOn: doc.takenOn, originalFilename: doc.originalFilename, witness: doc.witness },
      range: firstId && lastId ? `${ref(stored.get(firstId)!.page, stored.get(firstId)!.line)}–${ref(stored.get(lastId)!.page, stored.get(lastId)!.line)}` : null,
      before: show(before, "context"),
      lines: show(p.lineIds, "exchange"),
      after: show(after, "context"),
      gapBefore: p.gapBefore ?? false,
      gapAfter: p.gapAfter ?? false,
      verification: { status: source.status, reason: source.reason, location: source.location, bareAnswer: source.bareAnswer ?? false, matchScore: source.matchScore },
      attribution: {
        level: att.level,
        claude: parsed[which === "a" ? "attributionA" : "attributionB"],
        codeRule: att.codeRule ?? null,
        disagreement: att.disagreement ?? null,
        qualifier: att.qualifier,
        noRecall: att.noRecall,
        approximation: att.approximation,
      },
    };
  };

  return {
    id: f.id,
    analysisId: c.jobId,
    group: findingGroup(f),
    groupLabel: GROUP_LABELS[findingGroup(f)],
    classification: f.type,
    priority: f.priority,
    score: f.score,
    band: f.band,
    unscoredReason: f.unscoredReason,
    unscoredExplanation: f.unscoredReason ? UNSCORED_REASONS[f.unscoredReason] ?? null : null,
    evidenceStatus: f.evidenceStatus,
    contextRequested: f.contextRequested,
    rubricVersion: f.rubricVersion,
    factors: f.factors,
    caps: f.caps,
    notCorroborated: checks.notCorroborated ?? [],
    reasons: checks.reasons ?? [],
    consistencyIssues: checks.consistencyIssues ?? v.consistencyIssues,
    contextCheck: checks.context?.detail ?? null,
    timeCheck: checks.timeCheck,
    source: { kind: v.origin as VerdictSource, label: direct ? directSourceLabel(v.model, usedFallback) : SOURCE_LABELS[v.origin as VerdictSource], model: v.model, modelName: modelName(v.model), usedFallback, promptVersion: v.promptVersion, verdictId: v.id, replayOf: v.replayOf },
    direct: direct ? { modelClassification: direct.modelClassification, evidenceKey: direct.evidenceKey, duplicates: direct.duplicates, sharedSubject: (parsed as { sharedSubject?: string }).sharedSubject ?? null, missingContext: (parsed as { missingContext?: string }).missingContext ?? null, reasoning: (parsed as { confidenceRationale?: string }).confidenceRationale ?? null, conflictBasis: (parsed as { conflictBasisText?: string }).conflictBasisText ?? null, a: { speaker: direct.a.speaker, ocr: direct.a.ocr, reportedSpeech: direct.a.reportedSpeech }, b: { speaker: direct.b.speaker, ocr: direct.b.ocr, reportedSpeech: direct.b.reportedSpeech } } : null,
    assessment: {
      sameEvent: parsed.sameEvent,
      scopeAligned: parsed.scopeAligned,
      conflictBasis: parsed.conflictBasis,
      falsePositiveReason: parsed.falsePositiveReason,
      explanation: parsed.explanation,
      alternativeExplanation: parsed.alternativeExplanation,
      alternativeSupport: parsed.alternativeSupport ?? null,
      inferenceSteps: parsed.inferenceSteps,
      unestablishedAssumptions: parsed.unestablishedAssumptions,
      needsMoreContext: parsed.needsMoreContext,
    },
    a: side("a"),
    b: side("b"),
  };
}
type SideCheck = { status: string; reason: string | null; location: string | null; evidenceLineIds: number[]; bareAnswer?: boolean; matchScore: number };
type AttributionCheck = { level: string; codeRule?: string; disagreement?: string | null; qualifier: string | null; noRecall: boolean; approximation: boolean };

export function analysisRoutes({ db, pool, boss }: { db: Database; pool: Pool; boss: PgBoss }): Router {
  const router = Router();

  router.post("/cases/:id/analyses", async (req, res) => {
    const caseId = Id.safeParse(req.params.id);
    if (!caseId.success) return res.status(400).json({ error: "The case ID must be a positive number." });
    const body = StartAnalysis.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: `Invalid analysis request: ${body.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` });
    const b = body.data;
    const method = b.method ?? (b.mode === "live" ? DIRECT_FABLE : "hybrid");
    if (method === DIRECT_FABLE && b.mode === "demo") return res.status(400).json({ error: "Direct discovery has no demo mode: a demo replays stored hybrid assessments." });
    const budgetUsd = b.budgetUsd ?? (method === DIRECT_FABLE ? DEFAULT_DIRECT_BUDGET_USD : DEFAULT_BUDGET_USD);
    if (b.depositionA === b.depositionB) return res.status(400).json({ error: "Choose two different deposition sessions." });
    const strategy = STRATEGIES[b.strategy];
    const maxConcurrency = strategy.id === "A" ? 1 : (b.maxConcurrency ?? strategy.maxConcurrency);
    const docs = await db.select().from(depositions).where(and(eq(depositions.caseId, caseId.data), inArray(depositions.id, [b.depositionA, b.depositionB])));
    if (docs.length !== 2) return res.status(404).json({ error: "Both depositions must belong to this case." });
    if (docs[0].witnessId !== docs[1].witnessId) return res.status(400).json({ error: "Both depositions must be of the same witness." });
    // Session A is the earlier one (by date, then by upload order), as the findings show them.
    const [first, second] = [...docs].sort((x, y) => (x.takenOn ?? "9999").localeCompare(y.takenOn ?? "9999") || x.id - y.id);

    const outcome = await withTransaction(pool, async (tx, client) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`analysis:${first.id}:${second.id}:${b.mode}`}, 0))`);
      const [active] = await tx
        .select({ id: analyses.id })
        .from(analyses)
        .where(and(eq(analyses.depositionA, first.id), eq(analyses.depositionB, second.id), eq(analyses.mode, b.mode), eq(analyses.retrieval, method), inArray(analyses.status, [...ACTIVE])));
      if (active) return { id: active.id, created: false };
      const [a] = await tx
        .insert(analyses)
        .values({ caseId: caseId.data, witnessId: first.witnessId, depositionA: first.id, depositionB: second.id, mode: b.mode, retrieval: method, promptVersion: method === DIRECT_FABLE ? DISCOVERY_PROMPT_VERSION : b.promptVersion, effort: method === DIRECT_FABLE ? DISCOVERY_EFFORT : b.effort, maxCandidates: b.maxCandidates, budgetUsd, strategy: strategy.id, candidatesPerRequest: strategy.candidatesPerRequest, maxConcurrency })
        .returning({ id: analyses.id });
      const [budget] = await tx.insert(budgets).values({ name: `analysis-${a.id}`, limitUsd: budgetUsd }).returning({ id: budgets.id });
      await tx.update(analyses).set({ budgetId: budget.id }).where(eq(analyses.id, a.id));
      await enqueueAnalysis(boss, { analysisId: a.id }, { client });
      return { id: a.id, created: true };
    });
    return res.status(outcome.created ? 202 : 200).json({ created: outcome.created, analysis: await analysisView(db, outcome.id) });
  });

  router.get("/cases/:id/analyses", async (req, res) => {
    const caseId = Id.safeParse(req.params.id);
    if (!caseId.success) return res.status(400).json({ error: "The case ID must be a positive number." });
    const ids = await db.select({ id: analyses.id }).from(analyses).where(eq(analyses.caseId, caseId.data)).orderBy(desc(analyses.id));
    return res.json({ analyses: await Promise.all(ids.map((r) => analysisView(db, r.id))) });
  });

  router.get("/analyses/:id", async (req, res) => {
    const id = Id.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "The analysis ID must be a positive number." });
    const view = await analysisView(db, id.data);
    if (!view) return res.status(404).json({ error: "Analysis not found." });
    return res.json({ analysis: view });
  });

  // Continue a blocked or failed analysis, optionally with a larger budget. Completed work is kept,
  // and candidates that already have a verdict are not adjudicated again.
  router.post("/analyses/:id/resume", async (req, res) => {
    const id = Id.safeParse(req.params.id);
    const body = z.object({ budgetUsd: z.number().min(0).max(MAX_BUDGET_USD).optional(), retryInvalid: z.boolean().optional() }).safeParse(req.body ?? {});
    if (!id.success || !body.success) return res.status(400).json({ error: "Invalid resume request." });
    const outcome = await withTransaction(pool, async (tx, client) => {
      const [a] = await tx.select().from(analyses).where(eq(analyses.id, id.data)).for("update");
      if (!a) return "not_found" as const;
      if (a.retrieval === DIRECT_FABLE) {
        const attempts = await tx.$count(discoveryRuns, eq(discoveryRuns.analysisId, a.id));
        if (!directCanResume(a.status, attempts)) return "direct_final" as const;
      } else if (!RESUMABLE.includes(a.status)) return a.status;
      if (body.data.budgetUsd !== undefined) {
        if (body.data.budgetUsd < a.budgetUsd) return "lower_budget" as const;
        await tx.update(budgets).set({ limitUsd: body.data.budgetUsd }).where(eq(budgets.id, a.budgetId!));
        await tx.update(analyses).set({ budgetUsd: body.data.budgetUsd }).where(eq(analyses.id, a.id));
      }
      await tx.update(analyses).set({ status: "queued", error: null, finishedAt: null, cancelRequestedAt: null, updatedAt: new Date(), progress: sql`${analyses.progress} || ${JSON.stringify({ retryInvalid: body.data.retryInvalid === true })}::jsonb` }).where(eq(analyses.id, a.id));
      await enqueueAnalysis(boss, { analysisId: a.id }, { client });
      return "queued" as const;
    });
    if (outcome === "not_found") return res.status(404).json({ error: "Analysis not found." });
    if (outcome === "direct_final") return res.status(409).json({ error: "This direct analysis can't continue, because no paid attempt is repeated. Start a new analysis." });
    if (outcome === "lower_budget") return res.status(400).json({ error: "A budget can only be raised, not lowered." });
    if (outcome !== "queued") return res.status(409).json({ error: `Only a blocked or failed analysis can be resumed; this one is ${outcome}.` });
    return res.status(202).json({ analysis: await analysisView(db, id.data) });
  });

  // Stop an analysis: no new request is sent, and requests in flight are aborted within a second or
  // so and counted in full, in case they were billed. One not yet running is cancelled at once.
  router.post("/analyses/:id/cancel", async (req, res) => {
    const id = Id.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "The analysis ID must be a positive number." });
    const [a] = await db.select().from(analyses).where(eq(analyses.id, id.data));
    if (!a) return res.status(404).json({ error: "Analysis not found." });
    if (!ACTIVE.includes(a.status as (typeof ACTIVE)[number])) return res.status(409).json({ error: `Only a running analysis can be cancelled; this one is ${a.status}.` });
    // A direct analysis may hold a paid batch: the job cancels it and records what came back.
    const holdsBatch = a.retrieval === DIRECT_FABLE && (await db.select({ id: discoveryRuns.id }).from(discoveryRuns).where(eq(discoveryRuns.analysisId, a.id)).limit(1)).length > 0;
    const changes = a.runnerId === null && !holdsBatch ? { status: "cancelled" as const, error: "Cancelled before it started assessing. Completed findings are kept.", finishedAt: new Date() } : {};
    await db.update(analyses).set({ cancelRequestedAt: new Date(), updatedAt: new Date(), ...changes }).where(eq(analyses.id, a.id));
    return res.status(202).json({ analysis: await analysisView(db, a.id) });
  });

  router.get("/analyses/:id/findings", async (req, res) => {
    const id = Id.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "The analysis ID must be a positive number." });
    const [a] = await db.select({ id: analyses.id }).from(analyses).where(eq(analyses.id, id.data));
    if (!a) return res.status(404).json({ error: "Analysis not found." });
    return res.json(await analysisFindings(db, id.data));
  });

  router.get("/findings/:id", async (req, res) => {
    const id = Id.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "The finding ID must be a positive number." });
    const detail = await findingDetail(db, id.data);
    if (!detail) return res.status(404).json({ error: "Finding not found." });
    return res.json({ finding: detail });
  });

  return router;
}

