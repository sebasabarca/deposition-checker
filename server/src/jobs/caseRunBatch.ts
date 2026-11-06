// Economy execution of a whole-case run: the same ledger entries, packets, prompt, verification and scoring as
// standard execution (caseRun.ts: entryContext, nextStep, applyReply), sent through the Message Batches API
// (adjudicate/packetBatch.ts) at half price. Only the transport differs.
//
// The run advances in ticks. The case-run job runs one tick and, while batches are open, queues itself again
// (CASE_RUN_BATCH_POLL_SECONDS later), so nothing waits in memory: every fact is in the database, and a worker
// restart simply runs the next tick. One tick:
//   1. reconcile  a batch left `submitting` by a crash: found in the provider's batch list (same request count,
//                 created in the window) it is adopted; not found within the window it becomes
//                 submission_unknown, its requests uncertain (counted in full) and its packets failed, retried only
//                 when someone resumes with retryUncertain. A submission is never repeated blindly.
//   2. poll       each open batch's status; a cancelled run asks the provider to cancel its open batches.
//   3. import     an ended batch's results, streamed: each by custom_id, each at most once (a result whose
//                 request is no longer `sent` is a duplicate). A reply is recorded (llm_calls, raw text, the
//                 reservation settled) in a transaction of accounting rows only, before it is parsed.
//   4. advance    every entry with no open request: link a newly imported reply to the entry (evidence-checked),
//                 parse a stored reply; then done, a recovery request (round 2),
//                 one retry of an unbilled errored or expired request, or the end (incomplete or failed).
//   5. submit     new batches while fewer than CASE_RUN_BATCHES_IN_FLIGHT are open. Claims, reservations, the
//                 batch row and its request rows are written in one transaction, which checks the run's evidence
//                 epochs last, then the provider is called.
//
// Corrected evidence (evidence/epoch.ts): once a transcript the run read is corrected, the run is `reconciling`.
// Nothing more is sent or published; its batches are cancelled and settled (reconcileStaleBatchRun), then it fails.
//
// Budget: every request reserves its worst case at batch prices (its max_tokens of output) before its batch is
// submitted, and keeps it until its result is imported, so spending can never pass the limit. A batch takes only
// the requests the remaining budget covers; when nothing is open and the next request doesn't fit, the run stops
// as blocked_budget. An economy run never falls back to standard requests.

import { randomBytes } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";
import { classifyFailure, closeRequest, openRequest } from "../adjudicate/requests";
import { PROVIDER_MAX_BYTES, PROVIDER_MAX_REQUESTS, ProviderStreamError, requestBytes, totalOf, type BatchResult, type BatchState, type PacketBatchProvider, type PacketBatchRequest } from "../adjudicate/packetBatch";
import { maxOutputTokensFor, PACKET_EFFORT, PACKET_MODEL, requestChars, type IssuePacket } from "../adjudicate/packetPrompt";
import { BudgetExceeded, closeFailed, inputTokenBound, maxBatchRequestCost, recordCall, releaseUnbilled, reserve, settle } from "../costs";
import type { Database } from "../db/client";
import { adjudicationRequests, caseRunBatches, caseRuns, screeningEntries, witnesses } from "../db/schema";
import { claimNext, markFailed } from "../screen/ledger";
import { MAX_RECOVERY_ROUNDS } from "../verify/packet";
import { findReusable, recordReuse, requestKeys, reuseApplies } from "./requestReuse";
import { applyReply, caseRunSetOf, contractOf, entryContext, finish, markIncomplete, MOCK_MODEL, nextStep, type CaseRun, type CaseRunStatus, type Entry, type EntryContext, type ItemIndex } from "./caseRun";

export type BatchSettings = { batchSize: number; maxBytes: number; inFlight: number; pollSeconds: number; reconcileWindowMs: number };
// 100 requests a batch: about 2.5 MB (well under 256 MB) and a worst-case reservation of roughly $10-$15 at batch
// prices on the real fixtures, so several batches fit in flight under a budget near the estimate. Ten batches
// open at once keeps polling cheap. A minute between checks: batches take minutes to hours.
export const BATCH_DEFAULTS: BatchSettings = { batchSize: 100, maxBytes: 32 * 1024 * 1024, inFlight: 10, pollSeconds: 60, reconcileWindowMs: 10 * 60_000 };
export const MOCK_POLL_SECONDS = 2;
const LIST_SKEW_MS = 2 * 60_000; // provider and server clocks may differ

// The developer script's extra switch for a paid economy run (scripts/case-run.ts --live --economy), on top of
// ALLOW_PAID_CALLS. The app doesn't read it: there, economy needs only the key and the person's confirmation,
// which includes acknowledging that the Batch API keeps testimony 29 days.
export const economyAllowed = (env: Record<string, string | undefined>) => env.ALLOW_ECONOMY_ANALYSIS === "true";

