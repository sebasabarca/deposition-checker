// A whole-case analysis: every witness and session of a case, end to end, with existing stages only:
//   retrieving    buildCasePool (retrieve/casePool.ts: the offline multi-path retrieval, triage and
//                 grouping, each with its defaults) on the stored evidence. Every pool pair becomes a
//                 candidate row in the set `case-run-<id>`: selected (in an issue packet), uncovered (in no
//                 packet) or deferred (triage), each with its reason. The packets go into the Milestone 3
//                 screening ledger with screening off: the baseline order, every packet prioritized, no
//                 top-K. Ledger entries carry the candidate, exchange, deposition and session IDs.
//   adjudicating  packet by packet from the ledger (claimNext): packet-v1 through the packet client,
//                 verifyPacketReply, and assessPacketPair into verdicts and findings.
//
// Reliability rules:
//   - A pair that has a verdict in this run is never sent again, and a finding is written at most once per
//     candidate, so re-running after a crash cannot duplicate findings.
//   - A reply is recorded (llm_calls, with its raw text) and its pointer stored on the ledger entry before
//     anything is parsed. A run resumed after a crash parses that stored reply instead of paying again.
//   - Each claim of a packet makes at most 1 + MAX_RECOVERY_ROUNDS model replies: the packet, then one
//     recovery request for the pairs left unanswered. Pairs still unanswered leave the entry `incomplete`,
//     with each pair and why, and their candidates stay `selected`: unread, never compatible.
//   - Live calls reserve their worst case first. A reservation that fails while other requests of the run hold
//     theirs waits for one of them to settle; one the budget can't cover with nothing held stops the run as
//     blocked_budget with the packet returned to the queue. A failure records whether it may have been billed.
//   - A live run found mid-stage by a new runner is marked interrupted: paid work restarts only on resume.
//
// Concurrency: `concurrency` lanes per run (default 1) each claim the next packet from the ledger (skip-locked,
// so never the same one) under a slot from the process's ProviderLimiter (jobs/limiter.ts), which also paces
// requests to the provider's limits and pauses everyone after a 429. Every lane finishes its packet before the
// run stops, interrupts or rethrows, so a stop never releases or relabels work still in flight.
// Mock mode uses the label-blind mock replies (eval/mockPacketModel.ts): no budget, no llm_calls, verdicts
// labelled `fixture`. It measures the pipeline, never model quality.

import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { assessPacketPair } from "../adjudicate/packetAssess";
import { buildIssuePacket, resolvePassages } from "../adjudicate/packetLoad";
import { formatIssuePacket, PACKET_EFFORT, PACKET_MODEL, PACKET_PROMPT_VERSION, PACKET_PROMPTS, maxOutputTokensFor, requestChars, type ContractId, type IssuePacket } from "../adjudicate/packetPrompt";
import { mockStretchReply, readStretchReply, verificationOf, type StretchReading } from "../adjudicate/stretch";
import { STRETCH_RENDER_ID, STRETCH_V2_PROMPT_VERSION } from "../adjudicate/stretchPrompt";
import { buildStretchSet } from "../retrieve/stretchSet";
import type { PacketAdjudicator } from "../adjudicate/packetModel";
import { parseVerdictsLenient, VERDICT_SCHEMAS } from "../adjudicate/packetSchema";
import { classifyFailure, closeRequest, openRequest } from "../adjudicate/requests";
import type { AdjudicatorReply } from "../adjudicate/model";
import { BudgetExceeded, closeFailed, inputTokenBound, maxRequestCost, reconcileStale, recordCall, reserve, settle } from "../costs";
import type { Database } from "../db/client";
import { standingOf } from "../evidence/correction";
import { captureEpochs, isStaleEvidence, jobEpochs, withEvidenceFence } from "../evidence/epoch";
import { adjudicationRequests, budgets, candidates, caseRuns, depositions, findings, llmCalls, screeningEntries, screeningRuns, verdicts, witnesses } from "../db/schema";
import { mockPacketReply } from "../eval/mockPacketModel";
import { buildCasePool, CASE_POOL_VERSION, type CaseItem } from "../retrieve/casePool";
import { CHARS_PER_TOKEN, INSTRUCTION_TOKENS } from "../retrieve/grouping";
import { PACKET_LIMITS, splitPacketSet, type PacketLimits } from "../retrieve/packetSplit";
import { COST_ASSUMPTIONS, projectCost, STRETCH_COST_ASSUMPTIONS } from "../eval/screeningBenchmark";
import type { FrozenItem } from "../retrieve/frozen";
import { pairKey } from "../retrieve/frozen";
import { RUBRIC_V1 } from "../score/rubric";
import { claimNext, markFailed, recordScreening, releaseInProgress, retryFailed } from "../screen/ledger";
import { screen } from "../screen/strategies";
import { MAX_RECOVERY_ROUNDS, verifyPacketReply } from "../verify/packet";
import { VERIFICATION_VERSION } from "../verify/version";
import { Aborted, ProviderLimiter, realClock, UNLIMITED, type Clock } from "./limiter";
import { BATCH_DEFAULTS, reconcileStaleBatchRun, runBatchTick, STALE_BATCH_RECONCILING, type BatchDeps } from "./caseRunBatch";
import { BATCH_MULTIPLIER } from "../costs/pricing";
import { caseHasSources, findReusable, freshOf, recordReuse, requestKeys, reuseApplies, storeKeys, type RequestKeys } from "./requestReuse";

export const CASE_RUN_STATUSES = ["queued", "retrieving", "awaiting_confirmation", "adjudicating", "completed", "incomplete", "failed", "blocked_budget", "blocked_credentials", "cancelled", "interrupted", "reconciling"] as const;
export type CaseRunStatus = (typeof CASE_RUN_STATUSES)[number];
export const CASE_RUN_TERMINAL: CaseRunStatus[] = ["completed", "incomplete", "failed", "blocked_budget", "blocked_credentials", "cancelled", "interrupted"];
export const CASE_RUN_RESUMABLE: CaseRunStatus[] = ["incomplete", "failed", "blocked_budget", "blocked_credentials", "cancelled", "interrupted"];
// The job stops at these and does nothing more until a person acts (confirm, resume).
const JOB_STOPS: CaseRunStatus[] = [...CASE_RUN_TERMINAL, "awaiting_confirmation"];
export const CASE_RUN_RUNNER_STALE_MS = 60 * 1000;
export const MAX_RATE_LIMIT_RETRIES = 2; // per request, after a 429 or 529
export const MAX_CONSECUTIVE_FAILED_PACKETS = 3; // then the run stops as failed: something is wrong beyond one packet
export const MOCK_MODEL = "mock-packet-v1";
export const SCREENING_OFF = "baseline"; // the ledger's order only: every packet is prioritized
export const caseRunSetOf = (id: number) => `case-run-${id}`;

export type CaseRun = typeof caseRuns.$inferSelect;
// The model as the run sees it: one issue packet in, one reply out.
export type CasePacketModel = { model: string; effort: string; promptVersion: string; adjudicate(packet: IssuePacket, options?: { signal?: AbortSignal }): Promise<AdjudicatorReply> };
// adjudicator: the live packet model, or null when this server can't make paid calls.
// faults: test hooks that simulate a crash at a named point.
// concurrency: packets in flight for this run; limiter: shared by every run in the process (none: unlimited).
// signal aborts requests in flight (they become uncertain); drain only stops claiming new packets.
export type CaseRunDeps = {
  adjudicator: (run: CaseRun) => CasePacketModel | null;
  signal?: AbortSignal;
  drain?: AbortSignal;
  concurrency?: number;
  limiter?: ProviderLimiter;
  sleep?: (ms: number) => Promise<void>;
  minilm?: "auto" | "off";
  packetLimits?: PacketLimits; // default PACKET_LIMITS (8 pairs, about 9,000 input tokens)
  // afterRequestSent: the provider has the request, and the process dies before any response is saved.
  faults?: { afterReplyRecorded?: (packetId: string) => void; afterRequestSent?: (packetId: string) => void; afterReuseRecorded?: (packetId: string) => void };
  // Exact-request reuse (jobs/requestReuse.ts): only when true; the worker sets it from REQUEST_REUSE (on unless "off").
  reuse?: boolean;
  // Economy execution (caseRunBatch.ts): the batch provider for a run, or null when this server can't use it.
  batch?: (run: CaseRun) => BatchDeps | null;
};
export type CaseRunExecution = "standard" | "batch";

// The request contract a run sends: packet-v1 (the default), or the experimental whole-stretch contract when the
// run was created with it. Stored as the run's promptVersion, so a resumed run keeps its contract.
export const CASE_RUN_CONTRACTS = [PACKET_PROMPT_VERSION, STRETCH_V2_PROMPT_VERSION] as const;
export type CaseRunContract = (typeof CASE_RUN_CONTRACTS)[number];
export const contractOf = (run: Pick<CaseRun, "promptVersion">): CaseRunContract => (run.promptVersion === STRETCH_V2_PROMPT_VERSION ? STRETCH_V2_PROMPT_VERSION : PACKET_PROMPT_VERSION);
// Whether this server lets a person choose the experimental whole-stretch contract (test-model runs included).
export const stretchAllowed = (env: Record<string, string | undefined>) => env.ALLOW_STRETCH_V2 === "true";
// The depositions a run analyzes, or null for the whole case (stored in its config when it is created).
export const scopeOf = (run: Pick<CaseRun, "config">): number[] | null => (run.config as { scope?: { depositionIds?: number[] } } | null)?.scope?.depositionIds ?? null;

export const fromPacketAdjudicator = (a: PacketAdjudicator): CasePacketModel => ({
  model: a.model, effort: a.effort, promptVersion: a.promptVersion,
  adjudicate: (packet, options) => a.adjudicate((PACKET_PROMPTS[a.promptVersion as ContractId]?.format ?? formatIssuePacket)(packet), packet.pairs.length, options),
});

// The deterministic label-blind mock as a packet model. `model` names what the reply stands in for.
export function mockCaseModel(model = MOCK_MODEL, contract: CaseRunContract = PACKET_PROMPT_VERSION): CasePacketModel & { calls: string[] } {
  const calls: string[] = [];
  return {
    model, effort: "mock", promptVersion: contract, calls,
    async adjudicate(packet) {
      calls.push(packet.id);
      const m = contract === STRETCH_V2_PROMPT_VERSION ? mockStretchReply(packet) : mockPacketReply(packet);
      const usage = { input_tokens: m.usage.inputTokens, output_tokens: m.usage.outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } as AdjudicatorReply["usage"];
      return { model, stopReason: "end_turn", usage, text: m.text, latencyMs: 0, requestId: `mock-${calls.length}` };
    },
  };
}

// Stored with the run's screening ledger so a packet can be rebuilt from the database after a restart.
export type ItemIndex = Record<string, Pick<CaseItem, "document" | "session" | "groupId" | "positions" | "sourceHash" | "depositionId" | "witnessId" | "sessionId" | "exchangeIds">>;

