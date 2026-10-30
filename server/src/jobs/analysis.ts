// What the worker does with an analysis job: compare two depositions of one witness, end to end,
// with the existing stages (nothing here re-implements them):
//   parsing       wait until both depositions are read (the ingest worker reads them)
//   retrieving    Path A (stored claims only: no new tagging) and Path B, kept to the two
//                 depositions, merged and selected, saved as the candidate set `analysis-<id>`
//   adjudicating  each selected candidate in rank order: live mode calls the model under the
//                 analysis budget; demo mode replays stored verdicts and never calls a model
//   completed / failed / blocked_budget / blocked_credentials
//
// Every stage reads what is already stored before doing anything, so a job that runs again (pg-boss
// redelivery after a crash, or a resume) continues where it stopped: candidates are saved once, and
// a candidate with a verdict in this analysis is never adjudicated again. Progress is counts, never
// a percentage.

import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { executeAdjudication, persistCandidates, replayCandidate, usesBatchFormat, type Adjudicator, type BatchAdjudicator, type StrategyId } from "../adjudicate";
import { EXTRACTOR_VERSION } from "../claims";
import { budgetStatus, reconcileStale } from "../costs";
import type { Database } from "../db/client";
import { analyses, candidates, depositions, findings, verdicts } from "../db/schema";
import { findPathA, findPathB, mergeCandidates, selectCandidates } from "../retrieve";
import { timed, timedSync } from "../timing";

export const MAX_CONSECUTIVE_FAILURES = 3;
export const MAX_PARSING_CHECKS = 120; // with a 5-second wait between checks, about 10 minutes
export const STALE_RESERVATION_MS = 15 * 60 * 1000;
export const RUNNER_STALE_MS = 60 * 1000; // a runner silent this long has died (it checks in every second)
const PATH_B_MODE = "rare_terms" as const;

export type Analysis = typeof analyses.$inferSelect;
export type AnalysisProgress = {
  candidates?: { selected: number; deferred: number };
  adjudicated?: number; // live model verdicts stored
  replayed?: number; // demo: stored model verdicts replayed
  fixture?: number; // demo: prepared synthetic verdicts
  withoutVerdict?: number; // demo: candidates with no stored verdict to replay
  failed?: number; // live candidates with no verdict because their request failed (their reservations follow the budget rules)
  rateLimited?: number; // requests the API answered with a rate limit or overload
  oversize?: number; // candidates too large for a request, never truncated
  requests?: number; // requests sent
  peakConcurrency?: number;
  retryInvalid?: boolean; // set by an explicit retry: candidates with an invalid verdict are sent again
  findings?: number;
  parsingChecks?: number;
};

// The model for a live analysis, or null when it can't be used: no API key, or paid calls not
// allowed on this server (ALLOW_PAID_CALLS=true). Demo analyses never ask.
// signal: the worker is shutting down.
export type AnalysisDeps = { liveAdjudicator: (a: Analysis) => Adjudicator | null; liveBatchAdjudicator?: (a: Analysis) => BatchAdjudicator | null; signal?: AbortSignal };

// Live analyses call the model only when the server has a key and is explicitly allowed to pay for
// calls. Without both, a live analysis stops as blocked_credentials before any call.
export const paidCallsAllowed = (env: NodeJS.ProcessEnv) => Boolean(env.ANTHROPIC_API_KEY) && env.ALLOW_PAID_CALLS === "true";
export type RunOutcome = "waiting" | "duplicate_delivery" | Analysis["status"];

export const candidateSetOf = (analysisId: number) => `analysis-${analysisId}`;
export const TERMINAL: Analysis["status"][] = ["completed", "failed", "blocked_budget", "blocked_credentials", "cancelled", "interrupted"];

async function update(db: Database, id: number, changes: Partial<typeof analyses.$inferInsert>) {
  await db.update(analyses).set({ ...changes, updatedAt: new Date() }).where(eq(analyses.id, id));
}

async function setProgress(db: Database, id: number, progress: AnalysisProgress) {
  await db.update(analyses).set({ progress: sql`${analyses.progress} || ${JSON.stringify(progress)}::jsonb`, updatedAt: new Date() }).where(eq(analyses.id, id));
}

async function retrieve(db: Database, a: Analysis) {
  const set = candidateSetOf(a.id);
  const [existing] = await db.select({ id: candidates.id }).from(candidates).where(eq(candidates.candidateSet, set)).limit(1);
  if (existing) return;
  const pair = new Set([a.depositionA, a.depositionB]);
  const within = (x: { a: { depositionId: number }; b: { depositionId: number } }) => pair.has(x.a.depositionId) && pair.has(x.b.depositionId);
  const pathA = (await timed("retrieve.path_a", () => findPathA(db, { witnessId: a.witnessId, depositionId: a.depositionB, extractorVersion: EXTRACTOR_VERSION }), { analysisId: a.id })).filter(within);
  const pathB = (await timed("retrieve.path_b", () => findPathB(db, { witnessId: a.witnessId, depositionId: a.depositionB, mode: PATH_B_MODE }), { analysisId: a.id })).pairs.filter(within);
  const { selected, deferred } = timedSync("retrieve.merge_rank", () => selectCandidates(mergeCandidates({ claims: pathA, fulltext: pathB }), { budget: a.maxCandidates }), { analysisId: a.id });
  if (selected.length + deferred.length > 0) await timed("retrieve.persist_candidates", () => persistCandidates(db, { set, witnessId: a.witnessId, selected, deferred, jobId: a.id }), { analysisId: a.id });
  await setProgress(db, a.id, { candidates: { selected: selected.length, deferred: deferred.length } });
}

