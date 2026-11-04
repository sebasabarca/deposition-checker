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
//   - Live calls reserve their worst case first; a reservation the budget can't cover stops the run as
//     blocked_budget with the packet returned to the queue. A failure records whether it may have been billed.
//   - A live run found mid-stage by a new runner is marked interrupted: paid work restarts only on resume.
// Mock mode uses the label-blind mock replies (eval/mockPacketModel.ts): no budget, no llm_calls, verdicts
// labelled `fixture`. It measures the pipeline, never model quality.

import { createHash, randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { assessPacketPair } from "../adjudicate/packetAssess";
import { buildIssuePacket, resolvePassages } from "../adjudicate/packetLoad";
import { formatIssuePacket, PACKET_EFFORT, PACKET_MODEL, PACKET_PROMPT_VERSION, PACKET_SYSTEM_PROMPT, maxOutputTokensFor, type IssuePacket } from "../adjudicate/packetPrompt";
import type { PacketAdjudicator } from "../adjudicate/packetModel";
import { parseVerdictsLenient, VERDICT_SCHEMAS } from "../adjudicate/packetSchema";
import { classifyFailure, closeRequest, openRequest } from "../adjudicate/requests";
import type { AdjudicatorReply } from "../adjudicate/model";
import { BudgetExceeded, closeFailed, inputTokenBound, maxRequestCost, reconcileStale, recordCall, reserve, settle } from "../costs";
import type { Database } from "../db/client";
import { adjudicationRequests, budgets, candidates, caseRuns, findings, llmCalls, screeningEntries, screeningRuns, verdicts, witnesses } from "../db/schema";
import { mockPacketReply } from "../eval/mockPacketModel";
import { buildCasePool, CASE_POOL_VERSION, type CaseItem } from "../retrieve/casePool";
import { INSTRUCTION_TOKENS } from "../retrieve/grouping";
import { PACKET_LIMITS, splitPacketSet, type PacketLimits } from "../retrieve/packetSplit";
import { COST_ASSUMPTIONS, projectCost } from "../eval/screeningBenchmark";
import type { FrozenItem } from "../retrieve/frozen";
import { pairKey } from "../retrieve/frozen";
import { RUBRIC_V1 } from "../score/rubric";
import { claimNext, markFailed, recordScreening, releaseInProgress, retryFailed } from "../screen/ledger";
import { screen } from "../screen/strategies";
import { MAX_RECOVERY_ROUNDS, verifyPacketReply } from "../verify/packet";
import { VERIFICATION_VERSION } from "../verify/version";

export const CASE_RUN_STATUSES = ["queued", "retrieving", "awaiting_confirmation", "adjudicating", "completed", "incomplete", "failed", "blocked_budget", "blocked_credentials", "cancelled", "interrupted"] as const;
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
export type CaseRunDeps = {
  adjudicator: (run: CaseRun) => CasePacketModel | null;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  minilm?: "auto" | "off";
  packetLimits?: PacketLimits; // default PACKET_LIMITS (8 pairs, about 9,000 input tokens)
  // afterRequestSent: the provider has the request, and the process dies before any response is saved.
  faults?: { afterReplyRecorded?: (packetId: string) => void; afterRequestSent?: (packetId: string) => void };
};

export const fromPacketAdjudicator = (a: PacketAdjudicator): CasePacketModel => ({
  model: a.model, effort: a.effort, promptVersion: a.promptVersion,
  adjudicate: (packet, options) => a.adjudicate(formatIssuePacket(packet), packet.pairs.length, options),
});

// The deterministic label-blind mock as a packet model. `model` names what the reply stands in for.
export function mockCaseModel(model = MOCK_MODEL): CasePacketModel & { calls: string[] } {
  const calls: string[] = [];
  return {
    model, effort: "mock", promptVersion: PACKET_PROMPT_VERSION, calls,
    async adjudicate(packet) {
      calls.push(packet.id);
      const m = mockPacketReply(packet);
      const usage = { input_tokens: m.usage.inputTokens, output_tokens: m.usage.outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } as AdjudicatorReply["usage"];
      return { model, stopReason: "end_turn", usage, text: m.text, latencyMs: 0, requestId: `mock-${calls.length}` };
    },
  };
}

// Stored with the run's screening ledger so a packet can be rebuilt from the database after a restart.
type ItemIndex = Record<string, Pick<CaseItem, "document" | "session" | "groupId" | "positions" | "sourceHash" | "depositionId" | "witnessId" | "sessionId" | "exchangeIds">>;

async function update(db: Database, id: number, changes: Partial<typeof caseRuns.$inferInsert>) {
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

// Marks a run whose worker died mid-stage as interrupted, after settling what it left behind.
export async function interruptCaseRun(db: Database, run: CaseRun, reason: string) {
  const ledger = await ledgerOf(db, run.id);
  if (ledger) await settleAbandoned(db, run, ledger.id);
  else if (run.budgetId !== null) await reconcileStale(db, run.budgetId, 0);
  await update(db, run.id, { status: "interrupted", error: reason, finishedAt: new Date(), runnerId: null });
}

export async function runCaseRun(db: Database, pool: Pool, id: number, deps: CaseRunDeps): Promise<CaseRunStatus | "duplicate_delivery"> {
  const [run] = await db.select().from(caseRuns).where(eq(caseRuns.id, id));
  if (!run) throw new Error(`No case run ${id}.`);
  if (JOB_STOPS.includes(run.status as CaseRunStatus)) return run.status as CaseRunStatus;
  const runnerId = randomUUID();
  if (!(await claimRunner(db, id, runnerId))) return "duplicate_delivery";
  try {
    // Only adjudication spends money; retrieval is free and simply runs again.
    if (run.mode === "live" && run.status === "adjudicating") {
      await interruptCaseRun(db, run, "The worker stopped while this run was in progress. Completed findings are kept; a request in flight is counted in full in case it was billed. Resume to continue.");
      return "interrupted";
    }
    const beat = setInterval(() => void db.update(caseRuns).set({ runnerSeenAt: new Date() }).where(eq(caseRuns.id, id)).catch(() => undefined), 5000);
    try {
      return await runClaimed(db, pool, run, deps);
    } finally {
      clearInterval(beat);
    }
  } finally {
    await db.update(caseRuns).set({ runnerId: null }).where(and(eq(caseRuns.id, id), eq(caseRuns.runnerId, runnerId)));
  }
}

async function runClaimed(db: Database, pool: Pool, run: CaseRun, deps: CaseRunDeps): Promise<CaseRunStatus> {
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
  const model = run.mode === "mock" ? mockCaseModel() : deps.adjudicator(run);
  if (!model) {
    await update(db, run.id, { status: "blocked_credentials", error: "Live case runs need the analysis key and ALLOW_PAID_CALLS=true on this server. Nothing was sent.", finishedAt: new Date() });
    return "blocked_credentials";
  }
  await update(db, run.id, { status: "adjudicating", startedAt: run.startedAt ?? new Date(), finishedAt: null, error: null });
  await settleAbandoned(db, run, ledger.id); // this runner holds the run: anything in progress was left by a dead one
  const index = (ledger.settings as { itemIndex: ItemIndex }).itemIndex;
  const names = new Map((await db.select({ id: witnesses.id, name: witnesses.name }).from(witnesses).where(eq(witnesses.caseId, run.caseId))).map((w) => [w.id, w.name]));

  let failedInARow = 0;
  for (;;) {
    const [now] = await db.select({ cancel: caseRuns.cancelRequestedAt }).from(caseRuns).where(eq(caseRuns.id, run.id));
    if (now.cancel) return finish(db, run.id, ledger.id, "cancelled", "Cancelled. Completed findings are kept; packets not yet read stay pending.");
    if (deps.signal?.aborted) {
      await interruptCaseRun(db, run, "The worker shut down. Completed findings are kept. Resume to continue.");
      return "interrupted";
    }
    const [entry] = await claimNext(db, ledger.id, 1);
    if (!entry) break;
    const outcome = await adjudicateEntry(db, run, ledger.id, entry, index, names, model, deps);
    await db.update(caseRuns).set({ runnerSeenAt: new Date() }).where(eq(caseRuns.id, run.id));
    if (outcome.kind === "budget") return finish(db, run.id, ledger.id, "blocked_budget", outcome.message);
    if (outcome.kind === "failed") {
      if (++failedInARow >= MAX_CONSECUTIVE_FAILED_PACKETS) return finish(db, run.id, ledger.id, "failed", `${failedInARow} packets in a row failed; the last: ${outcome.message}`);
    } else failedInARow = 0;
  }
  return finish(db, run.id, ledger.id, null, null);
}

// Ends the run. With no explicit status, it is completed only when every packet was adjudicated in full.
async function finish(db: Database, runId: number, ledgerId: number, status: CaseRunStatus | null, error: string | null): Promise<CaseRunStatus> {
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
  const built = await buildCasePool(db, pool, run.caseId, { minilm: deps.minilm ?? "off" });
  if (run.sourceHash && run.sourceHash !== built.sourceHash) return "The case's stored testimony changed since this run started retrieval. Start a new run.";
  await update(db, run.id, { sourceHash: built.sourceHash, config: { ...(run.config as object), retrieval: built.settings, paths: built.paths, documents: built.documents } });
  const set = caseRunSetOf(run.id);
  const byKey = new Map(built.items.map((i) => [i.key, i]));
  const reasonOf = new Map<string, { status: "selected" | "uncovered" | "deferred"; reason: string | null }>();
  for (const p of built.packets.packets) for (const [a, b] of p.pairs) reasonOf.set(pairKey(a, b), { status: "selected", reason: null });
  for (const u of built.packets.uncovered) reasonOf.set(pairKey(u.a, u.b), { status: "uncovered", reason: `in no issue packet: ${u.reason}` });
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

  // Packets past 8 pairs or about 9,000 input tokens are split (retrieve/packetSplit.ts); every pair stays in one.
  const limits = deps.packetLimits ?? PACKET_LIMITS;
  const packets = splitPacketSet(built.packets, built.items, limits);
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
      settings: { screening: "off: every packet prioritized, baseline order", split: limits, splitFrom: Object.fromEntries(packets.packets.filter((p) => p.splitFrom).map((p) => [p.id, p.splitFrom])), oversize: packets.packets.filter((p) => p.oversize).map((p) => p.id), itemIndex }, poolPairs: built.triage.kept.length, uncovered: built.packets.uncovered,
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
  const sized = packets.packets.map((p) => ({ passageTokens: p.inputTokens - INSTRUCTION_TOKENS, pairs: p.pairs.length }));
  const expectedUsd = projectCost(sized);
  const largest = packets.packets.reduce((m, p) => Math.max(m, maxRequestCost(PACKET_MODEL, { inputTokens: inputTokenBound(p.inputTokens * 4), maxOutputTokens: maxOutputTokensFor(p.pairs.length) })), 0);
  const estimate = {
    packets: sized.length, listedPairs: sized.reduce((n, p) => n + p.pairs, 0), splitPackets: packets.packets.filter((p) => p.splitFrom).length, oversizePackets: packets.packets.filter((p) => p.oversize).length,
    expectedUsd: round2(expectedUsd), noCacheUsd: round2(projectCost(sized, false)), largestPacketWorstCaseUsd: round2(largest), recommendedBudgetUsd: Math.ceil((expectedUsd + largest) * 100) / 100,
    assumptions: COST_ASSUMPTIONS, note: "A projection from packet size and measured output per pair, not a measurement; the budget is a hard stop.",
  };
  await db.update(caseRuns).set({ progress: sql`${caseRuns.progress} || ${JSON.stringify({ estimate })}::jsonb`, updatedAt: new Date() }).where(eq(caseRuns.id, run.id));
  return (await ledgerOf(db, run.id))!;
}
const round2 = (x: number) => Math.round(x * 100) / 100;


type EntryOutcome = { kind: "done" | "incomplete" } | { kind: "budget" | "failed"; message: string };
type Entry = typeof screeningEntries.$inferSelect;

async function adjudicateEntry(db: Database, run: CaseRun, ledgerId: number, entry: Entry, index: ItemIndex, names: Map<number, string>, model: CasePacketModel, deps: CaseRunDeps): Promise<EntryOutcome> {
  const ids = entry.candidateIds ?? [];
  if (ids.length !== entry.pairs.length) return fail(db, ledgerId, entry, `the entry lists ${entry.pairs.length} pairs and ${ids.length} candidates`, false);
  const candidateOfPair = new Map(entry.pairs.map(([a, b], i) => [pairKey(a, b), ids[i]]));
  const pairOfCandidate = new Map(entry.pairs.map((p, i) => [ids[i], p]));

  // Passages from stored lines; an item whose stored lines changed or vanished is left out, its pairs excluded.
  const keys = [...new Set(entry.pairs.flat())];
  const items: FrozenItem[] = keys.map((k) => ({ key: k, ...index[k], witness: names.get(index[k].witnessId) ?? "", question: "", answer: "", context: "" }));
  const { passages, unresolved } = await resolvePassages(db, items, new Map(keys.map((k) => [index[k].document, index[k].depositionId])));
  const replies = { made: 0 };

  for (;;) {
    const answered = new Set((await db.select({ id: verdicts.candidateId }).from(verdicts).innerJoin(candidates, eq(candidates.id, verdicts.candidateId)).where(and(inArray(verdicts.candidateId, ids), eq(candidates.candidateSet, caseRunSetOf(run.id))))).map((r) => r.id));
    const excluded = new Set((await db.select({ id: candidates.id }).from(candidates).where(and(inArray(candidates.id, ids), eq(candidates.status, "excluded")))).map((r) => r.id));
    const remaining = ids.filter((c) => !answered.has(c) && !excluded.has(c));

    // A stored reply not yet turned into verdicts (the run stopped after paying for it): parse that.
    const stored = entry.llmCallId !== null && entry.requestId !== null ? await storedReply(db, entry.requestId, entry.llmCallId) : null;
    if (remaining.length === 0 && !stored) {
      await db.update(screeningEntries).set({ adjudicationStatus: "adjudicated", adjudicationRef: caseRunSetOf(run.id), unresolvedPairs: null, updatedAt: sql`now()` }).where(eq(screeningEntries.id, entry.id));
      return { kind: "done" };
    }
    const sendIds = stored ? stored.candidateIds : remaining;
    const built = buildIssuePacket({ id: entry.packetId, issue: "", items: keys, pairs: sendIds.map((c) => pairOfCandidate.get(c)!), inputTokens: 0 }, passages);
    const unbuilt = built.unbuilt.map((u) => ({ ...u, candidateId: candidateOfPair.get(pairKey(u.a, u.b))! }));
    if (unbuilt.length) {
      const why = (u: (typeof unbuilt)[number]) => `evidence could not be rebuilt from stored lines: ${u.reason}${unresolved.find((x) => u.reason.endsWith(x.key)) ? ` (${unresolved.find((x) => u.reason.endsWith(x.key))!.reason})` : ""}`;
      for (const u of unbuilt) await db.update(candidates).set({ status: "excluded", exclusionReason: why(u) }).where(eq(candidates.id, u.candidateId));
      if (stored) await db.update(screeningEntries).set({ llmCallId: null }).where(eq(screeningEntries.id, entry.id));
      entry = { ...entry, llmCallId: null };
      continue;
    }
    const packet = built.packet!;
    const sentIds = packet.pairs.map((_, i) => sendIds[i]);

    let text: string | null;
    let callId: number | null;
    let requestId: number;
    if (stored) {
      ({ text, callId, requestId } = { text: stored.text, callId: entry.llmCallId, requestId: entry.requestId! });
    } else {
      if (replies.made >= 1 + MAX_RECOVERY_ROUNDS) {
        const unresolvedPairs = remaining.map((c) => { const [a, b] = pairOfCandidate.get(c)!; return { a, b, status: "unanswered after the packet and one recovery request" }; });
        await db.update(screeningEntries).set({ adjudicationStatus: "incomplete", unresolvedPairs, adjudicationNote: `${remaining.length} of ${ids.length} pairs left without a verdict`, updatedAt: sql`now()` }).where(eq(screeningEntries.id, entry.id));
        return { kind: "incomplete" };
      }
      const call = await callModel(db, run, entry, packet, sentIds, model, deps);
      if (call.kind !== "reply") return call.kind === "budget" ? releaseForBudget(db, entry, call.message) : fail(db, ledgerId, entry, call.message, call.billable);
      replies.made++;
      ({ text, callId, requestId } = call);
      await db.update(screeningEntries).set({ attempts: sql`${screeningEntries.attempts} + 1`, requestId, llmCallId: callId, updatedAt: sql`now()` }).where(eq(screeningEntries.id, entry.id));
      deps.faults?.afterReplyRecorded?.(entry.packetId);
    }

    const parsed = parseVerdictsLenient(text, VERDICT_SCHEMAS["packet-v1"]);
    const verification = verifyPacketReply(packet, parsed);
    await persist(db, run, entry, packet, sentIds, verification, { model: model.model, promptVersion: model.promptVersion, effort: model.effort, callId: run.mode === "live" ? callId : null, requestId });
    entry = { ...entry, llmCallId: null, requestId };
  }
}

async function storedReply(db: Database, requestId: number, llmCallId: number) {
  const [req] = await db.select({ candidateIds: adjudicationRequests.candidateIds }).from(adjudicationRequests).where(eq(adjudicationRequests.id, requestId));
  const [call] = await db.select({ text: llmCalls.rawOutput }).from(llmCalls).where(eq(llmCalls.id, llmCallId));
  return req && call ? { candidateIds: req.candidateIds, text: call.text } : null;
}

// One reply for the packet: reserve its worst case, send, record, settle. Rate limits wait and retry a
// bounded number of times; any other failure ends the attempt, with whether it may have been billed.
async function callModel(db: Database, run: CaseRun, entry: Entry, packet: IssuePacket, sentIds: number[], model: CasePacketModel, deps: CaseRunDeps) {
  const live = run.mode === "live";
  const maxOutputTokens = maxOutputTokensFor(packet.pairs.length);
  const inputTokens = inputTokenBound(PACKET_SYSTEM_PROMPT.length + formatIssuePacket(packet).length);
  const maxCostUsd = live ? maxRequestCost(PACKET_MODEL, { inputTokens, maxOutputTokens }) : 0;
  const context = { candidateSet: caseRunSetOf(run.id), analysisId: null, strategy: "packet", maxConcurrency: 1 };
  for (let tries = 0; ; tries++) {
    let reservationId: number | null = null;
    if (live) {
      try {
        reservationId = await reserve(db, run.budgetId!, maxCostUsd, `${caseRunSetOf(run.id)} ${entry.packetId}`);
      } catch (e) {
        if (e instanceof BudgetExceeded) return { kind: "budget" as const, message: `Stopped before packet ${entry.packetId}: its worst case ($${maxCostUsd.toFixed(4)}) is more than the budget has left. Completed findings are kept; raise the budget and resume to continue.` };
        throw e;
      }
    }
    const requestId = await openRequest(db, context, { candidateIds: sentIds, model: model.model, promptVersion: model.promptVersion, estimatedInputTokens: inputTokens, maxOutputTokens, maxCostUsd, reservationId });
    deps.faults?.afterRequestSent?.(entry.packetId);
    try {
      const reply = await model.adjudicate(packet, { signal: deps.signal });
      // The reply is paid for: record it with its raw text before anything that could fail.
      let callId: number | null = null;
      if (live) {
        const call = await recordCall(db, { jobId: null, stage: "adjudication", model: reply.model, usage: reply.usage, attempt: tries + 1, items: packet.pairs.length, rawOutput: reply.text, effort: model.effort, latencyMs: reply.latencyMs });
        await settle(db, reservationId!, { id: call.id, costUsd: call.costUsd });
        callId = call.id;
      }
      await closeRequest(db, requestId, { status: reply.stopReason === "max_tokens" ? "partial" : "completed", llmCallId: callId, providerRequestId: reply.requestId ?? null, latencyMs: reply.latencyMs, errorKind: reply.stopReason === "max_tokens" ? "cut_off" : reply.stopReason === "refusal" ? "refused" : null });
      return { kind: "reply" as const, text: reply.text, callId, requestId };
    } catch (e) {
      const f = classifyFailure(e);
      if (reservationId !== null) await closeFailed(db, reservationId, e);
      await closeRequest(db, requestId, { status: f.status, errorKind: f.kind, error: (e instanceof Error ? e.message : String(e)).slice(0, 2000), retryAfterMs: f.retryAfterMs });
      if (f.status === "rate_limited" && tries < MAX_RATE_LIMIT_RETRIES) {
        await (deps.sleep ?? ((ms) => new Promise((ok) => setTimeout(ok, ms))))(f.retryAfterMs ?? 5_000);
        continue;
      }
      return { kind: "failed" as const, message: `${f.kind}: ${e instanceof Error ? e.message : String(e)}`, billable: live && f.billable };
    }
  }
}

async function releaseForBudget(db: Database, entry: Entry, message: string): Promise<EntryOutcome> {
  await db.update(screeningEntries).set({ adjudicationStatus: "not_started", adjudicationNote: "returned to the queue: budget", updatedAt: sql`now()` }).where(eq(screeningEntries.id, entry.id));
  return { kind: "budget", message };
}

async function fail(db: Database, ledgerId: number, entry: Entry, message: string, billable: boolean): Promise<EntryOutcome> {
  await markFailed(db, ledgerId, entry.packetId, message.slice(0, 2000));
  await db.update(screeningEntries).set({ failureBillable: billable }).where(eq(screeningEntries.id, entry.id));
  return { kind: "failed", message };
}

// Verdicts and findings for the answered pairs, in one transaction with clearing the stored-reply pointer.
// A candidate that already has a verdict in this run is skipped: nothing is written twice.
async function persist(db: Database, run: CaseRun, entry: Entry, packet: IssuePacket, sentIds: number[], v: ReturnType<typeof verifyPacketReply>, meta: { model: string; promptVersion: string; effort: string; callId: number | null; requestId: number }) {
  await db.transaction(async (tx) => {
    for (const [i, pair] of packet.pairs.entries()) {
      const pv = v.pairs.find((p) => p.pairId === pair.pairId);
      if (!pv || pv.status !== "answered" || !pv.verdict) continue;
      const candidateId = sentIds[i];
      const [locked] = await tx.select({ id: candidates.id }).from(candidates).where(eq(candidates.id, candidateId)).for("update");
      if (!locked) continue;
      const [has] = await tx.select({ id: verdicts.id }).from(verdicts).where(eq(verdicts.candidateId, candidateId)).limit(1);
      if (has) continue;
      const fields = assessPacketPair(packet, pv);
      const sides = [pair.a, pair.b].map((pid) => { const p = packet.passages.find((x) => x.id === pid)!; return { id: p.id, key: p.key, depositionId: p.depositionId, groupId: p.groupId, lineIds: p.lines.map((l) => l.id) }; });
      const [verdict] = await tx
        .insert(verdicts)
        .values({
          candidateId, model: meta.model, promptVersion: meta.promptVersion, effort: meta.effort, status: "valid", raw: JSON.stringify(pv.verdict), parsed: pv.verdict,
          consistencyIssues: pv.semantic?.consistencyIssues ?? [], packet: { contract: PACKET_PROMPT_VERSION, packetId: entry.packetId, pairId: pair.pairId, sides },
          origin: meta.callId !== null ? "model" : "fixture", llmCallId: meta.callId, requestId: meta.requestId,
        })
        .returning({ id: verdicts.id });
      if (fields) {
        await tx.insert(findings).values({
          caseId: run.caseId, candidateId, verdictId: verdict.id, type: fields.type, evidenceStatus: fields.evidenceStatus,
          // A side the packet verifier left unattributed (an abstention without a quote) has no level to show.
          attributionA: fields.attributionA ?? "not_assessed", attributionB: fields.attributionB ?? "not_assessed",
          score: fields.score, band: fields.band, unscoredReason: fields.unscoredReason, factors: fields.factors, caps: fields.caps,
          checks: { ...fields.checks, outcome: fields.outcome, caseRunId: run.id, origin: meta.callId !== null ? "model" : "mock" }, rubricVersion: fields.rubricVersion,
          priority: fields.priority, contextRequested: fields.contextRequested,
        });
      }
      await tx.update(candidates).set({ status: "adjudicated" }).where(eq(candidates.id, candidateId));
    }
    await tx.update(screeningEntries).set({ llmCallId: null, updatedAt: sql`now()` }).where(eq(screeningEntries.id, entry.id));
  });
}

// Creates a run, and a live run's budget. A live run created with `confirmed` (the CLI, after its own plan)
// may spend at once; otherwise it stops after retrieval for confirmCaseRun. The caller queues the job.
export async function createCaseRun(db: Database, caseId: number, { mode, budgetUsd = 0, confirmed = false }: { mode: "live" | "mock"; budgetUsd?: number; confirmed?: boolean }) {
  return db.transaction(async (tx) => {
    const config = { retrievalVersion: CASE_POOL_VERSION, screening: "off", packetLimits: PACKET_LIMITS, contract: PACKET_PROMPT_VERSION, verificationVersion: VERIFICATION_VERSION, rubricVersion: RUBRIC_V1.version, maxRecoveryRounds: MAX_RECOVERY_ROUNDS, maxRateLimitRetries: MAX_RATE_LIMIT_RETRIES };
    const live = mode === "live";
    const [row] = await tx
      .insert(caseRuns)
      .values({ caseId, mode, budgetUsd: live ? budgetUsd : 0, promptVersion: PACKET_PROMPT_VERSION, model: live ? PACKET_MODEL : MOCK_MODEL, effort: live ? PACKET_EFFORT : "mock", config, confirmedAt: live && confirmed ? new Date() : null })
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
export async function confirmCaseRun(db: Database, id: number, { budgetUsd }: { budgetUsd: number }): Promise<"queued" | "not_found" | "not_awaiting" | "no_budget"> {
  if (!(budgetUsd > 0)) return "no_budget";
  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(caseRuns).where(eq(caseRuns.id, id)).for("update");
    if (!run) return "not_found" as const;
    if (run.status !== "awaiting_confirmation" || run.mode !== "live") return "not_awaiting" as const;
    await tx.update(budgets).set({ limitUsd: budgetUsd }).where(eq(budgets.id, run.budgetId!));
    await tx.update(caseRuns).set({ budgetUsd, confirmedAt: new Date(), status: "queued", error: null, updatedAt: new Date() }).where(eq(caseRuns.id, id));
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
  const rows = await db.execute<{ status: string; entry: string | null; reason: string | null; n: number }>(sql`
    select c.status::text as status, e.adjudication_status as entry, split_part(c.deferred_reason, ':', 1) as reason, count(*)::int as n
    from candidates c left join screening_entries e on e.run_id = ${ledger?.id ?? 0} and c.id = any(e.candidate_ids)
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
  const lanes = await db.select({ type: findings.type, priority: findings.priority, scored: sql<boolean>`${findings.score} is not null`, n: sql<number>`count(*)::int` }).from(findings).innerJoin(candidates, eq(candidates.id, findings.candidateId)).where(eq(candidates.candidateSet, set)).groupBy(findings.type, findings.priority, sql`${findings.score} is not null`);
  // Requests by what is known about them: answered (a reply was recorded), failed and not billed (rejected,
  // or a released reservation), uncertain (may have been billed: counted in full, never retried automatically).
  const [req] = await db.execute<{ requests: number; answered: number; unbilled: number; uncertain: number; open: number; calls: number; cost: string | null; input: number; output: number }>(sql`
    select count(*)::int as requests,
      count(*) filter (where r.status in ('completed', 'partial'))::int as answered,
      count(*) filter (where r.status not in ('completed', 'partial', 'sent') and (b.status is null or b.status = 'released') and coalesce(r.error_kind, '') <> 'uncertain')::int as unbilled,
      count(*) filter (where r.status not in ('completed', 'partial', 'sent') and (b.status = 'uncertain' or r.error_kind = 'uncertain'))::int as uncertain,
      count(*) filter (where r.status = 'sent')::int as open,
      count(l.id)::int as calls, sum(l.cost_usd)::text as cost,
      coalesce(sum(l.input_tokens + l.cache_write_5m_tokens + l.cache_write_1h_tokens + l.cache_read_tokens), 0)::int as input, coalesce(sum(l.output_tokens), 0)::int as output
    from adjudication_requests r left join llm_calls l on l.id = r.llm_call_id left join budget_reservations b on b.id = r.reservation_id
    where r.candidate_set = ${set}`).then((r) => r.rows);
  const budget = run.budgetId ? await db.execute<{ limit_usd: string; spent_usd: string; reserved_usd: string }>(sql`select limit_usd, spent_usd, reserved_usd from budgets where id = ${run.budgetId}`).then((r) => r.rows[0]) : null;
  const ledgerCount = (s: string) => entries.find((r) => r.status === s)?.n ?? 0;
  const uncertainPackets = entries.reduce((n, r) => n + r.uncertain, 0);
  const state = coverageState(coverage);
  const reasons = [
    ...(run.status !== "completed" ? [`run ${run.status}${run.error ? `: ${run.error}` : ""}`] : []),
    ...(coverage.pending ? [`${coverage.pending} pairs not read yet`] : []),
    ...(coverage.incomplete ? [`${coverage.incomplete} pairs read but left without a verdict (incomplete or failed packets)`] : []),
    ...(uncertainPackets ? [`${uncertainPackets} packets failed with a request that may have been billed; retried only on request`] : []),
    ...(coverage.deferred ? [`${coverage.deferred} pairs deferred by retrieval triage, unread (${Object.entries(coverage.deferredByStage).map(([k, v]) => `${v} ${k}`).join(", ")})`] : []),
    ...(coverage.uncovered ? [`${coverage.uncovered} pairs in no packet, unread`] : []),
    ...(coverage.excluded ? [`${coverage.excluded} pairs whose evidence could not be rebuilt from stored lines`] : []),
  ];
  return {
    id: run.id, caseId: run.caseId, status: run.status as CaseRunStatus, mode: run.mode as "live" | "mock", error: run.error, model: run.model, promptVersion: run.promptVersion, effort: run.effort,
    config: run.config, sourceHash: run.sourceHash, createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt, updatedAt: run.updatedAt,
    confirmedAt: run.confirmedAt, cancelRequested: run.cancelRequestedAt !== null,
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
    findings: lanes,
    requests: { total: req.requests, answered: req.answered, failedNotBilled: req.unbilled, uncertain: req.uncertain, open: req.open },
    cost: { recordedCalls: req.calls, costUsd: req.cost === null ? 0 : Number(req.cost), inputTokens: req.input, outputTokens: req.output, budget: budget ? { limitUsd: Number(budget.limit_usd), spentUsd: Number(budget.spent_usd), reservedUsd: Number(budget.reserved_usd) } : null },
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
    .orderBy(asc(findings.id));
  const lineIds = [...new Set(rows.flatMap((r) => (r.v.packet as { sides: { lineIds: number[] }[] }).sides.flatMap((s) => s.lineIds)))];
  const stored = lineIds.length ? await db.execute<{ id: number; deposition_id: number; printed_page: number; line_no: number; raw_text: string }>(sql`select id, deposition_id, printed_page, line_no, raw_text from lines where id in (${sql.join(lineIds.map((x) => sql`${x}`), sql`, `)})`).then((r) => new Map(r.rows.map((l) => [Number(l.id), l]))) : new Map();
  const people = await db.execute<{ id: number; witness: string; witness_id: number; taken_on: string | null }>(sql`select d.id, w.name as witness, w.id as witness_id, d.taken_on from depositions d join witnesses w on w.id = d.witness_id where d.case_id = (select case_id from case_runs where id = ${id})`).then((r) => new Map(r.rows.map((d) => [Number(d.id), d])));
  const at = (l: { printed_page: number; line_no: number }) => `${l.printed_page}:${String(l.line_no).padStart(2, "0")}`;
  return rows.map(({ f, v }) => {
    const sides = (v.packet as { sides: { id: string; depositionId: number; lineIds: number[] }[] }).sides.map((s) => {
      const lines = s.lineIds.map((x) => stored.get(x)).filter((l) => l !== undefined);
      const d = people.get(s.depositionId);
      return { exchange: s.id, depositionId: s.depositionId, witnessId: d ? Number(d.witness_id) : null, witness: d?.witness ?? null, takenOn: d?.taken_on ?? null, range: lines.length ? `${at(lines[0])}–${at(lines[lines.length - 1])}` : null, lines: lines.map((l) => ({ id: Number(l.id), at: at(l), text: l.raw_text })) };
    });
    const checks = f.checks as { source?: { a?: { evidenceLineIds?: number[]; status?: string }; b?: { evidenceLineIds?: number[]; status?: string } }; outcome?: string };
    return {
      id: f.id, crossWitness: sides[0]?.witnessId !== sides[1]?.witnessId, type: f.type, priority: f.priority, score: f.score, band: f.band, unscoredReason: f.unscoredReason, evidenceStatus: f.evidenceStatus, reviewState: f.reviewState,
      // Code's verification: which stored lines each side's citation was found on.
      verification: { a: { status: checks.source?.a?.status ?? null, lineIds: checks.source?.a?.evidenceLineIds ?? [] }, b: { status: checks.source?.b?.status ?? null, lineIds: checks.source?.b?.evidenceLineIds ?? [] } },
      a: sides[0], b: sides[1],
      model: { origin: v.origin, model: v.model, promptVersion: v.promptVersion, outcome: checks.outcome ?? null, verdict: v.parsed },
    };
  });
}