export async function update(db: Database, id: number, changes: Partial<typeof caseRuns.$inferInsert>) {
  await db.update(caseRuns).set({ ...changes, updatedAt: new Date() }).where(eq(caseRuns.id, id));
}

async function claimRunner(db: Database, id: number, runnerId: string) {
  const cutoff = new Date(Date.now() - CASE_RUN_RUNNER_STALE_MS);
  const [row] = await db.update(caseRuns).set({ runnerId, runnerSeenAt: new Date() }).where(and(eq(caseRuns.id, id), or(isNull(caseRuns.runnerId), lt(caseRuns.runnerSeenAt, cutoff)))).returning({ id: caseRuns.id });
  return !!row;
}

const ledgerOf = async (db: Database, caseRunId: number) => (await db.select().from(screeningRuns).where(eq(screeningRuns.caseRunId, caseRunId)))[0] ?? null;

// Work a dead runner left behind. A request still `sent` was received by the provider or not, and nobody can
// tell: its reservation is counted in full, the request is closed as uncertain, and its packet is marked failed
// with failure_billable, so a resume never retries it unless asked to (retryUncertain). A mock request was
// never billable: its packet just goes back to the queue. Every other claimed packet goes back to the queue;
// one holding a stored reply parses it when claimed again.
async function settleAbandoned(db: Database, run: CaseRun, ledgerId: number) {
  if (run.budgetId !== null) await reconcileStale(db, run.budgetId, 0);
  const open = await db.select({ id: adjudicationRequests.id, candidateIds: adjudicationRequests.candidateIds }).from(adjudicationRequests).where(and(eq(adjudicationRequests.candidateSet, caseRunSetOf(run.id)), eq(adjudicationRequests.status, "sent")));
  for (const r of open) {
    const live = run.mode === "live";
    await closeRequest(db, r.id, { status: "aborted", errorKind: live ? "uncertain" : "aborted", error: live ? "The worker stopped before a response was saved. The provider may have received and billed this request; it is counted in full and not retried automatically." : "The worker stopped during a mock request (never billed)." });
    if (!live) continue;
    const note = `uncertain: request ${r.id} was sent and no response was saved; it may have been billed. Retry only on request (retryUncertain).`;
    await db
      .update(screeningEntries)
      .set({ adjudicationStatus: "failed", failureBillable: true, adjudicationNote: note, updatedAt: sql`now()` })
      .where(and(eq(screeningEntries.runId, ledgerId), eq(screeningEntries.adjudicationStatus, "in_progress"), sql`${r.candidateIds[0] ?? 0} = any(${screeningEntries.candidateIds})`));
  }
  await releaseInProgress(db, ledgerId);
}

// Runs that say they are working but that no worker holds: their job was lost (a command-line run that stopped, a
// worker that died after its job expired). The worker queues them again (worker.ts), and the normal path finishes
// them: a paid fast run stops as interrupted, a cancel request ends as cancelled, a free one continues. Economy runs
// in adjudication are left out: their own chain of batch checks keeps them going.
export async function orphanedCaseRuns(db: Database, now = new Date()): Promise<number[]> {
  const cutoff = new Date(now.getTime() - CASE_RUN_RUNNER_STALE_MS);
  const rows = await db
    .select({ id: caseRuns.id })
    .from(caseRuns)
    .where(and(
      inArray(caseRuns.status, ["queued", "retrieving", "adjudicating"]),
      lt(caseRuns.updatedAt, cutoff),
      or(isNull(caseRuns.runnerSeenAt), lt(caseRuns.runnerSeenAt, cutoff)),
      or(sql`${caseRuns.status} <> 'adjudicating'`, sql`${caseRuns.execution} <> 'batch'`),
    ));
  return rows.map((r) => r.id);
}

// Marks a run whose worker died mid-stage as interrupted, after settling what it left behind.
export async function interruptCaseRun(db: Database, run: CaseRun, reason: string) {
  const ledger = await ledgerOf(db, run.id);
  if (ledger) await settleAbandoned(db, run, ledger.id);
  else if (run.budgetId !== null) await reconcileStale(db, run.budgetId, 0);
  await update(db, run.id, { status: "interrupted", error: reason, finishedAt: new Date(), runnerId: null });
}

// "polling": an economy run with batches still open; the caller queues the next check.
export async function runCaseRun(db: Database, pool: Pool, id: number, deps: CaseRunDeps): Promise<CaseRunStatus | "duplicate_delivery" | "polling"> {
  const [run] = await db.select().from(caseRuns).where(eq(caseRuns.id, id));
  if (!run) throw new Error(`No case run ${id}.`);
  if (JOB_STOPS.includes(run.status as CaseRunStatus)) return run.status as CaseRunStatus;
  const runnerId = randomUUID();
  if (!(await claimRunner(db, id, runnerId))) return "duplicate_delivery";
  try {
    // Only adjudication spends money; retrieval is free and simply runs again. An economy run's requests live in
    // the provider's batches, recorded in the database, so a new runner simply continues it.
    if (run.mode === "live" && run.status === "adjudicating" && run.execution !== "batch") {
      await interruptCaseRun(db, run, "The worker stopped while this run was in progress. Completed findings are kept; a request in flight is counted in full in case it was billed. Resume to continue.");
      return "interrupted";
    }
    const beat = setInterval(() => void db.update(caseRuns).set({ runnerSeenAt: new Date() }).where(and(eq(caseRuns.id, id), eq(caseRuns.runnerId, runnerId))).catch(() => undefined), 5000);
    try {
      return await runClaimed(db, pool, run, deps);
    } finally {
      clearInterval(beat);
    }
  } finally {
    await db.update(caseRuns).set({ runnerId: null }).where(and(eq(caseRuns.id, id), eq(caseRuns.runnerId, runnerId)));
  }
}

async function runClaimed(db: Database, pool: Pool, run: CaseRun, deps: CaseRunDeps): Promise<CaseRunStatus | "polling"> {
  // Already stale: only accounting is left, which reads and writes no evidence, so a correction's hold doesn't wait it.
  if (run.status === "reconciling") return settleStaleBatch(db, run, deps);
  // A case whose evidence is being corrected is not read until the correction ends (evidence/correction.ts).
  if ((await db.select({ id: depositions.id }).from(depositions).where(and(eq(depositions.caseId, run.caseId), sql`${depositions.evidenceHold} is not null`))).length) return "polling";
  // Every result is written through a connection declaring the evidence epochs this run first read
  // (evidence/epoch.ts): a result from a transcript corrected since is refused by the database, never stored.
  const ids = (await db.select({ id: depositions.id }).from(depositions).where(eq(depositions.caseId, run.caseId))).map((d) => d.id);
  const epochs = await jobEpochs(db, "case_runs", run.id, run.sourceEpochs, ids);
  // An economy run whose evidence changed sends and publishes nothing more, but settles what the provider holds.
  if (run.execution === "batch" && Object.entries(await captureEpochs(db, Object.keys(epochs).map(Number))).some(([id, e]) => epochs[id] !== e)) return settleStaleBatch(db, run, deps);
  try {
    return await withEvidenceFence(db, epochs, (fenced) => runFenced(fenced, pool, run, deps));
  } catch (e) {
    if (!isStaleEvidence(e)) throw e;
    if (run.execution === "batch") return settleStaleBatch(db, run, deps);
    await update(db, run.id, { status: "failed", error: STALE_CASE_RUN, finishedAt: new Date() });
    return "failed";
  }
}

// A stale economy run: `reconciling` (not active, so a new run of the case can start) until every provider batch
// it opened has ended and been accounted for (caseRunBatch.ts, reconcileStaleBatchRun), then failed.
async function settleStaleBatch(db: Database, run: CaseRun, deps: CaseRunDeps): Promise<CaseRunStatus | "polling"> {
  if (run.status !== "reconciling") await update(db, run.id, { status: "reconciling", error: STALE_BATCH_RECONCILING });
  const batch = deps.batch?.(run) ?? null;
  if (!batch) {
    // No provider on this server now (economy turned off): nothing can be checked. The run stays reconciling,
    // visibly, and the worker picks it up again on its next start.
    await update(db, run.id, { error: `${STALE_BATCH_RECONCILING} This server can't reach the provider for economy runs now, so its batches will be accounted for when it can.` });
    return "reconciling";
  }
  return reconcileStaleBatchRun(db, { ...run, status: "reconciling" }, batch);
}
export const STALE_CASE_RUN = "A transcript in this case was corrected after this run read it, so its remaining results were not saved. Start a new run on the corrected transcripts.";