export function batchSettings(env: Record<string, string | undefined>): BatchSettings {
  const int = (name: string, fallback: number, max: number) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${name} must be a whole number from 1 to ${max}; got ${raw}.`);
    return n;
  };
  return {
    batchSize: int("CASE_RUN_BATCH_SIZE", BATCH_DEFAULTS.batchSize, PROVIDER_MAX_REQUESTS),
    maxBytes: int("CASE_RUN_BATCH_MAX_MB", BATCH_DEFAULTS.maxBytes / 1024 / 1024, PROVIDER_MAX_BYTES / 1024 / 1024 - 1) * 1024 * 1024,
    inFlight: int("CASE_RUN_BATCHES_IN_FLIGHT", BATCH_DEFAULTS.inFlight, 1000),
    pollSeconds: int("CASE_RUN_BATCH_POLL_SECONDS", BATCH_DEFAULTS.pollSeconds, 3600),
    reconcileWindowMs: BATCH_DEFAULTS.reconcileWindowMs,
  };
}

// faults: test hooks that simulate a crash at a named point.
export type BatchDeps = {
  provider: PacketBatchProvider;
  settings?: Partial<BatchSettings>;
  now?: () => number;
  faults?: { afterBatchWritten?: (seq: number) => void; afterResultRecorded?: (customId: string) => void; afterSubmitted?: (seq: number) => void };
  reuse?: boolean; // exact-request reuse (jobs/requestReuse.ts): only when true
};

type Batch = typeof caseRunBatches.$inferSelect;
type Request = typeof adjudicationRequests.$inferSelect;
type Send = { entry: Entry; packet: IssuePacket; sentIds: number[]; round: number; retryOf: number | null };
type Model = { model: string; promptVersion: string; effort: string };
const OPEN: Batch["status"][] = ["submitting", "submitted", "canceling", "ended"];
const asDb = (tx: unknown) => tx as Database;
// The provider no longer has the batch (deleted, or a test-model batch lost with its worker): it can't end on its
// own, so it is treated as ended with no results, which leaves each request uncertain.
// Statuses that prove the provider refused a batch before creating it. Anything else (a timeout, a dropped
// connection, a 5xx, an unexpected 4xx such as 408 or 409) may hide an accepted batch, so it is left `submitting`
// for reconcile to find by custom ID, and is never resubmitted on its own.
const REFUSED = new Set([400, 401, 403, 404, 413, 422, 429]);
const refused = (e: unknown) => e instanceof Anthropic.APIError && typeof e.status === "number" && REFUSED.has(e.status);
const notFound = (e: unknown) => typeof e === "object" && e !== null && (e as { status?: number }).status === 404;

export async function runBatchTick(db: Database, run: CaseRun, ledgerId: number, deps: BatchDeps): Promise<CaseRunStatus | "polling"> {
  const s = { ...BATCH_DEFAULTS, ...deps.settings };
  const now = () => deps.now?.() ?? Date.now();
  const live = run.mode === "live";
  const model: Model = live ? { model: PACKET_MODEL, promptVersion: contractOf(run), effort: PACKET_EFFORT } : { model: MOCK_MODEL, promptVersion: contractOf(run), effort: "mock" };
  const [fresh] = await db.select({ cancel: caseRuns.cancelRequestedAt }).from(caseRuns).where(eq(caseRuns.id, run.id));
  const cancelling = fresh.cancel !== null;
  const ledger = await db.execute<{ settings: { itemIndex: ItemIndex } }>(sql`select settings from screening_runs where id = ${ledgerId}`).then((r) => r.rows[0]);
  const index = ledger.settings.itemIndex;
  const names = new Map((await db.select({ id: witnesses.id, name: witnesses.name }).from(witnesses).where(eq(witnesses.caseId, run.caseId))).map((w) => [w.id, w.name]));
  const contexts = new Map<number, EntryContext | string>();
  const contextOf = async (tx: Database, entry: Entry) => {
    if (!contexts.has(entry.id)) contexts.set(entry.id, await entryContext(tx, entry, index, names, { allItems: contractOf(run) === "stretch-v2" }));
    return contexts.get(entry.id)!;
  };

  await reconcile(db, run, deps, s, now);
  await poll(db, run, deps, cancelling);
  const pending = new Map<number, string | null>(); // mock replies, by request id: a mock run records no llm_calls
  for (const b of await batchesOf(db, run.id, ["ended"])) await importBatch(db, run, b, deps, live, pending);

  // Advance every entry that waits on nothing.
  const sends: Send[] = [];
  const waiting = await db.select().from(screeningEntries).where(and(eq(screeningEntries.runId, ledgerId), eq(screeningEntries.adjudicationStatus, "in_progress"))).orderBy(asc(screeningEntries.rank));
  const latest = await latestRequests(db, waiting.map((e) => e.id));
  for (const entry of waiting) {
    const last = latest.get(entry.id) ?? null;
    if (last?.status === "sent") continue;
    const send = await advance(db, run, ledgerId, entry, last, await contextOf(db, entry), model, pending, cancelling, deps.reuse);
    if (send) sends.push(send);
  }

  let budgetMessage: string | null = null;
  let fatal: string | null = null;
  if (!cancelling) ({ budgetMessage, fatal } = await submit(db, run, ledgerId, sends, contextOf, model, deps, s));

  const open = (await batchesOf(db, run.id, OPEN)).length;
  if (open > 0) return "polling";
  if (fatal) return finish(db, run.id, ledgerId, "failed", fatal);
  // Work left that nothing stopped (the provider rate-limited this tick's batch): the next check submits it.
  if (!cancelling && !budgetMessage && (await db.$count(screeningEntries, and(eq(screeningEntries.runId, ledgerId), eq(screeningEntries.screenStatus, "prioritized"), inArray(screeningEntries.adjudicationStatus, ["in_progress", "not_started"])))) > 0) return "polling";
  if (cancelling) {
    await db.update(screeningEntries).set({ adjudicationStatus: "not_started", adjudicationNote: "returned to the queue: cancelled", updatedAt: sql`now()` }).where(and(eq(screeningEntries.runId, ledgerId), eq(screeningEntries.adjudicationStatus, "in_progress")));
    return finish(db, run.id, ledgerId, "cancelled", "Cancelled. Completed findings are kept; packets not yet read stay pending.");
  }
  if (budgetMessage) {
    await db.update(screeningEntries).set({ adjudicationStatus: "not_started", adjudicationNote: "returned to the queue: budget", updatedAt: sql`now()` }).where(and(eq(screeningEntries.runId, ledgerId), eq(screeningEntries.adjudicationStatus, "in_progress")));
    return finish(db, run.id, ledgerId, "blocked_budget", budgetMessage);
  }
  return finish(db, run.id, ledgerId, null, null);
}

const batchesOf = (db: Database, runId: number, statuses: Batch["status"][]) => db.select().from(caseRunBatches).where(and(eq(caseRunBatches.caseRunId, runId), inArray(caseRunBatches.status, statuses))).orderBy(asc(caseRunBatches.seq));

// Each entry's most recent request. A request that was never submitted (the provider refused its batch) is
// left out: it changed nothing.
async function latestRequests(db: Database, entryIds: number[]) {
  if (!entryIds.length) return new Map<number, Request>();
  const rows = await db.execute<{ id: number }>(sql`
    select distinct on (screening_entry_id) id from adjudication_requests
    where screening_entry_id in (${sql.join(entryIds.map((x) => sql`${x}`), sql`, `)}) and coalesce(error_kind, '') <> 'not_submitted'
    order by screening_entry_id, id desc`).then((r) => r.rows.map((x) => Number(x.id)));
  if (!rows.length) return new Map<number, Request>();
  const full = await db.select().from(adjudicationRequests).where(inArray(adjudicationRequests.id, rows));
  return new Map(full.map((r) => [r.screeningEntryId!, r]));
}

// What an entry needs after its last request (or with none: a fresh claim). Returns the request to send, if any.
async function advance(db: Database, run: CaseRun, ledgerId: number, entry: Entry, lastIn: Request | null, ctx: EntryContext | string, model: Model, pending: Map<number, string | null>, cancelling: boolean, reuse?: boolean): Promise<Send | null> {
  let last = lastIn;
  if (typeof ctx === "string") {
    await failEntry(db, ledgerId, entry, ctx, false);
    return null;
  }
  // A reply imported since the entry last moved: link it to the entry (its cost is already recorded with the
  // request). This write is evidence-checked: after a correction it is refused, and the reply stays unpublished.
  if (last && (last.status === "completed" || last.status === "partial") && entry.requestId !== last.id) {
    await db.update(screeningEntries).set({ attempts: sql`${screeningEntries.attempts} + 1`, requestId: last.id, llmCallId: last.llmCallId, updatedAt: sql`now()` }).where(eq(screeningEntries.id, entry.id));
    entry = { ...entry, attempts: entry.attempts + 1, requestId: last.id, llmCallId: last.llmCallId };
  }
  const at = { entry };
  let mock = last && pending.has(last.id) ? { candidateIds: last.candidateIds, text: pending.get(last.id)!, requestId: last.id } : undefined;
  for (;;) {
    const step = await nextStep(db, run, at, ctx, mock);
    if (step.kind === "done") return null;
    if (step.kind === "stored") {
      at.entry = await applyReply(db, run, at.entry, step.packet, step.sentIds, step, model);
      mock = undefined;
      continue;
    }
    const send = (round: number, retryOf: number | null): Send => ({ entry: at.entry, packet: step.packet, sentIds: step.sentIds, round, retryOf });
    // Exact-request reuse, wherever a request would go to a batch: the same provider-visible request from the same
    // evidence, already answered in a live run of this case, is parsed again instead of being submitted.
    const reused = async (round: number): Promise<boolean> => {
      if (cancelling || !reuseApplies(run, reuse)) return false;
      const keys = await requestKeys(db, contractOf(run), step.packet, model);
      const source = await findReusable(db, run.caseId, keys, model.model);
      if (!source) return false;
      const hit = await recordReuse(db, run, at.entry.id, step.packet, step.sentIds, model, source, keys, { round, strategy: "packet-batch", estimatedInputTokens: inputTokenBound(requestChars(step.packet, contractOf(run))), maxOutputTokens: maxOutputTokensFor(step.packet.pairs.length) });
      at.entry = await applyReply(db, run, { ...at.entry, requestId: hit.request.id, llmCallId: source.llmCallId }, step.packet, step.sentIds, hit.reply, model);
      last = hit.request;
      mock = undefined;
      return true;
    };
    // Cancelling: nothing more is sent. Unread pairs go back to the queue; a possibly billed request stays visible.
    if (cancelling && last?.errorKind !== "uncertain") {
      await db.update(screeningEntries).set({ adjudicationStatus: "not_started", adjudicationNote: "returned to the queue: cancelled", updatedAt: sql`now()` }).where(eq(screeningEntries.id, entry.id));
      return null;
    }
    if (!last) {
      if (await reused(1)) continue;
      return send(1, null);
    }
    if (last.status === "completed" || last.status === "partial" || last.status === "reused") {
      if ((last.round ?? 1) >= 1 + MAX_RECOVERY_ROUNDS) {
        await markIncomplete(db, at.entry, step.remaining, ctx);
        return null;
      }
      if (await reused((last.round ?? 1) + 1)) continue;
      return send((last.round ?? 1) + 1, null);
    }
    // Errored (not a bad request) or expired: not billed, so retried once in a later batch.
    if ((last.errorKind === "batch_errored" || last.errorKind === "expired") && last.retryOf === null) {
      if (await reused(last.round ?? 1)) continue;
      return send(last.round ?? 1, last.id);
    }
    if (last.errorKind === "canceled" || last.errorKind === "test_batch_lost") {
      await db.update(screeningEntries).set({ adjudicationStatus: "not_started", adjudicationNote: "returned to the queue: its batch was cancelled", updatedAt: sql`now()` }).where(eq(screeningEntries.id, entry.id));
      return null;
    }
    const uncertain = last.errorKind === "uncertain";
    await failEntry(db, ledgerId, entry, `${last.errorKind ?? "failed"}: ${last.error ?? "the batch request failed"}${last.retryOf !== null ? " (after one retry)" : ""}`, uncertain);
    return null;
  }
}

async function failEntry(db: Database, ledgerId: number, entry: Entry, message: string, billable: boolean) {
  await markFailed(db, ledgerId, entry.packetId, message.slice(0, 2000));
  await db.update(screeningEntries).set({ failureBillable: billable }).where(eq(screeningEntries.id, entry.id));
}

// Builds and submits batches: first the requests entries already waiting need (recovery rounds, retries), then
// fresh packets from the ledger, each with its worst case reserved. Stops at the in-flight limit or the budget.
async function submit(db: Database, run: CaseRun, ledgerId: number, sends: Send[], contextOf: (tx: Database, e: Entry) => Promise<EntryContext | string>, model: Model, deps: BatchDeps, s: BatchSettings): Promise<{ budgetMessage: string | null; fatal: string | null }> {
  const live = run.mode === "live";
  let open = (await batchesOf(db, run.id, OPEN)).length;
  const queue = [...sends];
  for (; open < s.inFlight; open++) {
    let short: string | null = null;
    const written = await db.transaction(async (txRaw) => {
      const tx = asDb(txRaw);
      const items: { send: Send; request: PacketBatchRequest; bytes: number; maxCostUsd: number; reservationId: number | null; fresh: boolean }[] = [];
      let bytes = 0;
      const take = async (send: Send, fresh: boolean) => {
        const request = { customId: `cr${run.id}-e${send.entry.id}-${randomBytes(6).toString("hex")}`, packet: send.packet, contract: contractOf(run) };
        const size = requestBytes(request);
        if (items.length && bytes + size > s.maxBytes) return false;
        const chars = requestChars(send.packet, contractOf(run));
        const maxCostUsd = live ? maxBatchRequestCost(PACKET_MODEL, { inputTokens: inputTokenBound(chars), maxOutputTokens: maxOutputTokensFor(send.packet.pairs.length) }) : 0;
        let reservationId: number | null = null;
        if (live) {
          try {
            reservationId = await reserve(tx, run.budgetId!, maxCostUsd, `${caseRunSetOf(run.id)} ${send.entry.packetId} batch`);
          } catch (e) {
            if (!(e instanceof BudgetExceeded)) throw e;
            short = `Stopped before packet ${send.entry.packetId}: its worst case at batch prices ($${maxCostUsd.toFixed(4)}) is more than the budget has left once the requests in flight are counted at their worst case. Completed findings are kept; raise the budget and resume to continue.`;
            return false;
          }
        }
        items.push({ send, request, bytes: size, maxCostUsd, reservationId, fresh });
        bytes += size;
        return true;
      };
      while (queue.length && items.length < s.batchSize) {
        if (!(await take(queue[0], false))) break;
        queue.shift();
      }
      while (!short && items.length < s.batchSize && bytes < s.maxBytes) {
        const [entry] = await claimNext(tx, ledgerId, 1);
        if (!entry) break;
        const ctx = await contextOf(tx, entry);
        const send = await advance(tx, run, ledgerId, entry, null, ctx, model, new Map(), false, deps.reuse);
        if (!send) continue; // done already, or failed: nothing to send
        if (!(await take(send, true))) {
          await tx.update(screeningEntries).set({ adjudicationStatus: "not_started", adjudicationNote: "returned to the queue: budget or batch size", updatedAt: sql`now()` }).where(eq(screeningEntries.id, entry.id));
          break;
        }
      }
      if (!items.length) return null;
      const [{ seq }] = await tx.execute<{ seq: number }>(sql`select coalesce(max(seq), 0)::int + 1 as seq from case_run_batches where case_run_id = ${run.id}`).then((r) => r.rows);
      const [batch] = await tx.insert(caseRunBatches).values({ caseRunId: run.id, seq, status: "submitting", requestCount: items.length, payloadBytes: bytes, maxCostUsd: items.reduce((n, i) => n + i.maxCostUsd, 0) }).returning();
      const context = { candidateSet: caseRunSetOf(run.id), analysisId: null, strategy: "packet-batch", maxConcurrency: items.length };
      for (const i of items) {
        const chars = requestChars(i.send.packet, contractOf(run));
        const id = await openRequest(tx, context, { candidateIds: i.send.sentIds, model: model.model, promptVersion: model.promptVersion, estimatedInputTokens: inputTokenBound(chars), maxOutputTokens: maxOutputTokensFor(i.send.packet.pairs.length), maxCostUsd: i.maxCostUsd, reservationId: i.reservationId });
        const keys = await requestKeys(tx, contractOf(run), i.send.packet, model); // so an identical later request can reuse this response once imported
        await tx.update(adjudicationRequests).set({ caseRunBatchId: batch.id, customId: i.request.customId, screeningEntryId: i.send.entry.id, round: i.send.round, retryOf: i.send.retryOf, requestFingerprint: keys.fingerprint, evidenceKey: keys.evidenceKey }).where(eq(adjudicationRequests.id, id));
      }
      // Nothing is sent from evidence that has changed: the guard (migration 0039) checks every epoch this run
      // declared, under the lock a correction must wait for, and refuses (VE002) before the provider is called. A
      // recovery request or a retry otherwise writes nothing evidence-checked on its way to a batch.
      await tx.execute(sql`select evidence_guard(array(select jsonb_object_keys(nullif(current_setting('evidence.read_epochs', true), '')::jsonb)::bigint))`);
      return { batch, requests: items.map((i) => i.request) };
    });
    if (!written) return { budgetMessage: short && open === 0 ? short : null, fatal: null };
    deps.faults?.afterBatchWritten?.(written.batch.seq);
    let state: BatchState;
    try {
      state = await deps.provider.submit(written.requests);
    } catch (e) {
      const f = classifyFailure(e);
      if (refused(e)) {
        // Refused: no batch exists. The requests changed nothing; their entries are decided again next tick.
        await notSubmitted(db, written.batch, e);
        if (f.status === "rate_limited") return { budgetMessage: null, fatal: null };
        return { budgetMessage: null, fatal: `The provider refused a batch: ${e instanceof Error ? e.message : String(e)}` };
      }
      // It may exist: left `submitting` for the next tick to find in the provider's list.
      await db.update(caseRunBatches).set({ error: `submission outcome unknown: ${(e instanceof Error ? e.message : String(e)).slice(0, 500)}`, updatedAt: new Date() }).where(eq(caseRunBatches.id, written.batch.id));
      return { budgetMessage: null, fatal: null };
    }
    await adopt(db, written.batch, state, null);
    deps.faults?.afterSubmitted?.(written.batch.seq);
    if (short) return { budgetMessage: null, fatal: null }; // the budget is full: wait for results
  }
  return { budgetMessage: null, fatal: null };
}

async function notSubmitted(db: Database, batch: Batch, e: unknown) {
  const message = (e instanceof Error ? e.message : String(e)).slice(0, 2000);
  const requests = await db.select().from(adjudicationRequests).where(eq(adjudicationRequests.caseRunBatchId, batch.id));
  for (const r of requests) {
    if (r.reservationId !== null) await releaseUnbilled(db, r.reservationId, "batch not submitted");
    await closeRequest(db, r.id, { status: "failed", errorKind: "not_submitted", error: message });
  }
  await db.update(caseRunBatches).set({ status: "not_submitted", error: message, updatedAt: new Date() }).where(eq(caseRunBatches.id, batch.id));
}

async function adopt(db: Database, batch: Batch, state: BatchState, recovery: string | null) {
  await db
    .update(caseRunBatches)
    .set({ status: state.status === "ended" ? "ended" : state.status === "canceling" ? "canceling" : "submitted", providerBatchId: state.id, providerStatus: state.status, requestCounts: state.counts, submittedAt: new Date(), providerCreatedAt: state.createdAt, expiresAt: state.expiresAt, endedAt: state.endedAt, recovery, error: null, updatedAt: new Date() })
    .where(eq(caseRunBatches.id, batch.id));
}

// A batch row left `submitting` belongs to a runner that died between writing it and saving the provider's ID, or
// whose submit call failed in a way that doesn't prove the provider refused it. The provider's batch list is the only
// record, and a batch carries no label, so a listed batch is adopted only on proof of identity: once it has ended,
// its results carry exactly this batch's custom IDs (each holds 48 random bits). The request count and creation
// time only narrow the search; they are never taken as proof. While a possible match is still processing, the row
// waits in `submitting` (a batch always ends within 24 hours). With no possible match after the window, the row
// becomes submission_unknown: its requests are counted as billed and their packets are sent again only when a
// person resumes with retryUncertain. Nothing here ever submits.
async function reconcile(db: Database, run: CaseRun, deps: BatchDeps, s: BatchSettings, now: () => number) {
  for (const b of await batchesOf(db, run.id, ["submitting"])) {
    const since = new Date(b.createdAt.getTime() - LIST_SKEW_MS);
    const known = new Set((await db.select({ id: caseRunBatches.providerBatchId }).from(caseRunBatches).where(sql`${caseRunBatches.providerBatchId} is not null`)).map((r) => r.id));
    const ours = new Set((await db.select({ id: adjudicationRequests.customId }).from(adjudicationRequests).where(eq(adjudicationRequests.caseRunBatchId, b.id))).map((r) => r.id!));
    let found: BatchState | null = null;
    let processing = 0;
    try {
      const candidates: BatchState[] = [];
      for await (const x of deps.provider.list(since)) if (!known.has(x.id) && totalOf(x.counts) === b.requestCount) candidates.push(x);
      for (const c of candidates) {
        if (c.status !== "ended") { processing++; continue; }
        if (await carriesExactly(deps.provider, c.id, ours)) { found = c; break; }
      }
    } catch (e) {
      await db.update(caseRunBatches).set({ error: `could not check the provider's batches: ${(e instanceof Error ? e.message : String(e)).slice(0, 500)}`, updatedAt: new Date() }).where(eq(caseRunBatches.id, b.id));
      continue;
    }
    if (found) {
      await adopt(db, b, found, `Recovered after a crash during submission: provider batch ${found.id}, whose results carry exactly this batch's ${ours.size} custom IDs.`);
      continue;
    }
    if (processing > 0) {
      await db.update(caseRunBatches).set({ error: `submission outcome unknown: ${processing} provider batch${processing === 1 ? "" : "es"} of the same size still processing; checked by custom ID once ${processing === 1 ? "it ends" : "they end"}`, updatedAt: new Date() }).where(eq(caseRunBatches.id, b.id));
      continue;
    }
    if (run.mode === "mock") {
      // A test-model run costs nothing, so an unconfirmed submission is simply queued again.
      for (const r of await db.select().from(adjudicationRequests).where(and(eq(adjudicationRequests.caseRunBatchId, b.id), eq(adjudicationRequests.status, "sent")))) {
        await closeRequest(db, r.id, { status: "aborted", errorKind: "test_batch_lost", error: "The test-model batch couldn't be confirmed after a restart; its packet is sent again." });
      }
      await db.update(caseRunBatches).set({ status: "not_submitted", recovery: "Test-model batch not found after a restart; its packets were queued again.", updatedAt: new Date() }).where(eq(caseRunBatches.id, b.id));
      continue;
    }
    if (now() - b.createdAt.getTime() < s.reconcileWindowMs) continue;
    const note = "The worker stopped while submitting this batch, and no batch in the provider's list carries its custom IDs. It may still have been accepted, so its requests are counted in full and their packets are not sent again unless someone resumes with retryUncertain.";
    for (const r of await db.select().from(adjudicationRequests).where(and(eq(adjudicationRequests.caseRunBatchId, b.id), eq(adjudicationRequests.status, "sent")))) {
      if (r.reservationId !== null) await closeFailed(db, r.reservationId, new Error("batch submission outcome unknown"));
      await closeRequest(db, r.id, { status: "failed", errorKind: "uncertain", error: note });
    }
    // Their packets fail when advanced: each one's last request is uncertain.
    await db.update(caseRunBatches).set({ status: "submission_unknown", recovery: note, updatedAt: new Date() }).where(eq(caseRunBatches.id, b.id));
  }
}

