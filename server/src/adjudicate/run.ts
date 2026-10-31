// Adjudicates one stored candidate, end to end:
//   packet from the stored lines -> reserve the call's worst-case cost -> Sonnet -> record the call
//   and settle the reservation -> store the verdict as received (valid, schema_invalid, refused or
//   cut_off) -> for a valid verdict, its consistency check, code's checks and the rubric score ->
//   store the finding. An inconsistent verdict's finding is unscored, for review.
// A finding is stored for every valid verdict, scored or not: an unverified citation is a finding
// with evidence status wrong_reference or unsupported and no score, never dropped.

import { and, eq, inArray } from "drizzle-orm";
import { closeFailed, inputTokenBound, maxRequestCost, recordCall, reserve, settle } from "../costs";
import type { Database } from "../db/client";
import { candidates, depositions, findings, verdicts } from "../db/schema";
import { timed, timedSync } from "../timing";
import { assess, type Assessed } from "./assess";
import { classifyFailure, closeRequest, openRequest, type RequestContext } from "./requests";
import type { Adjudicator } from "./model";
import { formatPacket, loadPacket, packetRecord, type Packet } from "./packet";
import { DEFAULT_PROMPT_VERSION, MAX_OUTPUT_TOKENS, PROMPTS, type PromptVersion } from "./prompt";
import type { Verdict } from "./schema";

export type VerdictStatus = "valid" | "schema_invalid" | "refused" | "cut_off";

// The worst case a packet's call can cost, for the reservation and the estimate shown before a run.
export function maxPacketCost(model: string, packetText: string, promptVersion: PromptVersion = DEFAULT_PROMPT_VERSION): number {
  const prompt = PROMPTS[promptVersion];
  return maxRequestCost(model, {
    inputTokens: inputTokenBound(prompt.system.length + JSON.stringify(prompt.jsonSchema).length + packetText.length),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });
}

// Reads a response into a verdict status, with the schema of the prompt version that asked. Pure.
export function readVerdict(stopReason: string | null, text: string | null, promptVersion: PromptVersion = DEFAULT_PROMPT_VERSION): { status: VerdictStatus; parsed: Verdict | null; error: string | null } {
  if (stopReason === "refusal") return { status: "refused", parsed: null, error: "the model refused" };
  if (stopReason === "max_tokens") return { status: "cut_off", parsed: null, error: `cut off at max_tokens (${MAX_OUTPUT_TOKENS})` };
  if (text === null) return { status: "schema_invalid", parsed: null, error: `no structured output (stop reason ${stopReason})` };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { status: "schema_invalid", parsed: null, error: "the output is not JSON" };
  }
  const result = PROMPTS[promptVersion].schema.safeParse(json);
  if (!result.success) return { status: "schema_invalid", parsed: null, error: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ").slice(0, 2000) };
  return { status: "valid", parsed: result.data, error: null };
}

export type AdjudicationResult = {
  candidateId: number;
  llmCallId: number;
  costUsd: number | null;
  verdictId: number;
  status: VerdictStatus;
  error: string | null;
  findingId: number | null;
  assessed: Assessed | null;
};

export async function adjudicateCandidate(
  db: Database,
  candidateId: number,
  adjudicator: Adjudicator,
  { budgetId, allowRepeat = false, request }: { budgetId: number; allowRepeat?: boolean; request?: RequestContext },
): Promise<AdjudicationResult> {
  // Verdicts are kept per prompt version: a new version runs beside the old ones, so they can be
  // compared; the same version again is a repeat, refused unless asked for.
  const promptVersion = adjudicator.promptVersion;
  const priors = await db
    .select({ id: verdicts.id })
    .from(verdicts)
    .where(and(eq(verdicts.candidateId, candidateId), eq(verdicts.promptVersion, promptVersion)));
  if (priors.length > 0 && !allowRepeat) throw new Error(`Candidate ${candidateId} already has ${promptVersion} verdict ${priors[0].id}; pass allowRepeat to adjudicate it again.`);

  const packet = await timed("adjudicate.load_packet", () => loadPacket(db, candidateId));
  const packetText = formatPacket(packet);
  // Reserved before the request; BudgetExceeded stops here, before anything is sent.
  const maxCostUsd = maxPacketCost(adjudicator.model, packetText, promptVersion);
  const reservation = await reserve(db, budgetId, maxCostUsd, `adjudication ${promptVersion} candidate ${candidateId}`);
  const requestId = request
    ? await openRequest(db, request, { candidateIds: [candidateId], model: adjudicator.model, promptVersion, estimatedInputTokens: inputTokenBound(packetText.length), maxOutputTokens: MAX_OUTPUT_TOKENS, maxCostUsd, reservationId: reservation })
    : null;
  let reply;
  try {
    reply = await timed("adjudicate.api_call", () => adjudicator.adjudicate(packetText, { signal: request?.signal }));
  } catch (error) {
    await closeFailed(db, reservation, error);
    if (requestId !== null) {
      const failure = classifyFailure(error);
      await closeRequest(db, requestId, { status: failure.status, errorKind: failure.kind, error: String(error instanceof Error ? error.message : error).slice(0, 2000), retryAfterMs: failure.retryAfterMs, missingCandidateIds: [candidateId] });
    }
    throw error;
  }
  // Every response is billed, refusals and invalid output included, so every response is recorded.
  const call = await recordCall(db, {
    jobId: request?.analysisId ?? null,
    stage: "adjudication",
    model: adjudicator.model,
    usage: reply.usage,
    attempt: priors.length + 1,
    items: 1,
    rawOutput: reply.text,
    effort: adjudicator.effort,
    latencyMs: reply.latencyMs,
  });
  await settle(db, reservation, call);

  const read = readVerdict(reply.stopReason, reply.text, promptVersion);
  const stored = await storeVerdict(db, { candidateId, packet, read, raw: reply.text, model: reply.model, promptVersion, effort: adjudicator.effort, origin: "model", llmCallId: call.id, requestId });
  if (requestId !== null) await closeRequest(db, requestId, { status: read.status === "valid" ? "completed" : "failed", errorKind: read.status === "valid" ? null : read.status, error: read.error, providerRequestId: reply.requestId ?? null, llmCallId: call.id, latencyMs: reply.latencyMs });
  return { candidateId, llmCallId: call.id, costUsd: call.costUsd, ...stored };
}