async function runFenced(db: Database, pool: Pool, run: CaseRun, deps: CaseRunDeps): Promise<CaseRunStatus | "polling"> {
  let ledger = await ledgerOf(db, run.id);
  if (!ledger) {
    await update(db, run.id, { status: "retrieving", startedAt: run.startedAt ?? new Date(), finishedAt: null, error: null });
    const built = await retrieve(db, pool, run, deps);
    if (typeof built === "string") {
      await update(db, run.id, { status: "failed", error: built, finishedAt: new Date() });
      return "failed";
    }
    ledger = built;
  }
  // A live run sends nothing until someone has seen its estimate and confirmed it with a budget.
  const [fresh] = await db.select({ confirmedAt: caseRuns.confirmedAt }).from(caseRuns).where(eq(caseRuns.id, run.id));
  if (run.mode === "live" && fresh.confirmedAt === null) {
    await update(db, run.id, { status: "awaiting_confirmation", error: null });
    return "awaiting_confirmation";
  }
  if (run.execution === "batch") {
    const batch = deps.batch?.(run) ?? null;
    if (!batch) {
      await update(db, run.id, { status: "blocked_credentials", error: "Paid analysis isn't set up on this server: add the API key to the server's .env (see .env.example) and restart. Nothing was sent.", finishedAt: new Date() });
      return "blocked_credentials";
    }
    if (run.status !== "adjudicating") {
      await update(db, run.id, { status: "adjudicating", startedAt: run.startedAt ?? new Date(), finishedAt: null, error: null });
      await db.update(caseRuns).set({ config: sql`${caseRuns.config} || ${JSON.stringify({ execution: { mode: "batch", ...BATCH_DEFAULTS, ...batch.settings } })}::jsonb` }).where(eq(caseRuns.id, run.id));
    }
    return runBatchTick(db, run, ledger.id, { ...batch, reuse: batch.reuse ?? deps.reuse });
  }
  const model = run.mode === "mock" ? mockCaseModel(MOCK_MODEL, contractOf(run)) : deps.adjudicator(run);
  if (!model) {
    await update(db, run.id, { status: "blocked_credentials", error: "Paid analysis isn't set up on this server: add the API key to the server's .env (see .env.example) and restart. Nothing was sent.", finishedAt: new Date() });
    return "blocked_credentials";
  }
  await update(db, run.id, { status: "adjudicating", startedAt: run.startedAt ?? new Date(), finishedAt: null, error: null });
  await settleAbandoned(db, run, ledger.id); // this runner holds the run: anything in progress was left by a dead one
  const index = (ledger.settings as { itemIndex: ItemIndex }).itemIndex;
  const names = new Map((await db.select({ id: witnesses.id, name: witnesses.name }).from(witnesses).where(eq(witnesses.caseId, run.caseId))).map((w) => [w.id, w.name]));

  const concurrency = Math.max(1, Math.floor(deps.concurrency ?? 1));
  const limiter = deps.limiter ?? new ProviderLimiter(UNLIMITED, deps.sleep ? sleepClock(deps.sleep) : realClock);
  await db.update(caseRuns).set({ config: sql`${caseRuns.config} || ${JSON.stringify({ execution: { packetsPerCase: concurrency, limits: limiter.limits } })}::jsonb` }).where(eq(caseRuns.id, run.id));
  const shared = laneState();
  const halt = deps.signal && deps.drain ? AbortSignal.any([deps.signal, deps.drain]) : (deps.signal ?? deps.drain);
  const ex: Exec = { limiter, shared };

  const lane = async () => {
    while (!shared.stop && !shared.failure) {
      if (halt?.aborted) return void (shared.interrupted = true);
      let slot;
      try {
        slot = await limiter.acquireSlot(caseRunSetOf(run.id), halt);
      } catch (e) {
        if (e instanceof Aborted) continue;
        throw e;
      }
      try {
        if (shared.stop || shared.failure) return;
        const [now] = await db.select({ cancel: caseRuns.cancelRequestedAt }).from(caseRuns).where(eq(caseRuns.id, run.id));
        if (now.cancel) return shared.stopWith("cancelled", "Cancelled. Completed findings are kept; packets not yet read stay pending.");
        const [entry] = await claimNext(db, ledger.id, 1);
        if (!entry) return;
        const outcome = await adjudicateEntry(db, run, ledger.id, entry, index, names, model, deps, ex);
        if (outcome.kind === "halted") shared.interrupted = true;
        else if (outcome.kind === "budget") shared.stopWith("blocked_budget", outcome.message);
        else if (outcome.kind === "failed") {
          if (outcome.fatal) shared.stopWith("failed", outcome.message);
          else if (++shared.failedInARow >= MAX_CONSECUTIVE_FAILED_PACKETS) shared.stopWith("failed", `${shared.failedInARow} packets in a row failed; the last: ${outcome.message}`);
        } else shared.failedInARow = 0;
      } finally {
        slot.release();
      }
    }
  };
  // A lane that throws (database, bug) stops the others from claiming; all of them finish before anything else.
  await Promise.all(Array.from({ length: concurrency }, () => lane().catch((e) => { shared.failure ??= { error: e }; shared.wake(); })));
  if (shared.failure) throw shared.failure.error;
  if (shared.stop?.status === "cancelled") return finish(db, run.id, ledger.id, "cancelled", shared.stop.message);
  if (shared.interrupted || halt?.aborted) {
    await interruptCaseRun(db, run, "The worker shut down. Completed findings are kept. Resume to continue.");
    return "interrupted";
  }
  if (shared.stop) return finish(db, run.id, ledger.id, shared.stop.status, shared.stop.message);
  return finish(db, run.id, ledger.id, null, null);
}

// What the lanes of one run share: the first stop, the first thrown error, the failure streak, and a signal
// that a reservation of this run closed (for a lane waiting on the budget).
function laneState() {
  let waiters: (() => void)[] = [];
  const state = {
    stop: null as { status: CaseRunStatus; message: string } | null,
    failure: null as { error: unknown } | null,
    interrupted: false,
    failedInARow: 0,
    stopWith(status: CaseRunStatus, message: string) {
      state.stop ??= { status, message };
      state.wake();
    },
    wake() {
      const w = waiters;
      waiters = [];
      for (const f of w) f();
    },
    // Resolves when a reservation of this run settles, the run stops, or after `ms` (a re-check of the database).
    settled: (ms: number) => new Promise<void>((ok) => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); ok(); }
      waiters.push(done);
    }),
  };
  return state;
}
type Exec = { limiter: ProviderLimiter; shared: ReturnType<typeof laneState> };

// An injected sleep (tests) moves a virtual clock forward by what it was asked to wait, so a pause expires.
function sleepClock(sleep: (ms: number) => Promise<void>): Clock {
  let skew = 0;
  return { now: () => Date.now() + skew, sleep: async (ms) => { await sleep(ms); skew += ms; } };
}

// Ends the run. With no explicit status, it is completed only when every packet was adjudicated in full.
export async function finish(db: Database, runId: number, ledgerId: number, status: CaseRunStatus | null, error: string | null): Promise<CaseRunStatus> {
  const counts = await db.select({ status: screeningEntries.adjudicationStatus, n: sql<number>`count(*)::int` }).from(screeningEntries).where(eq(screeningEntries.runId, ledgerId)).groupBy(screeningEntries.adjudicationStatus);
  const left = counts.filter((c) => c.status !== "adjudicated").reduce((n, c) => n + c.n, 0);
  const final = status ?? (left === 0 ? "completed" : "incomplete");
  const why = error ?? (left === 0 ? null : `${left} packet${left === 1 ? "" : "s"} not fully adjudicated: ${counts.filter((c) => c.status !== "adjudicated").map((c) => `${c.n} ${c.status}`).join(", ")}. Their unanswered pairs are listed and stay unread.`);
  await update(db, runId, { status: final, error: why, finishedAt: new Date() });
  return final;
}

// Retrieval for the whole case, stored once: candidates for every pool pair, then the ledger. Returns
// an error message when the stored evidence changed since an earlier attempt of this run.
async function retrieve(db: Database, pool: Pool, run: CaseRun, deps: CaseRunDeps) {
  const built = await buildCasePool(db, pool, run.caseId, { minilm: deps.minilm ?? "off", depositionIds: scopeOf(run) ?? undefined });
  if (run.sourceHash && run.sourceHash !== built.sourceHash) return "The case's stored testimony changed since this run started retrieval. Start a new run.";
  await update(db, run.id, { sourceHash: built.sourceHash, config: { ...(run.config as object), retrieval: built.settings, paths: built.paths, documents: built.documents } });
  const set = caseRunSetOf(run.id);
  const byKey = new Map(built.items.map((i) => [i.key, i]));
  // The requests: issue packets (packet-v1; packets past 8 pairs or about 9,000 input tokens are split,
  // retrieve/packetSplit.ts), or whole-stretch requests over every triage-kept pair (stretch-v2). Every pair stays in one.
  const stretch = contractOf(run) === STRETCH_V2_PROMPT_VERSION;
  const limits = deps.packetLimits ?? PACKET_LIMITS;
  const packets = stretch ? buildStretchSet(built.triage.kept, built.items) : splitPacketSet(built.packets, built.items, limits);
  const reasonOf = new Map<string, { status: "selected" | "uncovered" | "deferred"; reason: string | null }>();
  for (const p of (stretch ? packets : built.packets).packets) for (const [a, b] of p.pairs) reasonOf.set(pairKey(a, b), { status: "selected", reason: null });
  for (const u of (stretch ? packets : built.packets).uncovered) reasonOf.set(pairKey(u.a, u.b), { status: "uncovered", reason: `in no ${stretch ? "stretch request" : "issue packet"}: ${u.reason}` });
  for (const d of built.triage.deferred) reasonOf.set(pairKey(d.a, d.b), { status: "deferred", reason: `triage ${d.stage}: ${d.reason}` });
  const rows = built.pool.candidates.map((c, rank) => {
    const x = byKey.get(c.a)!, y = byKey.get(c.b)!;
    const [p, q] = x.depositionId < y.depositionId || (x.depositionId === y.depositionId && x.groupId < y.groupId) ? [x, y] : [y, x];
    const placed = reasonOf.get(pairKey(c.a, c.b));
    if (!placed) throw new Error(`pool pair ${c.a} | ${c.b} is in no packet, uncovered list or triage list`);
    return {
      candidateSet: set, witnessId: p.witnessId, depositionA: p.depositionId, groupA: p.groupId, depositionB: q.depositionId, groupB: q.groupId,
      exchangeA: p.exchangeIds[0], exchangeB: q.exchangeIds[0], sources: Object.entries(c.ranks).filter(([, r]) => r[0] !== null || r[1] !== null).map(([path]) => path),
      rrfScore: c.fused, mergedRank: rank + 1, evidence: { a: p.key, b: q.key, ranks: c.ranks, crossWitness: p.witnessId !== q.witnessId },
      status: placed.status, deferredReason: placed.reason, retrievalVersion: CASE_POOL_VERSION,
    };
  });
  for (let i = 0; i < rows.length; i += 500) await db.insert(candidates).values(rows.slice(i, i + 500)).onConflictDoNothing();
  const stored = await db.select({ id: candidates.id, depositionA: candidates.depositionA, groupA: candidates.groupA, depositionB: candidates.depositionB, groupB: candidates.groupB }).from(candidates).where(eq(candidates.candidateSet, set));
  const idOf = new Map(stored.map((c) => [`${c.depositionA}:${c.groupA}|${c.depositionB}:${c.groupB}`, c.id]));
  const candidateOf = (a: string, b: string) => {
    const x = byKey.get(a)!, y = byKey.get(b)!;
    const [p, q] = x.depositionId < y.depositionId || (x.depositionId === y.depositionId && x.groupId < y.groupId) ? [x, y] : [y, x];
    return idOf.get(`${p.depositionId}:${p.groupId}|${q.depositionId}:${q.groupId}`)!;
  };

  const results = screen(packets, built.pool, built.items, { strategy: SCREENING_OFF, budget: packets.packets.length, consolidate: false });
  const itemIndex: ItemIndex = Object.fromEntries(
    built.items.filter((i) => packets.packets.some((p) => p.items.includes(i.key))).map((i) => [i.key, { document: i.document, session: i.session, groupId: i.groupId, positions: i.positions, sourceHash: i.sourceHash, depositionId: i.depositionId, witnessId: i.witnessId, sessionId: i.sessionId, exchangeIds: i.exchangeIds }]),
  );
  const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
  const ledgerId = await recordScreening(
    db,
    {
      corpus: `case-${run.caseId}`, packetSetName: packets.name, packetSetSha256: hash(packets), poolSha256: hash(built.pool), itemsSha256: built.sourceHash,
      strategy: SCREENING_OFF, strategyVersion: results[0]?.strategyVersion ?? "screen-v1", budget: packets.packets.length,
      settings: { screening: "off: every packet prioritized, baseline order", contract: contractOf(run), ...(stretch ? { stretches: packets.settings } : {}), split: limits, splitFrom: Object.fromEntries(packets.packets.filter((p) => p.splitFrom).map((p) => [p.id, p.splitFrom])), oversize: packets.packets.filter((p) => p.oversize).map((p) => p.id), itemIndex }, poolPairs: built.triage.kept.length, uncovered: built.packets.uncovered,
      caseId: run.caseId, caseRunId: run.id, sourceHash: built.sourceHash,
    },
    results,
  );
  for (const p of packets.packets) {
    const items = p.items.map((k) => byKey.get(k)!);
    await db
      .update(screeningEntries)
      .set({
        candidateIds: p.pairs.map(([a, b]) => candidateOf(a, b)), exchangeIds: [...new Set(items.flatMap((i) => i.exchangeIds))],
        documentIds: [...new Set(items.map((i) => i.depositionId))], sessionIds: [...new Set(items.map((i) => i.sessionId))],
      })
      .where(and(eq(screeningEntries.runId, ledgerId), eq(screeningEntries.packetId, p.id)));
  }
  // The estimate a person confirms before a live run: projected from the packets' size and the Milestone 2
  // calibration's measured output per pair, plus the largest packet's worst case, held while it is in flight.
  const sizedOf = (ps: typeof packets.packets) => ps.map((p) => ({ passageTokens: p.inputTokens - INSTRUCTION_TOKENS, pairs: p.pairs.length }));
  const sized = sizedOf(packets.packets);
  const assumptions = stretch ? STRETCH_COST_ASSUMPTIONS : COST_ASSUMPTIONS;
  const expectedUsd = projectCost(sized, true, assumptions);
  const largest = packets.packets.reduce((m, p) => Math.max(m, maxRequestCost(PACKET_MODEL, { inputTokens: inputTokenBound(p.inputTokens * 4), maxOutputTokens: maxOutputTokensFor(p.pairs.length) })), 0);
  // Economy (the Message Batches API): the same projection at batch prices. Cache hits in a batch are best effort,
  // so the range runs from fast mode's caching to none. Every request in a submitted batch holds its worst case
  // until its result is imported, so the recommended limit leaves room for one full batch in flight on top of the
  // no-cache projection; a lower limit still works, with fewer requests in flight at once.
  const worstOf = (p: (typeof packets.packets)[number]) => maxRequestCost(PACKET_MODEL, { inputTokens: inputTokenBound(p.inputTokens * 4), maxOutputTokens: maxOutputTokensFor(p.pairs.length) }) * BATCH_MULTIPLIER;
  const worstTotal = packets.packets.reduce((n, p) => n + worstOf(p), 0);
  const perBatch = packets.packets.length ? (worstTotal / packets.packets.length) * Math.min(BATCH_DEFAULTS.batchSize, packets.packets.length) : 0;
  const economyNoCache = projectCost(sized, false, assumptions) * BATCH_MULTIPLIER;
  const estimate = {
    packets: sized.length, listedPairs: sized.reduce((n, p) => n + p.pairs, 0), splitPackets: packets.packets.filter((p) => p.splitFrom).length, oversizePackets: packets.packets.filter((p) => p.oversize).length,
    expectedUsd: round2(expectedUsd), noCacheUsd: round2(projectCost(sized, false, assumptions)), largestPacketWorstCaseUsd: round2(largest), recommendedBudgetUsd: Math.ceil((expectedUsd + largest) * 100) / 100,
    economy: {
      expectedUsd: round2(expectedUsd * BATCH_MULTIPLIER), noCacheUsd: round2(economyNoCache), worstCaseUsd: round2(worstTotal), worstCasePerBatchUsd: round2(perBatch),
      recommendedBudgetUsd: Math.ceil((economyNoCache + perBatch) * 100) / 100, batchSize: BATCH_DEFAULTS.batchSize, discount: BATCH_MULTIPLIER,
    },
    contract: contractOf(run), assumptions, note: (stretch ? "Experimental whole-stretch requests (stretch-v2): output per pair measured on a 49-request pilot chosen around known evidence. " : "") + "A projection from packet size and measured output per pair, not a measurement. The limit is enforced by Veridict (each request reserves its worst case before it is sent), not by the provider.",
    reuse: await reuseEstimate(db, run, ledgerId, itemIndex, deps, (ids) => projectCost(sizedOf(packets.packets.filter((p) => ids.has(p.id))), true, assumptions)),
  };
  await db.update(caseRuns).set({ progress: sql`${caseRuns.progress} || ${JSON.stringify({ estimate })}::jsonb`, updatedAt: new Date() }).where(eq(caseRuns.id, run.id));
  return (await ledgerOf(db, run.id))!;
}
const round2 = (x: number) => Math.round(x * 100) / 100;