// Whether an ended batch's results are exactly these custom IDs: every one present, nothing else.
async function carriesExactly(provider: PacketBatchProvider, batchId: string, ours: Set<string>) {
  const seen = new Set<string>();
  for await (const r of provider.results(batchId)) {
    if (!ours.has(r.customId)) return false;
    seen.add(r.customId);
  }
  return seen.size === ours.size;
}

async function poll(db: Database, run: CaseRun, deps: BatchDeps, cancelling: boolean) {
  for (const b of await batchesOf(db, run.id, ["submitted", "canceling"])) {
    if (cancelling && b.cancelRequestedAt === null) {
      try {
        await deps.provider.cancel(b.providerBatchId!);
        await db.update(caseRunBatches).set({ cancelRequestedAt: new Date(), status: "canceling", updatedAt: new Date() }).where(eq(caseRunBatches.id, b.id));
      } catch (e) {
        await db.update(caseRunBatches).set({ error: `cancel failed, retried next check: ${(e instanceof Error ? e.message : String(e)).slice(0, 500)}`, updatedAt: new Date() }).where(eq(caseRunBatches.id, b.id));
      }
    }
    try {
      const st = await deps.provider.retrieve(b.providerBatchId!);
      const ended = st.status === "ended";
      await db
        .update(caseRunBatches)
        .set({ providerStatus: st.status, requestCounts: st.counts, expiresAt: st.expiresAt, lastPolledAt: new Date(), error: null, updatedAt: new Date(), ...(ended ? { status: "ended", endedAt: st.endedAt ?? new Date() } : {}) })
        .where(eq(caseRunBatches.id, b.id));
    } catch (e) {
      if (notFound(e) && run.mode === "mock") {
        // A test-model batch lives in its worker's memory and is gone after a restart. Nothing was billed (the test
        // model costs nothing), so its packets simply go back to the queue. Never for a live run: see below.
        for (const r of await db.select().from(adjudicationRequests).where(and(eq(adjudicationRequests.caseRunBatchId, b.id), eq(adjudicationRequests.status, "sent")))) {
          await closeRequest(db, r.id, { status: "aborted", errorKind: "test_batch_lost", error: "The test-model batch was lost with a worker restart; its packet is sent again." });
        }
        await db.update(caseRunBatches).set({ status: "imported", importedAt: new Date(), error: "Test-model batch lost with a worker restart; its packets were queued again.", lastPolledAt: new Date(), updatedAt: new Date() }).where(eq(caseRunBatches.id, b.id));
        continue;
      }
      if (notFound(e)) {
        // A live batch the provider no longer has (deleted): it may have run and been billed, so its requests end
        // uncertain when imported, counted in full and resent only on retryUncertain.
        await db.update(caseRunBatches).set({ status: "ended", endedAt: new Date(), error: "The provider no longer has this batch; its requests have no results.", lastPolledAt: new Date(), updatedAt: new Date() }).where(eq(caseRunBatches.id, b.id));
        continue;
      }
      // A failed check proves nothing: the batch keeps running and is checked again next tick.
      await db.update(caseRunBatches).set({ error: `status check failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 500)}`, lastPolledAt: new Date(), updatedAt: new Date() }).where(eq(caseRunBatches.id, b.id));
    }
  }
}

