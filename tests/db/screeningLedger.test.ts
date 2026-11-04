// The deferred-evidence ledger (screen/ledger.ts) on hand-made screening results; no testimony, no model.
import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../server/src/db/client";
import { screeningEntries } from "../../server/src/db/schema";
import { SCREENING_CONTRACT_VERSION, type ScreeningResult } from "../../server/src/screen/contract";
import { claimNext, entryEvidence, extendBudget, ledgerSummary, markAdjudicated, markFailed, recordScreening, releaseInProgress, retryFailed, staleEntries, type ScreeningRunInput } from "../../server/src/screen/ledger";
import { openTestDatabase, TEST_DATABASE_URL, violation } from "./database";

const RUN: ScreeningRunInput = {
  corpus: "synthetic-v1", packetSetName: "packets-test", packetSetSha256: "p".repeat(64), poolSha256: "q".repeat(64), itemsSha256: "i".repeat(64),
  strategy: "test-strategy", strategyVersion: "1", budget: 2, settings: { k: 1 }, poolPairs: 9,
  uncovered: [{ a: "A#1-1", b: "B#9-9", reason: "over token bound" }, { a: "A#2-2", b: "B#8-8", reason: "over token bound" }],
};

const item = (key: string, session: string) => ({ key, sourceHash: `h-${key}`, session, witness: "W" });
function result(packetId: string, status: ScreeningResult["status"], rank: number | null, n: number, extra: Partial<ScreeningResult> = {}): ScreeningResult {
  const left = Array.from({ length: n }, (_, i) => item(`${packetId}-a${i}`, "S1"));
  const right = Array.from({ length: n }, (_, i) => item(`${packetId}-b${i}`, "S2"));
  return {
    contract: SCREENING_CONTRACT_VERSION, packetId, status, rank, priority: 10 - (rank ?? 9), signals: { sharedNames: n, crossSession: true },
    reason: status === "deferred" ? "below budget" : status, strategy: "test-strategy", strategyVersion: "1", sessions: ["S1", "S2"], witnesses: ["W"],
    items: [...left, ...right], pairs: left.map((l, i) => [l.key, right[i].key] as [string, string]),
    consolidatedInto: null, adjudication: "not_started", ...extra,
  };
}
// Ranks 1..4: P1, P2 prioritized; P3, P4 deferred; C1 consolidated into P1. Pairs: 1+2+1+1+2 = 7, plus 2 uncovered = 9.
const RESULTS = [
  result("P1", "prioritized", 1, 1),
  result("P2", "prioritized", 2, 2),
  result("P3", "deferred", 3, 1),
  result("P4", "deferred", 4, 1, { reason: "single shared name" }),
  result("C1", "consolidated", null, 2, { consolidatedInto: "P1" }),
];