// Exact-request reuse in the estimate: every planned request rendered as the run will first send it, and looked up
// with the run's own rule (same case, same fingerprint and evidence key, same model). An expectation, not a
// guarantee: a source can stop qualifying before the run sends (a correction changes the evidence key), and then
// that request is sent and paid within the limit. The recommended limit is unchanged: it covers the whole run as if
// nothing were reused. `checked` is false when reuse doesn't apply (a test run, or reuse off on this server).
async function reuseEstimate(db: Database, run: CaseRun, ledgerId: number, index: ItemIndex, deps: CaseRunDeps, projected: (packetIds: Set<string>) => number) {
  const none = (checked: boolean) => ({ checked, reusableRequests: 0, expectedAvoidedUsd: 0, economy: { expectedAvoidedUsd: 0 } });
  if (run.mode !== "live" || deps.reuse !== true) return none(false);
  if (!(await caseHasSources(db, run.caseId))) return none(true);
  const stretch = contractOf(run) === STRETCH_V2_PROMPT_VERSION;
  const names = new Map((await db.select({ id: witnesses.id, name: witnesses.name }).from(witnesses).where(eq(witnesses.caseId, run.caseId))).map((w) => [w.id, w.name]));
  const reusable = new Set<string>();
  for (const entry of await db.select().from(screeningEntries).where(eq(screeningEntries.runId, ledgerId))) {
    const ctx = await entryContext(db, entry, index, names, { allItems: stretch });
    if (typeof ctx === "string") continue;
    const built = buildIssuePacket({ id: entry.packetId, issue: "", items: ctx.keys, pairs: ctx.ids.map((c) => ctx.pairOfCandidate.get(c)!), inputTokens: 0 }, ctx.passages, { allItems: stretch });
    if (!built.packet || built.unbuilt.length) continue;
    const keys = await requestKeys(db, contractOf(run), built.packet, { model: PACKET_MODEL, effort: PACKET_EFFORT });
    if (await findReusable(db, run.caseId, keys, PACKET_MODEL)) reusable.add(entry.packetId);
  }
  const avoided = projected(reusable);
  return { checked: true, reusableRequests: reusable.size, expectedAvoidedUsd: round2(avoided), economy: { expectedAvoidedUsd: round2(avoided * BATCH_MULTIPLIER) } };
}


type EntryOutcome = { kind: "done" | "incomplete" | "halted" } | { kind: "budget"; message: string } | { kind: "failed"; message: string; fatal?: boolean };
export type Entry = typeof screeningEntries.$inferSelect;

// One packet, both execution modes: entryContext rebuilds its passages from stored lines, nextStep decides what it
// needs from the stored rows (nothing, a stored reply to parse, or a request), and applyReply parses, verifies and
// persists a reply. Standard mode sends the request itself (callModel); batch mode (caseRunBatch.ts) submits it
// in a provider batch and comes back with the reply. Either way the same reply gives the same verdicts and findings.
export type EntryContext = { ids: number[]; candidateOfPair: Map<string, number>; pairOfCandidate: Map<number, [string, string]>; keys: string[]; passages: Awaited<ReturnType<typeof resolvePassages>>["passages"]; unresolved: Awaited<ReturnType<typeof resolvePassages>>["unresolved"] };
export type EntryStep =
  | { kind: "done" }
  | { kind: "stored"; packet: IssuePacket; sentIds: number[]; text: string | null; callId: number | null; requestId: number }
  | { kind: "send"; packet: IssuePacket; sentIds: number[]; remaining: number[] };

// allItems: every item of the entry (all its exchanges), not only its pairs' ends: a whole-stretch request shows
// the unpaired exchanges between its pairs too.
export async function entryContext(db: Database, entry: Entry, index: ItemIndex, names: Map<number, string>, { allItems = false }: { allItems?: boolean } = {}): Promise<EntryContext | string> {
  const ids = entry.candidateIds ?? [];
  if (ids.length !== entry.pairs.length) return `the entry lists ${entry.pairs.length} pairs and ${ids.length} candidates`;
  // Passages from stored lines; an item whose stored lines changed or vanished is left out, its pairs excluded.
  const paired = [...new Set(entry.pairs.flat())];
  const held = new Set(entry.exchangeIds ?? []);
  const keys = allItems ? [...new Set([...paired, ...Object.keys(index).filter((k) => index[k].exchangeIds.some((x) => held.has(x)))])] : paired;
  const items: FrozenItem[] = keys.map((k) => ({ key: k, ...index[k], witness: names.get(index[k].witnessId) ?? "", question: "", answer: "", context: "" }));
  const { passages, unresolved } = await resolvePassages(db, items, new Map(keys.map((k) => [index[k].document, index[k].depositionId])));
  return { ids, candidateOfPair: new Map(entry.pairs.map(([a, b], i) => [pairKey(a, b), ids[i]])), pairOfCandidate: new Map(entry.pairs.map((p, i) => [ids[i], p])), keys, passages, unresolved };
}

// `at.entry` is updated when a stored reply pointer is cleared, so the caller always holds the current row.
// `pending`: a reply held in memory instead of stored (a mock batch result, which has no llm_calls row), parsed
// exactly like a stored one.
export async function nextStep(db: Database, run: CaseRun, at: { entry: Entry }, ctx: EntryContext, pending?: { candidateIds: number[]; text: string | null; requestId: number }): Promise<EntryStep> {
  const { ids, candidateOfPair, pairOfCandidate, keys, passages, unresolved } = ctx;
  for (;;) {
    const entry = at.entry;
    // One query per round: which of the packet's candidates already have a verdict, and which were excluded.
    const states = await db
      .select({ id: candidates.id, status: candidates.status, answered: sql<boolean>`exists (select 1 from verdicts v where v.candidate_id = "candidates"."id")` }) // qualified by hand: Drizzle renders bare column names inside a select list
      .from(candidates)
      .where(and(inArray(candidates.id, ids), eq(candidates.candidateSet, caseRunSetOf(run.id))));
    const settled = new Set(states.filter((c) => c.answered || c.status === "excluded").map((c) => c.id));
    const remaining = ids.filter((c) => !settled.has(c));

    // A stored reply not yet turned into verdicts (the run stopped after paying for it): parse that.
    const stored = pending ?? (entry.llmCallId !== null && entry.requestId !== null ? await storedReply(db, entry.requestId, entry.llmCallId) : null);
    if (remaining.length === 0 && !stored) {
      await db.update(screeningEntries).set({ adjudicationStatus: "adjudicated", adjudicationRef: caseRunSetOf(run.id), unresolvedPairs: null, updatedAt: sql`now()` }).where(eq(screeningEntries.id, entry.id));
      return { kind: "done" };
    }
    const sendIds = stored ? stored.candidateIds : remaining;
    const built = buildIssuePacket({ id: entry.packetId, issue: "", items: keys, pairs: sendIds.map((c) => pairOfCandidate.get(c)!), inputTokens: 0 }, passages, { allItems: contractOf(run) === STRETCH_V2_PROMPT_VERSION });
    const unbuilt = built.unbuilt.map((u) => ({ ...u, candidateId: candidateOfPair.get(pairKey(u.a, u.b))! }));
    if (unbuilt.length) {
      const why = (u: (typeof unbuilt)[number]) => `evidence could not be rebuilt from stored lines: ${u.reason}${unresolved.find((x) => u.reason.endsWith(x.key)) ? ` (${unresolved.find((x) => u.reason.endsWith(x.key))!.reason})` : ""}`;
      for (const u of unbuilt) await db.update(candidates).set({ status: "excluded", exclusionReason: why(u) }).where(eq(candidates.id, u.candidateId));
      if (stored && !pending) await db.update(screeningEntries).set({ llmCallId: null }).where(eq(screeningEntries.id, entry.id));
      pending = undefined;
      at.entry = { ...entry, llmCallId: null };
      continue;
    }
    const packet = built.packet!;
    const sentIds = packet.pairs.map((_, i) => sendIds[i]);
    if (pending) return { kind: "stored", packet, sentIds, text: pending.text, callId: null, requestId: pending.requestId };
    if (stored) return { kind: "stored", packet, sentIds, text: stored.text, callId: entry.llmCallId, requestId: entry.requestId! };
    return { kind: "send", packet, sentIds, remaining };
  }
}