// Imports an ended batch's results. Safe to repeat after a crash at any point: a request is closed once, and a
// result for a request already closed (a duplicate delivery, or a re-import) is skipped.
async function importBatch(db: Database, run: CaseRun, b: Batch, deps: BatchDeps, live: boolean, pending: Map<number, string | null>) {
  let imported = 0;
  let foreign = 0;
  try {
    for await (const r of deps.provider.results(b.providerBatchId!)) {
      const [req] = await db.select().from(adjudicationRequests).where(and(eq(adjudicationRequests.customId, r.customId), eq(adjudicationRequests.caseRunBatchId, b.id)));
      if (!req) { foreign++; continue; }
      if (req.status !== "sent") continue;
      await recordResult(db, run, req, r, live, pending);
      imported++;
      deps.faults?.afterResultRecorded?.(r.customId);
    }
  } catch (e) {
    if (!(e instanceof Anthropic.APIError) && !(e instanceof ProviderStreamError)) throw e; // ours (database, a bug): the job fails and is retried
    if (!notFound(e)) {
      await db.update(caseRunBatches).set({ error: `results import stopped, resumed next check: ${(e instanceof Error ? e.message : String(e)).slice(0, 500)}`, updatedAt: new Date() }).where(eq(caseRunBatches.id, b.id));
      return;
    }
  }
  // Every request of an ended batch has a result. One without is unknown, and may have been billed.
  for (const req of await db.select().from(adjudicationRequests).where(and(eq(adjudicationRequests.caseRunBatchId, b.id), eq(adjudicationRequests.status, "sent")))) {
    if (req.reservationId !== null) await closeFailed(db, req.reservationId, new Error("no result in the ended batch"));
    await closeRequest(db, req.id, { status: "failed", errorKind: "uncertain", error: "The ended batch holds no result for this request; it may have been billed." });
  }
  await db
    .update(caseRunBatches)
    .set({ status: "imported", importedAt: new Date(), resultsImported: sql`${caseRunBatches.resultsImported} + ${imported}`, error: foreign ? `${foreign} results matched no request of this batch` : null, updatedAt: new Date() })
    .where(eq(caseRunBatches.id, b.id));
}