describe.skipIf(!TEST_DATABASE_URL)("screening ledger (Postgres, hand-made results)", () => {
  let db: Database;
  let pool: Pool;
  let runId: number;

  beforeAll(async () => ({ db, pool } = await openTestDatabase()));
  afterAll(async () => pool.end());
  beforeEach(async () => {
    await db.execute(sql`truncate screening_runs restart identity cascade`);
    runId = await recordScreening(db, RUN, RESULTS);
  });

  it("records a run and summarizes it, with deferred counted as pending", async () => {
    const s = await ledgerSummary(db, runId);
    expect(s).toMatchObject({
      poolPairs: 9, packetedPairs: 7, uncoveredPairs: 2, uncoveredByReason: { "over token bound": 2 }, packets: 5, prioritized: 2, deferred: 2, consolidated: 1,
      adjudication: { not_started: 5, in_progress: 0, adjudicated: 0, failed: 0 }, pending: 5, deferredReasons: { "below budget": 1, "single shared name": 1 }, adjudicatedPairs: 0, pendingPairs: 7,
    });
    expect(await entryEvidence(db, runId, "P2")).toEqual({ items: RESULTS[1].items, pairs: RESULTS[1].pairs });
    expect(await entryEvidence(db, runId, "nope")).toBeNull();
  });

  it("rejects the whole run when one result is invalid or packet ids repeat", async () => {
    const before = (await db.select().from(screeningEntries)).length;
    const bad = { ...RESULTS[0], packetId: "X", confidence: 0.9 } as unknown as ScreeningResult;
    await expect(recordScreening(db, RUN, [result("Y", "prioritized", 1, 1), bad])).rejects.toThrow(/invalid/);
    await expect(recordScreening(db, RUN, [result("Y", "prioritized", 1, 1), result("Y", "deferred", 2, 1)])).rejects.toThrow(/repeats/);
    await expect(recordScreening(db, { ...RUN, poolPairs: RUN.poolPairs + 1 }, RESULTS)).rejects.toThrow(/pool/); // a pair accounted nowhere
    expect((await db.select().from(screeningEntries)).length).toBe(before);
    expect((await db.execute(sql`select count(*)::int as n from screening_runs`)).rows[0]).toEqual({ n: 1 });
  });

  it("enforces the consolidated, rank and status constraints in the database", async () => {
    const base = { runId, reason: "r", priority: 1, signals: {}, sessions: [], witnesses: [], items: [], pairs: [] };
    expect(await violation(db.insert(screeningEntries).values({ ...base, packetId: "Z1", rank: null, screenStatus: "prioritized" }))).toBe("screening_entries_consolidated_check");
    expect(await violation(db.insert(screeningEntries).values({ ...base, packetId: "Z2", rank: 5, screenStatus: "deferred", adjudicationStatus: "compatible" }))).toBe("screening_entries_adjudication_status_check");
    expect(await violation(db.insert(screeningEntries).values({ ...base, packetId: "P1", rank: 5, screenStatus: "deferred" }))).toBe("screening_entries_run_packet_unique");
    expect(await violation(db.execute(sql`delete from screening_runs where id = ${runId}`))).toBe("screening_entries_run_id_screening_runs_id_fk"); // entries are never deleted with their run
  });

  it("claims prioritized entries in rank order, and two concurrent claims never share a packet", async () => {
    await extendBudget(db, runId, 4); // four claimable entries
    const [a, b] = await Promise.all([claimNext(db, runId, 2), claimNext(db, runId, 2)]);
    const ids = [...a, ...b].map((e) => e.packetId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(["P1", "P2", "P3", "P4"]);
    for (const claim of [a, b]) expect(claim.map((e) => e.rank)).toEqual([...claim.map((e) => e.rank)].sort((x, y) => x! - y!));
    expect(await claimNext(db, runId, 2)).toEqual([]);
  });

  it("claims in rank order and stops at the budget", async () => {
    expect((await claimNext(db, runId, 1)).map((e) => e.packetId)).toEqual(["P1"]);
    expect((await claimNext(db, runId, 5)).map((e) => e.packetId)).toEqual(["P2"]);
    expect(await claimNext(db, runId, 5)).toEqual([]);
  });

  it("adjudicates a packet once, with its consolidated members following it", async () => {
    expect(await markAdjudicated(db, runId, "P1", "verdict:1")).toBe(false); // not claimed yet
    await claimNext(db, runId, 1);
    expect(await markAdjudicated(db, runId, "P1", "verdict:1")).toBe(true);
    expect(await markAdjudicated(db, runId, "P1", "verdict:2")).toBe(false);
    const rows = await db.select().from(screeningEntries);
    const by = (id: string) => rows.find((r) => r.packetId === id)!;
    expect([by("P1").adjudicationStatus, by("P1").adjudicationRef]).toEqual(["adjudicated", "verdict:1"]);
    expect([by("C1").adjudicationStatus, by("C1").adjudicationRef]).toEqual(["adjudicated", "via P1"]);
    const s = await ledgerSummary(db, runId);
    expect(s).toMatchObject({ pending: 3, adjudicatedPairs: 3, pendingPairs: 4, adjudication: { adjudicated: 2, not_started: 3 } });
  });

  it("returns a failed entry to the queue and keeps its note", async () => {
    await claimNext(db, runId, 1);
    expect(await markFailed(db, runId, "P2", "timeout")).toBe(false); // P2 is not in progress
    expect(await markFailed(db, runId, "P1", "timeout")).toBe(true);
    expect(await retryFailed(db, runId)).toBe(1);
    expect((await claimNext(db, runId, 1)).map((e) => [e.packetId, e.adjudicationNote])).toEqual([["P1", "timeout"]]);
  });

  it("resumes after an interrupted run: released claims are taken again, adjudicated ones never", async () => {
    await claimNext(db, runId, 2);
    expect(await markAdjudicated(db, runId, "P1", "req-1")).toBe(true);
    expect(await releaseInProgress(db, runId)).toBe(1); // P2 was claimed but never finished
    const again = await claimNext(db, runId, 5);
    expect(again.map((e) => e.packetId)).not.toContain("P1");
    expect(again[0]).toMatchObject({ packetId: "P2", adjudicationNote: "released after an interrupted run" });
  });

  it("extends the budget in rank order and never lowers it", async () => {
    expect(await extendBudget(db, runId, 3)).toBe(1);
    const p3 = (await db.select().from(screeningEntries)).find((r) => r.packetId === "P3")!;
    expect([p3.screenStatus, p3.reason]).toEqual(["prioritized", "budget extended to 3; below budget"]);
    expect((await ledgerSummary(db, runId)).deferred).toBe(1);
    await expect(extendBudget(db, runId, 2)).rejects.toThrow(/lower/);
    expect(await extendBudget(db, runId, 10)).toBe(1);
  });

  it("finds entries whose evidence changed since screening", async () => {
    const current = new Map(RESULTS.flatMap((r) => r.items.map((i) => [i.key, i.sourceHash] as const)));
    expect(await staleEntries(db, runId, current)).toEqual([]);
    current.set("P2-a1", "h-changed");
    current.delete("C1-b0");
    expect(await staleEntries(db, runId, current)).toEqual([{ packetId: "P2", changed: ["P2-a1"] }, { packetId: "C1", changed: ["C1-b0"] }]);
  });
});