// Pairs still without a verdict after the packet and its recovery request: the entry ends incomplete, each pair
// listed and unread (its candidate stays `selected`), never compatible.
export async function markIncomplete(db: Database, entry: Entry, remaining: number[], ctx: EntryContext) {
  const unresolvedPairs = remaining.map((c) => { const [a, b] = ctx.pairOfCandidate.get(c)!; return { a, b, status: "unanswered after the packet and one recovery request" }; });
  await db.update(screeningEntries).set({ adjudicationStatus: "incomplete", unresolvedPairs, adjudicationNote: `${remaining.length} of ${ctx.ids.length} pairs left without a verdict`, updatedAt: sql`now()` }).where(eq(screeningEntries.id, entry.id));
}

// The reply text, parsed leniently, checked against the packet by code, and persisted. Returns the entry as it is after.
export async function applyReply(db: Database, run: CaseRun, entry: Entry, packet: IssuePacket, sentIds: number[], reply: { text: string | null; callId: number | null; requestId: number }, model: Pick<CasePacketModel, "model" | "promptVersion" | "effort">): Promise<Entry> {
  const meta = { model: model.model, promptVersion: model.promptVersion, effort: model.effort, callId: run.mode === "live" ? reply.callId : null, requestId: reply.requestId };
  if (contractOf(run) === STRETCH_V2_PROMPT_VERSION) {
    await persistStretch(db, run, entry, packet, sentIds, readStretchReply(packet, reply.text), meta);
    return { ...entry, llmCallId: null, requestId: reply.requestId };
  }
  const parsed = parseVerdictsLenient(reply.text, VERDICT_SCHEMAS["packet-v1"]);
  const verification = verifyPacketReply(packet, parsed);
  await persist(db, run, entry, packet, sentIds, verification, meta);
  return { ...entry, llmCallId: null, requestId: reply.requestId };
}

async function adjudicateEntry(db: Database, run: CaseRun, ledgerId: number, entry: Entry, index: ItemIndex, names: Map<number, string>, model: CasePacketModel, deps: CaseRunDeps, ex: Exec): Promise<EntryOutcome> {
  const ctx = await entryContext(db, entry, index, names, { allItems: contractOf(run) === STRETCH_V2_PROMPT_VERSION });
  if (typeof ctx === "string") return fail(db, ledgerId, entry, ctx, false);
  const at = { entry };
  const replies = { made: 0 };
  for (;;) {
    const step = await nextStep(db, run, at, ctx);
    if (step.kind === "done") return { kind: "done" };
    let reply: { text: string | null; callId: number | null; requestId: number };
    if (step.kind === "stored") reply = step;
    else {
      if (replies.made >= 1 + MAX_RECOVERY_ROUNDS) {
        await markIncomplete(db, at.entry, step.remaining, ctx);
        return { kind: "incomplete" };
      }
      // Exact-request reuse: the same provider-visible request, from the same evidence, already answered in a live
      // run of this case. Its recorded response is parsed again below instead of paying for a new one.
      const keys = await requestKeys(db, contractOf(run), step.packet, model);
      const source = reuseApplies(run, deps.reuse) ? await findReusable(db, run.caseId, keys, model.model) : null;
      if (source) {
        const hit = await recordReuse(db, run, at.entry.id, step.packet, step.sentIds, model, source, keys, { round: replies.made + 1, strategy: "packet", estimatedInputTokens: inputTokenBound(requestChars(step.packet, contractOf(run))), maxOutputTokens: maxOutputTokensFor(step.packet.pairs.length) });
        replies.made++;
        reply = hit.reply;
        deps.faults?.afterReuseRecorded?.(at.entry.packetId);
        at.entry = await applyReply(db, run, at.entry, step.packet, step.sentIds, reply, model);
        continue;
      }
      const call = await callModel(db, run, at.entry, step.packet, step.sentIds, model, deps, ex, keys);
      if (call.kind === "halted") return call; // nothing sent: the interrupt returns the packet to the queue
      if (call.kind !== "reply") return call.kind === "budget" ? releaseForBudget(db, at.entry, call.message) : fail(db, ledgerId, at.entry, call.message, call.billable, call.fatal);
      replies.made++;
      reply = call;
      await db.update(screeningEntries).set({ attempts: sql`${screeningEntries.attempts} + 1`, requestId: call.requestId, llmCallId: call.callId, updatedAt: sql`now()` }).where(eq(screeningEntries.id, at.entry.id));
      deps.faults?.afterReplyRecorded?.(at.entry.packetId);
    }
    at.entry = await applyReply(db, run, at.entry, step.packet, step.sentIds, reply, model);
  }
}

async function storedReply(db: Database, requestId: number, llmCallId: number) {
  const [req] = await db.select({ candidateIds: adjudicationRequests.candidateIds }).from(adjudicationRequests).where(eq(adjudicationRequests.id, requestId));
  const [call] = await db.select({ text: llmCalls.rawOutput }).from(llmCalls).where(eq(llmCalls.id, llmCallId));
  return req && call ? { candidateIds: req.candidateIds, text: call.text } : null;
}

// One reply for the packet: wait for the provider limiter, reserve its worst case, send, record, settle. A 429
// or 529 pauses every request in the process for its retry-after (or reset), then this one is retried a bounded
// number of times; any other failure ends the attempt, with whether it may have been billed. A request whose
// outcome is unknown is never sent again here.
async function callModel(db: Database, run: CaseRun, entry: Entry, packet: IssuePacket, sentIds: number[], model: CasePacketModel, deps: CaseRunDeps, { limiter, shared }: Exec, keys: RequestKeys) {
  const live = run.mode === "live";
  const maxOutputTokens = maxOutputTokensFor(packet.pairs.length);
  const chars = requestChars(packet, contractOf(run));
  const inputTokens = inputTokenBound(chars);
  const maxCostUsd = live ? maxRequestCost(PACKET_MODEL, { inputTokens, maxOutputTokens }) : 0;
  const context = { candidateSet: caseRunSetOf(run.id), analysisId: null, strategy: "packet", maxConcurrency: deps.concurrency ?? 1 };
  const estimate = { input: Math.ceil(chars / CHARS_PER_TOKEN), output: maxOutputTokens }; // output: the worst case, refunded after
  for (let tries = 0; ; tries++) {
    let ticket;
    try {
      ticket = await limiter.beforeSend(estimate, deps.signal && deps.drain ? AbortSignal.any([deps.signal, deps.drain]) : (deps.signal ?? deps.drain));
    } catch (e) {
      if (e instanceof Aborted) return { kind: "halted" as const };
      throw e;
    }
    let reservationId: number | null = null;
    if (live) {
      for (;;) {
        try {
          reservationId = await reserve(db, run.budgetId!, maxCostUsd, `${caseRunSetOf(run.id)} ${entry.packetId}`);
          break;
        } catch (e) {
          if (!(e instanceof BudgetExceeded)) throw e;
          // Other requests of this run hold reservations: wait for one to settle and try again.
          const [{ held }] = await db.select({ held: sql<boolean>`${budgets.reservedUsd} > 0` }).from(budgets).where(eq(budgets.id, run.budgetId!));
          if (held && !shared.stop && !shared.failure) {
            await shared.settled(1000);
            continue;
          }
          return { kind: "budget" as const, message: `Stopped before packet ${entry.packetId}: its worst case ($${maxCostUsd.toFixed(4)}) is more than the budget has left. Completed findings are kept; raise the budget and resume to continue.` };
        }
      }
    }
    const requestId = await openRequest(db, context, { candidateIds: sentIds, model: model.model, promptVersion: model.promptVersion, estimatedInputTokens: inputTokens, maxOutputTokens, maxCostUsd, reservationId });
    await storeKeys(db, requestId, keys); // so an identical later request can reuse this one's response once it completes
    deps.faults?.afterRequestSent?.(entry.packetId);
    try {
      const reply = await model.adjudicate(packet, { signal: deps.signal });
      limiter.afterReply(ticket, reply.usage);
      // The reply is paid for: record it with its raw text before anything that could fail.
      let callId: number | null = null;
      if (live) {
        const call = await recordCall(db, { jobId: null, stage: "adjudication", model: reply.model, usage: reply.usage, attempt: tries + 1, items: packet.pairs.length, rawOutput: reply.text, effort: model.effort, latencyMs: reply.latencyMs });
        await settle(db, reservationId!, { id: call.id, costUsd: call.costUsd });
        shared.wake();
        callId = call.id;
      }
      await closeRequest(db, requestId, { status: reply.stopReason === "max_tokens" ? "partial" : "completed", llmCallId: callId, providerRequestId: reply.requestId ?? null, latencyMs: reply.latencyMs, errorKind: reply.stopReason === "max_tokens" ? "cut_off" : reply.stopReason === "refusal" ? "refused" : null });
      return { kind: "reply" as const, text: reply.text, callId, requestId };
    } catch (e) {
      const f = classifyFailure(e);
      limiter.afterFailure(ticket, f.billable);
      if (reservationId !== null) {
        await closeFailed(db, reservationId, e);
        shared.wake();
      }
      await closeRequest(db, requestId, { status: f.status, errorKind: f.kind, error: (e instanceof Error ? e.message : String(e)).slice(0, 2000), retryAfterMs: f.retryAfterMs });
      if (f.status === "rate_limited") limiter.pause(f.retryAfterMs ?? 5_000);
      if (f.status === "rate_limited" && tries < MAX_RATE_LIMIT_RETRIES) continue;
      return { kind: "failed" as const, message: `${f.kind}: ${e instanceof Error ? e.message : String(e)}`, billable: live && f.billable, fatal: f.kind === "spend_limit" };
    }
  }
}