async function recordResult(db: Database, run: CaseRun, req: Request, r: BatchResult, live: boolean, pending: Map<number, string | null>) {
  if (r.type === "succeeded") {
    const reply = r.reply;
    const status = reply.stopReason === "max_tokens" ? "partial" : "completed";
    const errorKind = reply.stopReason === "max_tokens" ? "cut_off" : reply.stopReason === "refusal" ? "refused" : null;
    if (!live) {
      await closeRequest(db, req.id, { status, errorKind, latencyMs: reply.latencyMs });
      pending.set(req.id, reply.text);
      return;
    }
    // The reply is paid for: recorded with its raw text, its reservation settled and its request closed, in one
    // transaction that touches only accounting tables, so a correction of the evidence (which refuses writes to
    // ledger entries and verdicts, evidence/epoch.ts) can never roll it back. The request row, locked while still
    // `sent`, is the idempotency key: a result is recorded once however often it is delivered or re-imported.
    // advance() links the reply to its ledger entry afterwards, in a separate, evidence-checked write.
    await db.transaction(async (txRaw) => {
      const tx = asDb(txRaw);
      const [open] = (await tx.execute<{ id: number }>(sql`select id from adjudication_requests where id = ${req.id} and status = 'sent' for update`)).rows;
      if (!open) return;
      const call = await recordCall(tx, { jobId: null, stage: "adjudication", model: reply.model, usage: reply.usage as Anthropic.Usage, attempt: req.retryOf === null ? 1 : 2, items: req.candidateIds.length, batch: true, rawOutput: reply.text, effort: PACKET_EFFORT, latencyMs: reply.latencyMs });
      if (req.reservationId !== null) await settle(tx, req.reservationId, { id: call.id, costUsd: call.costUsd });
      await closeRequest(tx, req.id, { status, errorKind, llmCallId: call.id, latencyMs: reply.latencyMs });
    });
    return;
  }
  // Errored, expired and cancelled requests are not billed (the provider's documentation): reservation released.
  if (req.reservationId !== null) await releaseUnbilled(db, req.reservationId, `batch item ${r.type}`);
  if (r.type === "errored") await closeRequest(db, req.id, { status: "failed", errorKind: r.errorType === "invalid_request_error" ? "batch_invalid" : "batch_errored", error: `${r.errorType}: ${r.message}` });
  else if (r.type === "expired") await closeRequest(db, req.id, { status: "failed", errorKind: "expired", error: "The batch reached its 24-hour limit before this request ran." });
  else await closeRequest(db, req.id, { status: "aborted", errorKind: "canceled", error: "The batch was cancelled before this request ran." });
}