// The selected candidates of this analysis that have no verdict yet, in rank order.
async function pending(db: Database, analysisId: number, retryInvalid = false) {
  const rows = await db
    .select({ id: candidates.id })
    .from(candidates)
    .where(
      and(
        eq(candidates.candidateSet, candidateSetOf(analysisId)),
        inArray(candidates.status, ["selected", "adjudicated"]),
        retryInvalid
          ? sql`not exists (select 1 from ${verdicts} where ${verdicts.candidateId} = ${candidates.id} and ${verdicts.status} = 'valid')`
          : sql`not exists (select 1 from ${verdicts} where ${verdicts.candidateId} = ${candidates.id})`,
      ),
    )
    .orderBy(asc(candidates.mergedRank));
  return rows.map((r) => r.id);
}

async function countFindings(db: Database, analysisId: number) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(findings)
    .innerJoin(candidates, eq(candidates.id, findings.candidateId))
    .where(eq(candidates.candidateSet, candidateSetOf(analysisId)));
  return row.n;
}

// Marks an analysis whose worker died mid-run as interrupted, and counts any request it left open at
// its full reservation: it may have been billed. Nothing continues until someone resumes it.
export async function interruptAnalysis(db: Database, a: Analysis, reason: string) {
  if (a.budgetId !== null) await reconcileStale(db, a.budgetId, 0);
  await db.update(analyses).set({ status: "interrupted", error: reason, finishedAt: new Date(), runnerId: null, updatedAt: new Date() }).where(eq(analyses.id, a.id));
}

// Takes the analysis for this runner, unless a live runner already has it (a duplicate delivery).
async function claimRunner(db: Database, id: number, runnerId: string) {
  const cutoff = new Date(Date.now() - RUNNER_STALE_MS);
  const [row] = await db
    .update(analyses)
    .set({ runnerId, runnerSeenAt: new Date() })
    .where(and(eq(analyses.id, id), or(isNull(analyses.runnerId), lt(analyses.runnerSeenAt, cutoff))))
    .returning({ id: analyses.id });
  return !!row;
}

export async function runAnalysis(db: Database, analysisId: number, deps: AnalysisDeps): Promise<RunOutcome> {
  const [a] = await db.select().from(analyses).where(eq(analyses.id, analysisId));
  if (!a) throw new Error(`No analysis ${analysisId}.`);
  if (TERMINAL.includes(a.status)) return a.status;
  const runnerId = randomUUID();
  if (!(await claimRunner(db, a.id, runnerId))) return "duplicate_delivery";
  // A live analysis found already adjudicating was running when its worker died. Paid work only
  // starts from an explicit start or resume (status queued), so a restart can never resume spending.
  if (a.mode === "live" && a.status === "adjudicating") {
    await interruptAnalysis(db, a, "The worker stopped while this analysis was running. Completed findings are kept; a request in flight is counted in full in case it was billed. Resume to continue.");
    return "interrupted";
  }
  try {
    return await runClaimed(db, a, runnerId, deps);
  } finally {
    await db.update(analyses).set({ runnerId: null }).where(and(eq(analyses.id, a.id), eq(analyses.runnerId, runnerId)));
  }
}