export type VerdictOrigin = { origin: "model"; llmCallId: number; requestId?: number | null } | { origin: "replayed"; replayOf: number } | { origin: "fixture" };

// Stores a verdict as received and, for a valid one, code's checks, score and finding, in one
// transaction. Shared by live calls and demo replays, so both go through exactly the same
// verification and scoring; only the recorded origin differs.
export async function storeVerdict(
  db: Database,
  input: {
    candidateId: number;
    packet: Packet;
    read: ReturnType<typeof readVerdict>;
    raw: string | null;
    model: string;
    promptVersion: string;
    effort: string;
  } & VerdictOrigin,
): Promise<Omit<AdjudicationResult, "candidateId" | "llmCallId" | "costUsd">> {
  const { candidateId, packet, read } = input;
  const [deposition] = await db.select({ caseId: depositions.caseId }).from(depositions).where(eq(depositions.id, packet.a.depositionId));
  // shortcut: the disagreement check took the removed claims; feed it statement cards if it proves useful.
  const claimsOnPacket = read.parsed ? { a: [], b: [] } : null;
  const assessed = read.parsed && claimsOnPacket ? timedSync("adjudicate.assess", () => assess(packet, read.parsed!, claimsOnPacket)) : null;

  return timed("adjudicate.persist_finding", () => db.transaction(async (tx) => {
    const [verdict] = await tx
      .insert(verdicts)
      .values({
        candidateId,
        model: input.model,
        promptVersion: input.promptVersion,
        effort: input.effort,
        status: read.status,
        raw: input.raw,
        parsed: read.parsed,
        error: read.error,
        consistencyIssues: assessed?.consistencyIssues ?? [],
        packet: packetRecord(packet),
        origin: input.origin,
        llmCallId: input.origin === "model" ? input.llmCallId : null,
        replayOf: input.origin === "replayed" ? input.replayOf : null,
        requestId: input.origin === "model" ? (input.requestId ?? null) : null,
      })
      .returning({ id: verdicts.id });
    let findingId: number | null = null;
    if (read.parsed && assessed) {
      const { checks, assessment, priority } = assessed;
      const [finding] = await tx
        .insert(findings)
        .values({
          caseId: deposition.caseId,
          candidateId,
          verdictId: verdict.id,
          type: read.parsed.classification,
          evidenceStatus: checks.source.status,
          attributionA: checks.attribution.a.level,
          attributionB: checks.attribution.b.level,
          score: assessment.score,
          band: assessment.band,
          unscoredReason: assessment.unscoredReason,
          factors: assessment.factors,
          caps: assessment.capsApplied,
          checks: { ...checks, notCorroborated: assessment.notCorroborated, reasons: assessment.reasons, consistencyIssues: assessed.consistencyIssues },
          rubricVersion: assessment.rubricVersion,
          priority,
          contextRequested: read.parsed.needsMoreContext,
        })
        .returning({ id: findings.id });
      findingId = finding.id;
    }
    // An invalid, refused or cut-off verdict leaves the candidate selected, so it can be tried again.
    if (read.status === "valid") await tx.update(candidates).set({ status: "adjudicated" }).where(eq(candidates.id, candidateId));
    return { verdictId: verdict.id, status: read.status, error: read.error, findingId, assessed };
  }));
}