// An economy run whose evidence was corrected after it read it (status `reconciling`, set by caseRun.ts). Nothing
// more is submitted or published; what the provider already holds is settled: open batches are asked to cancel,
// every ended batch is imported (each billed reply recorded once and its reservation settled; cancelled, errored
// and expired requests, not billed, released; a request with no result counted in full as uncertain), and a
// submission left unconfirmed is reconciled by custom ID as usual. Once no batch is open the run fails with the
// stale-evidence reason. Run on the plain (unfenced) connection: it writes only accounting rows (case_run_batches,
// adjudication_requests, llm_calls, budgets) and the run's own row, never ledger entries, verdicts or findings.
// Each tick repeats safely; a provider that can't be reached leaves the batch open with its error, checked again.
export async function reconcileStaleBatchRun(db: Database, run: CaseRun, deps: BatchDeps): Promise<"polling" | "failed"> {
  const s = { ...BATCH_DEFAULTS, ...deps.settings };
  const now = () => deps.now?.() ?? Date.now();
  await reconcile(db, run, deps, s, now);
  await poll(db, run, deps, true);
  for (const b of await batchesOf(db, run.id, ["ended"])) await importBatch(db, run, b, deps, run.mode === "live", new Map());
  if ((await batchesOf(db, run.id, OPEN)).length) return "polling";
  const [r] = (await db.execute<{ recorded: number; uncertain: number }>(sql`
    select count(*) filter (where llm_call_id is not null)::int as recorded, count(*) filter (where error_kind = 'uncertain')::int as uncertain
    from adjudication_requests where candidate_set = ${caseRunSetOf(run.id)}`)).rows;
  const note = ` Every provider batch has ended: ${r.recorded} billed repl${r.recorded === 1 ? "y" : "ies"} recorded but not published${r.uncertain ? `; ${r.uncertain} request${r.uncertain === 1 ? "" : "s"} with no result counted in full as possibly billed` : ""}.`;
  await db.update(caseRuns).set({ status: "failed", error: `${STALE_BATCH_RUN}${note}`, finishedAt: new Date(), updatedAt: new Date() }).where(eq(caseRuns.id, run.id));
  return "failed";
}
export const STALE_BATCH_RUN = "A transcript in this case was corrected after this run read it, so none of its later results were saved as findings.";
export const STALE_BATCH_RECONCILING = `${STALE_BATCH_RUN} Nothing more is sent; its open provider batches are being cancelled and every billed result recorded before the run ends. A new run on the corrected transcripts can start now.`;

// Economy runs that should be ticking: the worker queues them again on start, in case a tick's follow-up job
// was lost (pg-boss keeps queued jobs, so this is a backstop).
export async function batchRunsToResume(db: Database) {
  return db.select({ id: caseRuns.id, mode: caseRuns.mode }).from(caseRuns).where(and(eq(caseRuns.execution, "batch"), inArray(caseRuns.status, ["adjudicating", "reconciling"])));
}