async function runClaimed(db: Database, a: Analysis, runnerId: string, deps: AnalysisDeps): Promise<RunOutcome> {
  const progress = a.progress as AnalysisProgress;

  // Parsing: both depositions must be read. Waiting is bounded; a deposition that can't be used fails the analysis.
  const docs = await db.select({ id: depositions.id, status: depositions.status }).from(depositions).where(inArray(depositions.id, [a.depositionA, a.depositionB]));
  const notReady = docs.filter((d) => d.status !== "ready");
  if (notReady.some((d) => d.status === "processing")) {
    const checks = (progress.parsingChecks ?? 0) + 1;
    if (checks > MAX_PARSING_CHECKS) {
      await update(db, a.id, { status: "failed", error: "The depositions were still being read after about 10 minutes.", finishedAt: new Date() });
      return "failed";
    }
    await update(db, a.id, { status: "parsing", startedAt: a.startedAt ?? new Date() });
    await setProgress(db, a.id, { parsingChecks: checks });
    return "waiting";
  }
  if (notReady.length > 0) {
    const detail = notReady.map((d) => `deposition ${d.id} is ${d.status}`).join("; ");
    await update(db, a.id, { status: "failed", error: `Both depositions must be read successfully before they can be compared: ${detail}.`, finishedAt: new Date() });
    return "failed";
  }

  await update(db, a.id, { status: "retrieving", startedAt: a.startedAt ?? new Date(), error: null });
  await retrieve(db, a);

  // Live mode needs a model the server is allowed to pay for; checked before any call.
  const strategy = a.strategy as StrategyId;
  const batched = usesBatchFormat(strategy);
  const single = a.mode === "live" && !batched ? deps.liveAdjudicator(a) : null;
  const batch = a.mode === "live" && batched ? (deps.liveBatchAdjudicator?.(a) ?? null) : null;
  if (a.mode === "live" && !single && !batch) {
    await update(db, a.id, {
      status: "blocked_credentials",
      error: "Live analysis needs an Anthropic API key and ALLOW_PAID_CALLS=true on the server. No model was called; the candidates are saved.",
      finishedAt: new Date(),
    });
    return "blocked_credentials";
  }

  await update(db, a.id, { status: "adjudicating" });
  if (a.budgetId !== null) await reconcileStale(db, a.budgetId, STALE_RESERVATION_MS);
  const counts = { adjudicated: progress.adjudicated ?? 0, replayed: progress.replayed ?? 0, fixture: progress.fixture ?? 0, withoutVerdict: progress.withoutVerdict ?? 0, failed: progress.failed ?? 0 };
  const stopped = async (status: Analysis["status"], error: string | null) => {
    await setProgress(db, a.id, { findings: await countFindings(db, a.id) });
    await update(db, a.id, { status, error, finishedAt: new Date() });
    return status;
  };

  if (a.mode === "demo") {
    for (const candidateId of await pending(db, a.id)) {
      const outcome = await timed("adjudicate.replay_candidate", () => replayCandidate(db, candidateId, a.promptVersion), { analysisId: a.id });
      if (outcome.source === "replayed") counts.replayed++;
      else if (outcome.source === "fixture") counts.fixture++;
      else counts.withoutVerdict++;
      await setProgress(db, a.id, counts);
    }
    await setProgress(db, a.id, counts);
    return stopped("completed", null);
  }

  const before = { adjudicated: counts.adjudicated, failed: counts.failed, rateLimited: progress.rateLimited ?? 0, oversize: progress.oversize ?? 0, requests: progress.requests ?? 0 };
  const merged = (c: { adjudicated: number; failed: number; rateLimited: number; oversize: number; requests: number }) => ({ adjudicated: before.adjudicated + c.adjudicated, failed: before.failed + c.failed, rateLimited: before.rateLimited + c.rateLimited, oversize: before.oversize + c.oversize, requests: before.requests + c.requests });
  const result = await executeAdjudication(db, {
    candidateSet: candidateSetOf(a.id),
    analysisId: a.id,
    candidateIds: await pending(db, a.id, progress.retryInvalid),
    strategy,
    maxConcurrency: a.maxConcurrency,
    budgetId: a.budgetId!,
    single: single ?? undefined,
    batch: batch ?? undefined,
    signal: deps.signal,
    allowRepeat: progress.retryInvalid,
    maxConsecutiveFailures: MAX_CONSECUTIVE_FAILURES,
    // Checks in, and notices a cancel request or another runner taking over.
    shouldStop: async () => {
      const [row] = await db.update(analyses).set({ runnerSeenAt: new Date() }).where(eq(analyses.id, a.id)).returning({ cancel: analyses.cancelRequestedAt, runner: analyses.runnerId });
      if (row.cancel) return "cancelled";
      return row.runner === runnerId ? null : "superseded";
    },
    onProgress: async (c) => setProgress(db, a.id, merged(c)),
  });
  await setProgress(db, a.id, { ...merged(result), peakConcurrency: result.peak, retryInvalid: false });

  const kept = "Completed findings are kept.";
  switch (result.stopped) {
    case "budget":
      return stopped("blocked_budget", `Stopped before a request the budget couldn't cover. ${kept}`);
    case "failures":
      return stopped("failed", `${MAX_CONSECUTIVE_FAILURES} model calls failed in a row; the last: ${result.lastError}`.slice(0, 2000));
    case "cancelled":
      return stopped("cancelled", `Cancelled. ${kept} A request in flight is counted in full in case it was billed.`);
    case "shutdown":
    case "superseded":
      return stopped("interrupted", `The worker stopped while this analysis was running. ${kept} A request in flight is counted in full in case it was billed. Resume to continue.`);
    default:
      return stopped("completed", null);
  }
}

// What an analysis has cost: the provider-reported cost of its recorded calls, and its budget
// (which also counts uncertain requests at their full reservation).
export async function analysisCost(db: Database, a: Analysis) {
  // A batch's verdicts share one call: each call counts once.
  const [calls] = await db.execute<{ calls: number; cost: string | null }>(sql`
    select count(*)::int as calls, sum(l.cost_usd) as cost from llm_calls l
    where l.id in (select v.llm_call_id from verdicts v join candidates c on c.id = v.candidate_id where c.candidate_set = ${candidateSetOf(a.id)})
  `).then((r) => r.rows);
  const budget = a.budgetId === null ? null : await budgetStatus(db, a.budgetId);
  return { calls: calls.calls, actualUsd: calls.cost === null ? 0 : Number(calls.cost), budget };
}
