// Exact-request reuse for case runs (DESIGN.md, "Implementation note: exact-request reuse"). Both execution modes
// call these at the point they would send a request: standard (caseRun.ts adjudicateEntry) and economy
// (caseRunBatch.ts advance). No model is called here; a hit only reads a recorded response.
//
// A hit records an `adjudication_requests` row with status `reused` (no llm_calls row, no reservation, cost 0; a
// database check enforces it), points the ledger entry's stored-reply pointer at the source call, and returns the
// source's raw text for the caller to parse through applyReply, so every check runs again with current code.

import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { evidenceKey, requestFingerprint, avoidedCostEstimate, type DepositionEvidence } from "../adjudicate/requestReuse";
import type { ContractId, IssuePacket } from "../adjudicate/packetPrompt";
import { BATCH_MULTIPLIER } from "../costs/pricing";
import type { Database } from "../db/client";
import { adjudicationRequests, depositions, screeningEntries, type caseRuns } from "../db/schema";

type CaseRun = typeof caseRuns.$inferSelect;
type Request = typeof adjudicationRequests.$inferSelect;
export type RequestKeys = { fingerprint: string; evidenceKey: string | null };
export type ReuseSource = { requestId: number; llmCallId: number; text: string; costUsd: number; batch: boolean; caseRunId: number };

// A server switch, never a lawyer's setting: REQUEST_REUSE=off turns reuse off for every run.
export const reuseAllowed = (env: Record<string, string | undefined>) => env.REQUEST_REUSE !== "off";
// Only live runs use or provide reuse (mock and test-model runs record no provider calls), and only when the caller
// turns it on: the worker does, from REQUEST_REUSE (on unless "off"); scripts and tests that pass nothing send every
// request, as before.
export const reuseApplies = (run: Pick<CaseRun, "mode">, enabled: boolean | undefined) => run.mode === "live" && enabled === true;

export async function requestKeys(db: Database, contract: ContractId, packet: IssuePacket, adjudicator: { model: string; effort: string }): Promise<RequestKeys> {
  const ids = [...new Set(packet.passages.map((p) => p.depositionId))];
  const rows = ids.length ? await db.select({ id: depositions.id, witnessId: depositions.witnessId, parserVersion: depositions.parserVersion, evidenceEpoch: depositions.evidenceEpoch }).from(depositions).where(inArray(depositions.id, ids)) : [];
  const evidence = new Map<number, DepositionEvidence>(rows.map((r) => [r.id, { witnessId: r.witnessId, parserVersion: r.parserVersion, evidenceEpoch: r.evidenceEpoch }]));
  return { fingerprint: requestFingerprint(contract, packet, adjudicator), evidenceKey: evidenceKey(packet, evidence) };
}

// The latest eligible source: a completed request (not cut off, no error kind such as a refusal) of a live run of
// the same case, with a recorded call holding its raw text, and the same fingerprint and evidence key. Sent,
// failed, partial, aborted, uncertain, unimported and reused requests never qualify.
export async function findReusable(db: Database, caseId: number, keys: RequestKeys): Promise<ReuseSource | null> {
  if (keys.evidenceKey === null) return null;
  const [row] = await db.execute<{ id: number; llm_call_id: number; text: string; cost: string | null; batch: boolean; case_run_id: number }>(sql`
    select r.id, r.llm_call_id, l.raw_output as text, l.cost_usd::text as cost, l.batch, c.id as case_run_id
    from adjudication_requests r
    join llm_calls l on l.id = r.llm_call_id
    join case_runs c on r.candidate_set = 'case-run-' || c.id
    where r.request_fingerprint = ${keys.fingerprint} and r.evidence_key = ${keys.evidenceKey}
      and r.status = 'completed' and r.error_kind is null and l.raw_output is not null
      and c.case_id = ${caseId} and c.mode = 'live'
    order by r.id desc limit 1`).then((r) => r.rows);
  return row ? { requestId: Number(row.id), llmCallId: Number(row.llm_call_id), text: row.text, costUsd: row.cost === null ? 0 : Number(row.cost), batch: row.batch, caseRunId: Number(row.case_run_id) } : null;
}

// Records the hit and points the entry at the source call (a crash after this is recovered like any stored reply).
// Returns the reply for applyReply and the request row (economy mode reads its round).
export async function recordReuse(
  db: Database, run: CaseRun, entryId: number, packet: IssuePacket, sentIds: number[], adjudicator: { model: string; promptVersion: string },
  source: ReuseSource, keys: RequestKeys, at: { round: number | null; strategy: string; estimatedInputTokens: number; maxOutputTokens: number },
): Promise<{ reply: { text: string | null; callId: number; requestId: number }; request: Request }> {
  const avoided = avoidedCostEstimate(source.costUsd, source.batch, run.execution === "batch", BATCH_MULTIPLIER);
  const [request] = await db.insert(adjudicationRequests).values({
    batchId: randomUUID(), analysisId: null, candidateSet: `case-run-${run.id}`, candidateIds: sentIds, strategy: at.strategy, maxConcurrency: 1,
    model: adjudicator.model, promptVersion: adjudicator.promptVersion, status: "reused", llmCallId: null, reservationId: null,
    estimatedInputTokens: at.estimatedInputTokens, maxOutputTokens: at.maxOutputTokens, maxCostUsd: 0, latencyMs: 0,
    screeningEntryId: entryId, round: at.round, requestFingerprint: keys.fingerprint, evidenceKey: keys.evidenceKey,
    reusedFromRequestId: source.requestId, avoidedCostUsd: Math.round(avoided * 1e8) / 1e8, finishedAt: new Date(),
  }).returning();
  await db.update(screeningEntries).set({ attempts: sql`${screeningEntries.attempts} + 1`, requestId: request.id, llmCallId: source.llmCallId, updatedAt: sql`now()` }).where(eq(screeningEntries.id, entryId));
  return { reply: { text: source.text, callId: source.llmCallId, requestId: request.id }, request };
}

// Stores the keys on a request that is about to be sent, so a later identical request can reuse its response.
export async function storeKeys(db: Database, requestId: number, keys: RequestKeys) {
  await db.update(adjudicationRequests).set({ requestFingerprint: keys.fingerprint, evidenceKey: keys.evidenceKey }).where(eq(adjudicationRequests.id, requestId));
}