async function releaseForBudget(db: Database, entry: Entry, message: string): Promise<EntryOutcome> {
  await db.update(screeningEntries).set({ adjudicationStatus: "not_started", adjudicationNote: "returned to the queue: budget", updatedAt: sql`now()` }).where(eq(screeningEntries.id, entry.id));
  return { kind: "budget", message };
}

async function fail(db: Database, ledgerId: number, entry: Entry, message: string, billable: boolean, fatal = false): Promise<EntryOutcome> {
  await markFailed(db, ledgerId, entry.packetId, message.slice(0, 2000));
  await db.update(screeningEntries).set({ failureBillable: billable }).where(eq(screeningEntries.id, entry.id));
  return { kind: "failed", message, fatal };
}

// Verdicts and findings for the answered pairs, in one transaction with clearing the stored-reply pointer.
// A candidate that already has a verdict is skipped: nothing is written twice. A packet's statements are batched:
// its candidates locked together (in id order, so concurrent transactions can't deadlock), then one existence check,
// one insert of verdicts, one of findings, and one status update, however many pairs it holds.
type PersistMeta = { model: string; promptVersion: string; effort: string; callId: number | null; requestId: number; contract?: CaseRunContract; stretch?: Map<string, Record<string, unknown>> };
// plain: pairs read with no finding (a whole-stretch reply's no_conflict_identified and unclear), stored as a verdict
// recording that status and no finding, in the same transaction as the rest of the reply.
async function persist(db: Database, run: CaseRun, entry: Entry, packet: IssuePacket, sentIds: number[], v: ReturnType<typeof verifyPacketReply>, meta: PersistMeta, plain: { pairId: string; parsed: Record<string, unknown> }[] = []) {
  await db.transaction(async (tx) => {
    if (plain.length) {
      const rows = plain.map((x) => ({ ...x, i: packet.pairs.findIndex((pr) => pr.pairId === x.pairId) })).filter((x) => x.i >= 0);
      const ids = rows.map((x) => sentIds[x.i]);
      const locked = new Set((await tx.select({ id: candidates.id }).from(candidates).where(inArray(candidates.id, ids)).orderBy(asc(candidates.id)).for("update")).map((r) => r.id));
      const has = new Set((await tx.select({ id: verdicts.candidateId }).from(verdicts).where(inArray(verdicts.candidateId, ids))).map((r) => r.id));
      const todo = rows.filter((x) => locked.has(sentIds[x.i]) && !has.has(sentIds[x.i]));
      if (todo.length) {
        await tx.insert(verdicts).values(todo.map((x) => {
          const pair = packet.pairs[x.i];
          const sides = [pair.a, pair.b].map((pid) => { const q = packet.passages.find((y) => y.id === pid)!; return { id: q.id, key: q.key, depositionId: q.depositionId, groupId: q.groupId, lineIds: q.lines.map((l) => l.id) }; });
          return {
            candidateId: sentIds[x.i], model: meta.model, promptVersion: meta.promptVersion, effort: meta.effort, status: "valid" as const, raw: JSON.stringify(x.parsed), parsed: x.parsed, consistencyIssues: [],
            packet: { contract: meta.contract ?? PACKET_PROMPT_VERSION, packetId: entry.packetId, pairId: pair.pairId, sides, ...(meta.stretch?.get(pair.pairId) ?? {}) },
            origin: meta.callId !== null ? ("model" as const) : ("fixture" as const), llmCallId: meta.callId, requestId: meta.requestId,
          };
        }));
        await tx.update(candidates).set({ status: "adjudicated" }).where(inArray(candidates.id, todo.map((x) => sentIds[x.i])));
      }
    }
    const answered = packet.pairs.flatMap((pair, i) => {
      const pv = v.pairs.find((p) => p.pairId === pair.pairId);
      return pv && pv.status === "answered" && pv.verdict ? [{ pair, pv, candidateId: sentIds[i] }] : [];
    });
    const ids = answered.map((a) => a.candidateId);
    if (ids.length) {
      const locked = new Set((await tx.select({ id: candidates.id }).from(candidates).where(inArray(candidates.id, ids)).orderBy(asc(candidates.id)).for("update")).map((r) => r.id));
      const has = new Set((await tx.select({ id: verdicts.candidateId }).from(verdicts).where(inArray(verdicts.candidateId, ids))).map((r) => r.id));
      const todo = answered.filter((a) => locked.has(a.candidateId) && !has.has(a.candidateId));
      if (todo.length) {
        const written = await tx
          .insert(verdicts)
          .values(todo.map(({ pair, pv, candidateId }) => {
            const sides = [pair.a, pair.b].map((pid) => { const p = packet.passages.find((x) => x.id === pid)!; return { id: p.id, key: p.key, depositionId: p.depositionId, groupId: p.groupId, lineIds: p.lines.map((l) => l.id) }; });
            return {
              candidateId, model: meta.model, promptVersion: meta.promptVersion, effort: meta.effort, status: "valid" as const, raw: JSON.stringify(pv.verdict), parsed: pv.verdict,
              consistencyIssues: pv.semantic?.consistencyIssues ?? [], packet: { contract: meta.contract ?? PACKET_PROMPT_VERSION, packetId: entry.packetId, pairId: pair.pairId, sides, ...(meta.stretch?.get(pair.pairId) ?? {}) },
              origin: meta.callId !== null ? "model" : "fixture", llmCallId: meta.callId, requestId: meta.requestId,
            };
          }))
          .returning({ id: verdicts.id, candidateId: verdicts.candidateId });
        const verdictOf = new Map(written.map((w) => [w.candidateId, w.id]));
        const rows = todo.flatMap(({ pv, candidateId }) => {
          const fields = assessPacketPair(packet, pv);
          return fields ? [{
            caseId: run.caseId, candidateId, verdictId: verdictOf.get(candidateId)!, type: fields.type, evidenceStatus: fields.evidenceStatus,
            // A side the packet verifier left unattributed (an abstention without a quote) has no level to show.
            attributionA: fields.attributionA ?? "not_assessed", attributionB: fields.attributionB ?? "not_assessed",
            score: fields.score, band: fields.band, unscoredReason: fields.unscoredReason, factors: fields.factors, caps: fields.caps,
            checks: { ...fields.checks, outcome: fields.outcome, caseRunId: run.id, origin: meta.callId !== null ? "model" : "mock", ...(meta.contract === STRETCH_V2_PROMPT_VERSION ? { contract: STRETCH_V2_PROMPT_VERSION, stretch: meta.stretch?.get(packet.pairs[sentIds.indexOf(candidateId)]?.pairId ?? "") ?? null } : {}) }, rubricVersion: fields.rubricVersion,
            priority: fields.priority, contextRequested: fields.contextRequested,
          }] : [];
        });
        if (rows.length) await tx.insert(findings).values(rows);
        await tx.update(candidates).set({ status: "adjudicated" }).where(inArray(candidates.id, todo.map((t) => t.candidateId)));
      }
    }
    await tx.update(screeningEntries).set({ llmCallId: null, updatedAt: sql`now()` }).where(eq(screeningEntries.id, entry.id));
  });
}

// A whole-stretch reply (adjudicate/stretch.ts): flagged pairs, verified or not, become verdicts and findings through
// packet-v1's persistence and scoring above, with the stretch status, unit and audit notes beside them; pairs read
// with no finding (no_conflict_identified, unclear) get a verdict recording that and no finding, so they are never
// shown as "compatible"; incomplete pairs stay unread for the recovery request. One transaction.
async function persistStretch(db: Database, run: CaseRun, entry: Entry, packet: IssuePacket, sentIds: number[], reading: StretchReading, meta: PersistMeta) {
  const info = new Map(reading.pairs.map((r) => [r.pairId, { stretchStatus: r.status, unitId: r.unitId, related: r.related, modelLedger: r.modelStatus, audit: r.audit }]));
  const flagged = new Set(reading.pairs.filter((r) => (r.status === "flagged" || r.status === "flagged_unverified") && verificationOf(reading, r.pairId)).map((r) => r.pairId));
  const verification = { ...reading.verification, pairs: reading.verification.pairs.filter((x) => flagged.has(x.pairId)) };
  const plain = reading.pairs.filter((r) => r.status === "no_conflict_identified" || r.status === "unclear").map((r) => ({ pairId: r.pairId, parsed: { contract: STRETCH_V2_PROMPT_VERSION, outcome: r.status, related: r.related, modelLedger: r.modelStatus, audit: r.audit } }));
  await persist(db, run, entry, packet, sentIds, verification, { ...meta, contract: STRETCH_V2_PROMPT_VERSION, stretch: info }, plain);
  const notes = [...reading.problems, ...(reading.outsidePairs ? [`${reading.outsidePairs} finding(s) on exchanges that are not an original pair of their unit: kept in the raw reply, not published`] : [])];
  if (notes.length) await db.update(screeningEntries).set({ adjudicationNote: `stretch-v2: ${notes.join("; ")}`.slice(0, 2000), updatedAt: sql`now()` }).where(eq(screeningEntries.id, entry.id));
}

// Creates a run, and a live run's budget. A live run created with `confirmed` (the CLI, after its own plan)
// may spend at once; otherwise it stops after retrieval for confirmCaseRun. The caller queues the job.
// depositionIds: analyze only these depositions of the case (the same pipeline, model and checks); absent = the whole case.
export async function createCaseRun(db: Database, caseId: number, { mode, budgetUsd = 0, confirmed = false, execution = "standard", contract = PACKET_PROMPT_VERSION, depositionIds, fresh = false }: { mode: "live" | "mock"; budgetUsd?: number; confirmed?: boolean; execution?: CaseRunExecution; contract?: CaseRunContract; depositionIds?: number[]; fresh?: boolean }) {
  return db.transaction(async (tx) => {
    const config = { retrievalVersion: CASE_POOL_VERSION, screening: "off", packetLimits: PACKET_LIMITS, contract, ...(depositionIds ? { scope: { depositionIds: [...new Set(depositionIds)].sort((x, y) => x - y) } } : {}), ...(contract === STRETCH_V2_PROMPT_VERSION ? { experimental: "stretch-v2: whole-stretch requests; not validated for accuracy", stretchRender: STRETCH_RENDER_ID } : {}), ...(fresh ? { reuse: "fresh" } : {}), verificationVersion: VERIFICATION_VERSION, rubricVersion: RUBRIC_V1.version, maxRecoveryRounds: MAX_RECOVERY_ROUNDS, maxRateLimitRetries: MAX_RATE_LIMIT_RETRIES };
    const live = mode === "live";
    const [row] = await tx
      .insert(caseRuns)
      .values({ caseId, mode, execution, retentionAcknowledgedAt: live && confirmed && execution === "batch" ? new Date() : null, budgetUsd: live ? budgetUsd : 0, promptVersion: contract, model: live ? PACKET_MODEL : MOCK_MODEL, effort: live ? PACKET_EFFORT : "mock", config, confirmedAt: live && confirmed ? new Date() : null })
      .returning();
    if (live) {
      const [b] = await tx.insert(budgets).values({ name: caseRunSetOf(row.id), limitUsd: budgetUsd }).returning({ id: budgets.id });
      await tx.update(caseRuns).set({ budgetId: b.id }).where(eq(caseRuns.id, row.id));
      return { ...row, budgetId: b.id };
    }
    return row;
  });
}

// A person confirms a live run's estimate with a budget: the only way an unconfirmed run starts spending.
// Economy (execution "batch") also needs the person to acknowledge that the provider keeps batch inputs and results
// for 29 days. The execution mode is fixed here: nothing has been sent yet, and it never changes afterwards.
// fresh: a fresh analysis, which reuses no earlier response (exact-request reuse) and pays for every request.
export async function confirmCaseRun(db: Database, id: number, { budgetUsd, execution = "standard", retentionAcknowledged = false, name, fresh = false }: { budgetUsd: number; execution?: CaseRunExecution; name?: string; retentionAcknowledged?: boolean; fresh?: boolean }): Promise<"queued" | "not_found" | "not_awaiting" | "no_budget" | "no_acknowledgement"> {
  if (!(budgetUsd > 0)) return "no_budget";
  if (execution === "batch" && !retentionAcknowledged) return "no_acknowledgement";
  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(caseRuns).where(eq(caseRuns.id, id)).for("update");
    if (!run) return "not_found" as const;
    if (run.status !== "awaiting_confirmation" || run.mode !== "live") return "not_awaiting" as const;
    await tx.update(budgets).set({ limitUsd: budgetUsd }).where(eq(budgets.id, run.budgetId!));
    // The person's name for the analysis, kept with its settings (no schema change), so they can tell runs apart.
    if (name) await tx.update(caseRuns).set({ config: sql`${caseRuns.config} || ${JSON.stringify({ name })}::jsonb` }).where(eq(caseRuns.id, id));
    await tx.update(caseRuns).set({ budgetUsd, execution, retentionAcknowledgedAt: execution === "batch" ? new Date() : null, confirmedAt: new Date(), status: "queued", error: null, updatedAt: new Date(), config: sql`${caseRuns.config} || ${JSON.stringify({ reuse: fresh ? "fresh" : "automatic" })}::jsonb` }).where(eq(caseRuns.id, id));
    return "queued" as const;
  });
}

// Makes a stopped run continue. Failed packets whose request is known not to have been billed, and incomplete
// packets, go back to the queue (each claim again gets one packet request and one recovery request). A packet
// whose request may have been billed (uncertain) is retried only with retryUncertain. The budget may be raised,
// never lowered.
export async function resumeCaseRun(db: Database, id: number, { budgetUsd, retryUncertain = false }: { budgetUsd?: number; retryUncertain?: boolean } = {}): Promise<"queued" | "not_found" | "lower_budget" | CaseRunStatus> {
  const [run] = await db.select().from(caseRuns).where(eq(caseRuns.id, id));
  if (!run) return "not_found";
  if (!CASE_RUN_RESUMABLE.includes(run.status as CaseRunStatus)) return run.status as CaseRunStatus;
  if (budgetUsd !== undefined) {
    if (budgetUsd < run.budgetUsd) return "lower_budget";
    if (run.budgetId !== null) await db.update(budgets).set({ limitUsd: budgetUsd }).where(eq(budgets.id, run.budgetId));
    await update(db, id, { budgetUsd });
  }
  const ledger = await ledgerOf(db, id);
  if (ledger) {
    await retryFailed(db, ledger.id, { uncertain: retryUncertain });
    await db.update(screeningEntries).set({ adjudicationStatus: "not_started", adjudicationNote: "requeued on resume", updatedAt: sql`now()` }).where(and(eq(screeningEntries.runId, ledger.id), eq(screeningEntries.adjudicationStatus, "incomplete")));
  }
  await update(db, id, { status: "queued", error: null, finishedAt: null, cancelRequestedAt: null });
  return "queued";
}

// Coverage of a run, from candidate and ledger states:
//   complete               every retrieved pair was read and has a verdict
//   processed_with_unread  every packet was adjudicated in full, but retrieval left pairs unread by design
//                          (triage-deferred, in no packet) or their evidence could not be rebuilt (excluded)
//   partial                some packets are not done: pending, incomplete, failed or uncertain
export type CoverageState = "complete" | "processed_with_unread" | "partial";
export function coverageState(c: { pending: number; incomplete: number; deferred: number; uncovered: number; excluded: number }): CoverageState {
  if (c.pending + c.incomplete > 0) return "partial";
  return c.deferred + c.uncovered + c.excluded > 0 ? "processed_with_unread" : "complete";
}

// What a run covered, what it left, and what it cost, from the stored rows only.
export async function caseRunReport(db: Database, id: number) {
  const [run] = await db.select().from(caseRuns).where(eq(caseRuns.id, id));
  if (!run) return null;
  const set = caseRunSetOf(id);
  const ledger = await ledgerOf(db, id);
  // Each candidate once, with its packet's state when it has one.
  // Each entry's candidate IDs unnested first, then a hash join: joining on `= any(array)` compared every candidate
  // with every entry (seconds per call on a full case). A candidate is in at most one entry.
  const rows = await db.execute<{ status: string; entry: string | null; reason: string | null; n: number }>(sql`
    with e as (select unnest(candidate_ids) as candidate_id, adjudication_status from screening_entries where run_id = ${ledger?.id ?? 0})
    select c.status::text as status, e.adjudication_status as entry, split_part(c.deferred_reason, ':', 1) as reason, count(*)::int as n
    from candidates c left join e on e.candidate_id = c.id
    where c.candidate_set = ${set} group by 1, 2, 3`).then((r) => r.rows);
  const sum = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).reduce((n, r) => n + r.n, 0);
  const coverage = {
    total: sum(() => true),
    adjudicated: sum((r) => r.status === "adjudicated"),
    incomplete: sum((r) => r.status === "selected" && (r.entry === "incomplete" || r.entry === "failed")), // read, left without a verdict
    pending: sum((r) => r.status === "selected" && r.entry !== "incomplete" && r.entry !== "failed"), // not read yet
    deferred: sum((r) => r.status === "deferred"),
    uncovered: sum((r) => r.status === "uncovered"),
    excluded: sum((r) => r.status === "excluded"),
    deferredByStage: Object.fromEntries(rows.filter((r) => r.status === "deferred").map((r) => [r.reason ?? "unknown", r.n])),
  };
  const kinds = await db.execute<{ cross: boolean; n: number }>(sql`select (da.witness_id <> db.witness_id) as cross, count(*)::int as n from candidates c join depositions da on da.id = c.deposition_a join depositions db on db.id = c.deposition_b where c.candidate_set = ${set} group by 1`);
  const entries = ledger ? await db.select({ status: screeningEntries.adjudicationStatus, n: sql<number>`count(*)::int`, uncertain: sql<number>`count(*) filter (where ${screeningEntries.failureBillable})::int`, attempts: sql<number>`coalesce(sum(${screeningEntries.attempts}), 0)::int`, stored: sql<number>`count(*) filter (where ${screeningEntries.llmCallId} is not null)::int` }).from(screeningEntries).where(eq(screeningEntries.runId, ledger.id)).groupBy(screeningEntries.adjudicationStatus) : [];
  const unresolved = ledger ? await db.select({ packetId: screeningEntries.packetId, status: screeningEntries.adjudicationStatus, pairs: screeningEntries.unresolvedPairs, note: screeningEntries.adjudicationNote, uncertain: screeningEntries.failureBillable }).from(screeningEntries).where(and(eq(screeningEntries.runId, ledger.id), inArray(screeningEntries.adjudicationStatus, ["incomplete", "failed"]))).orderBy(asc(screeningEntries.rank)) : [];
  // How many of the run's findings a person has decided (Keep, Needs context or Dismiss), for the case's list of analyses.
  const [{ reviewed }] = await db.select({ reviewed: sql<number>`count(*) filter (where ${findings.reviewState} <> 'unreviewed')::int` }).from(findings).innerJoin(candidates, eq(candidates.id, findings.candidateId)).where(eq(candidates.candidateSet, set));
  const lanes = await db.select({ type: findings.type, priority: findings.priority, scored: sql<boolean>`${findings.score} is not null`, n: sql<number>`count(*)::int` }).from(findings).innerJoin(candidates, eq(candidates.id, findings.candidateId)).where(eq(candidates.candidateSet, set)).groupBy(findings.type, findings.priority, sql`${findings.score} is not null`);
  // Requests by what is known about them: answered (a reply was recorded), failed and not billed (rejected,
  // or a released reservation), uncertain (may have been billed: counted in full, never retried automatically).
  // Reused requests (exact-request reuse) were never sent: no call, no reservation, no charge; counted apart, with
  // the estimated cost they avoided, never in the actual cost.
  const [req] = await db.execute<{ requests: number; answered: number; unbilled: number; uncertain: number; open: number; calls: number; cost: string | null; input: number; output: number; reused: number; avoided: string | null }>(sql`
    select count(*)::int as requests,
      count(*) filter (where r.status in ('completed', 'partial'))::int as answered,
      count(*) filter (where r.status not in ('completed', 'partial', 'sent', 'reused') and (b.status is null or b.status = 'released') and coalesce(r.error_kind, '') <> 'uncertain')::int as unbilled,
      count(*) filter (where r.status not in ('completed', 'partial', 'sent', 'reused') and (b.status = 'uncertain' or r.error_kind = 'uncertain'))::int as uncertain,
      count(*) filter (where r.status = 'reused')::int as reused, sum(r.avoided_cost_usd) filter (where r.status = 'reused')::text as avoided,
      count(*) filter (where r.status = 'sent')::int as open,
      count(l.id)::int as calls, sum(l.cost_usd)::text as cost,
      coalesce(sum(l.input_tokens + l.cache_write_5m_tokens + l.cache_write_1h_tokens + l.cache_read_tokens), 0)::int as input, coalesce(sum(l.output_tokens), 0)::int as output
    from adjudication_requests r left join llm_calls l on l.id = r.llm_call_id left join budget_reservations b on b.id = r.reservation_id
    where r.candidate_set = ${set}`).then((r) => r.rows);
  const budget = run.budgetId ? await db.execute<{ limit_usd: string; spent_usd: string; reserved_usd: string }>(sql`select limit_usd, spent_usd, reserved_usd from budgets where id = ${run.budgetId}`).then((r) => r.rows[0]) : null;
  // Economy runs: their provider batches by state, and their requests by what the provider said.
  const batchRows = run.execution === "batch" ? await db.execute<{ status: string; n: number; requests: number; oldest_open: string | null; results_expire: string | null }>(sql`
    select status, count(*)::int as n, coalesce(sum(request_count), 0)::int as requests,
      min(submitted_at) filter (where status in ('submitted', 'canceling'))::text as oldest_open,
      min(provider_created_at + interval '29 days') filter (where status = 'ended')::text as results_expire
    from case_run_batches where case_run_id = ${run.id} group by status`).then((r) => r.rows) : [];
  const batchRequests = run.execution === "batch" ? await db.execute<{ kind: string; n: number }>(sql`
    select case when r.status = 'sent' then 'processing' when r.status in ('completed', 'partial') then 'succeeded' else coalesce(r.error_kind, r.status::text) end as kind, count(*)::int as n
    from adjudication_requests r join case_run_batches b on b.id = r.case_run_batch_id where b.case_run_id = ${run.id} group by 1`).then((r) => r.rows) : [];
  const batchCount = (...st: string[]) => batchRows.filter((b) => st.includes(b.status)).reduce((n, b) => n + b.n, 0);
  const batches = run.execution === "batch" ? {
    total: batchRows.reduce((n, b) => n + b.n, 0), submitting: batchCount("submitting"), processing: batchCount("submitted", "canceling"), awaitingImport: batchCount("ended"), imported: batchCount("imported"),
    notSubmitted: batchCount("not_submitted"), unknown: batchCount("submission_unknown"),
    oldestOpenSince: batchRows.map((b) => b.oldest_open).filter((x) => x !== null).sort()[0] ?? null,
    resultsExpireAt: batchRows.map((b) => b.results_expire).filter((x) => x !== null).sort()[0] ?? null,
    requests: Object.fromEntries(batchRequests.map((r) => [r.kind, r.n])) as Record<string, number>,
  } : null;
  const ledgerCount = (s: string) => entries.find((r) => r.status === s)?.n ?? 0;
  const uncertainPackets = entries.reduce((n, r) => n + r.uncertain, 0);
  const state = coverageState(coverage);
  const reasons = [
    ...(run.status !== "completed" ? [`run ${run.status}${run.error ? `: ${run.error}` : ""}`] : []),
    ...(coverage.pending ? [`${coverage.pending} pairs not read yet`] : []),
    ...(coverage.incomplete ? [`${coverage.incomplete} pairs read but left without a verdict (incomplete or failed packets)`] : []),
    ...(uncertainPackets ? [`${uncertainPackets} packets failed with a request that may have been billed; retried only on request`] : []),
    ...(batches?.unknown ? [`${batches.unknown} provider batches could not be confirmed after a crash during submission; their requests are counted as billed`] : []),
    ...(coverage.deferred ? [`${coverage.deferred} pairs deferred by retrieval triage, unread (${Object.entries(coverage.deferredByStage).map(([k, v]) => `${v} ${k}`).join(", ")})`] : []),
    ...(coverage.uncovered ? [`${coverage.uncovered} pairs in no packet, unread`] : []),
    ...(coverage.excluded ? [`${coverage.excluded} pairs whose evidence could not be rebuilt from stored lines`] : []),
  ];
  // Whole-stretch runs (experimental): every read pair's status, from the verdicts. no_conflict_identified and unclear
  // pairs have no finding; they are read, not cleared.
  const stretchRows = contractOf(run) === STRETCH_V2_PROMPT_VERSION ? await db.execute<{ status: string; n: number; related: number }>(sql`
    select coalesce(v.packet->>'stretchStatus', v.parsed->>'outcome') as status, count(*)::int as n, count(*) filter (where v.packet->>'related' = 'true')::int as related
    from verdicts v join candidates c on c.id = v.candidate_id where c.candidate_set = ${set} group by 1`).then((r) => r.rows) : [];
  const stretch = contractOf(run) === STRETCH_V2_PROMPT_VERSION ? {
    ...Object.fromEntries(["flagged", "flagged_unverified", "unclear", "no_conflict_identified"].map((k) => [k, stretchRows.find((r) => r.status === k)?.n ?? 0])),
    related: stretchRows.reduce((n, r) => n + r.related, 0),
    note: "Experimental whole-stretch reading. Pairs with no conflict identified were read, not cleared; unclear pairs need a person.",
  } as { flagged: number; flagged_unverified: number; unclear: number; no_conflict_identified: number; related: number; note: string } : null;
  return {
    id: run.id, caseId: run.caseId, status: run.status as CaseRunStatus, mode: run.mode as "live" | "mock", execution: run.execution as CaseRunExecution, contract: contractOf(run), scope: scopeOf(run) ? { kind: "depositions" as const, depositionIds: scopeOf(run)! } : { kind: "case" as const }, stretch, retentionAcknowledgedAt: run.retentionAcknowledgedAt, batches, error: run.error, model: run.model, promptVersion: run.promptVersion, effort: run.effort,
    config: run.config, sourceHash: run.sourceHash, createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt, updatedAt: run.updatedAt,
    name: (run.config as { name?: string }).name ?? null, confirmedAt: run.confirmedAt, cancelRequested: run.cancelRequestedAt !== null,
    estimate: (run.progress as { estimate?: unknown }).estimate ?? null,
    // Deferred, uncovered and unanswered pairs are unread, never compatible.
    coverageState: state,
    complete: state === "complete" && run.status === "completed",
    incompleteReasons: reasons,
    candidates: { ...coverage, sameWitness: kinds.rows.find((k) => !k.cross)?.n ?? 0, crossWitness: kinds.rows.find((k) => k.cross)?.n ?? 0 },
    packets: {
      total: entries.reduce((n, r) => n + r.n, 0), adjudicated: ledgerCount("adjudicated"), incomplete: ledgerCount("incomplete"), failed: ledgerCount("failed"), notStarted: ledgerCount("not_started"), inProgress: ledgerCount("in_progress"),
      uncertain: uncertainPackets, retryable: ledgerCount("failed") - uncertainPackets + ledgerCount("incomplete"), storedRepliesNotParsed: entries.reduce((n, r) => n + r.stored, 0), modelReplies: entries.reduce((n, r) => n + r.attempts, 0),
    },
    unresolved,
    findings: lanes, reviewed,
    requests: { total: req.requests, answered: req.answered, failedNotBilled: req.unbilled, uncertain: req.uncertain, open: req.open, reused: req.reused },
    cost: {
      recordedCalls: req.calls, costUsd: req.cost === null ? 0 : Number(req.cost), inputTokens: req.input, outputTokens: req.output, budget: budget ? { limitUsd: Number(budget.limit_usd), spentUsd: Number(budget.spent_usd), reservedUsd: Number(budget.reserved_usd) } : null,
      // An estimate: each reused request's source call cost, in this run's mode. Not a charge, not a refund.
      reuse: { requests: req.reused, avoidedUsdEstimate: req.avoided === null ? 0 : Math.round(Number(req.avoided) * 1e4) / 1e4, fresh: freshOf(run) },
    },
  };
}
export type CaseRunReport = NonNullable<Awaited<ReturnType<typeof caseRunReport>>>;

// The run's findings, each side with its deposition, witness and stored lines at page:line. Every quotation
// shown is a stored transcript line; the model's verdict is kept apart under `model`.
export async function caseRunFindings(db: Database, id: number) {
  const rows = await db
    .select({ f: findings, v: verdicts, c: candidates })
    .from(findings)
    .innerJoin(verdicts, eq(verdicts.id, findings.verdictId))
    .innerJoin(candidates, eq(candidates.id, findings.candidateId))
    .where(eq(candidates.candidateSet, caseRunSetOf(id)))
    .orderBy(asc(candidates.mergedRank), asc(findings.id)); // retrieval order: the same whatever order packets finished in
  const lineIds = [...new Set(rows.flatMap((r) => (r.v.packet as { sides: { lineIds: number[] }[] }).sides.flatMap((s) => s.lineIds)))];
  const stored = lineIds.length ? await db.execute<{ id: number; deposition_id: number; printed_page: number; line_no: number; raw_text: string }>(sql`select id, deposition_id, printed_page, line_no, raw_text from lines where id in (${sql.join(lineIds.map((x) => sql`${x}`), sql`, `)})`).then((r) => new Map(r.rows.map((l) => [Number(l.id), l]))) : new Map();
  const people = await db.execute<{ id: number; witness: string; witness_id: number; taken_on: string | null }>(sql`select d.id, w.name as witness, w.id as witness_id, d.taken_on from depositions d join witnesses w on w.id = d.witness_id where d.case_id = (select case_id from case_runs where id = ${id})`).then((r) => new Map(r.rows.map((d) => [Number(d.id), d])));
  const at = (l: { printed_page: number; line_no: number }) => `${l.printed_page}:${String(l.line_no).padStart(2, "0")}`;
  const standing = await standingOf(db, rows.map((r) => r.f.id));
  // The transcript versions a reviewer sees now: a decision is saved only against these (api/analyses.ts, review).
  const epochs = await captureEpochs(db, rows.flatMap((r) => [r.c.depositionA, r.c.depositionB]));
  return rows.map(({ f, v, c }) => {
    const sides = (v.packet as { sides: { id: string; depositionId: number; lineIds: number[] }[] }).sides.map((s) => {
      const lines = s.lineIds.map((x) => stored.get(x)).filter((l) => l !== undefined);
      const d = people.get(s.depositionId);
      return { exchange: s.id, depositionId: s.depositionId, witnessId: d ? Number(d.witness_id) : null, witness: d?.witness ?? null, takenOn: d?.taken_on ?? null, range: lines.length ? `${at(lines[0])}–${at(lines[lines.length - 1])}` : null, lines: lines.map((l) => ({ id: Number(l.id), at: at(l), text: l.raw_text })) };
    });
    const checks = f.checks as { source?: { a?: { evidenceLineIds?: number[]; status?: string }; b?: { evidenceLineIds?: number[]; status?: string } }; outcome?: string; safeguards?: { rule: string; side: "a" | "b" | null; detail: string }[] };
    return {
      id: f.id, crossWitness: sides[0]?.witnessId !== sides[1]?.witnessId, type: f.type, priority: f.priority, score: f.score, band: f.band, unscoredReason: f.unscoredReason, evidenceStatus: f.evidenceStatus, reviewState: f.reviewState, reviewNote: f.reviewNote, reviewedAt: f.reviewedAt, evidenceEpochs: Object.fromEntries([c.depositionA, c.depositionB].map((d) => [String(d), epochs[String(d)]])), standing: standing.get(f.id)!,
      // Code's verification: which stored lines each side's citation was found on.
      verification: { a: { status: checks.source?.a?.status ?? null, lineIds: checks.source?.a?.evidenceLineIds ?? [] }, b: { status: checks.source?.b?.status ?? null, lineIds: checks.source?.b?.evidenceLineIds ?? [] } },
      a: sides[0], b: sides[1],
      model: { origin: v.origin, model: v.model, promptVersion: v.promptVersion, outcome: checks.outcome ?? null, verdict: v.parsed },
      // verify/safeguards.ts: the code checks that moved a conflict verdict to needs context (empty when none did).
      safeguards: checks.safeguards ?? [],
    };
  });
}
