// Focused Analysis on packet-c3 (the default contract) on the synthetic Webb and Whitfield case: the same label-blind
// test model as packet-v1's mock run, its decisions re-encoded as packet-c3 replies (dismissal rows for its false
// positives, full verdicts otherwise). Proves the pipeline carries packet-c3 replies on both transports (verdicts,
// findings, scores, recovery of a missing verdict, dismissal quote checks), never that packet-c3 finds
// contradictions. No key, no network, no paid call.

import { asc, eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { maxOutputTokensFor, PACKET_MODEL } from "../../server/src/adjudicate/packetPrompt";
import type { Database } from "../../server/src/db/client";
import { adjudicationRequests, caseRuns, depositions } from "../../server/src/db/schema";
import { FakeBatchProvider } from "../../server/src/eval/mockPacketBatch";
import { mockCompactReply } from "../../server/src/eval/mockPacketModel";
import { WEBB_SUITE, WHITFIELD_SUITE } from "../../server/src/eval/synthetic";
import { storeSessions } from "../../server/src/eval/syntheticStore";
import { caseRunReport, caseRunSetOf, contractOf, createCaseRun, runCaseRun, type CasePacketModel, type CaseRunDeps } from "../../server/src/jobs/caseRun";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

describe.skipIf(!TEST_DATABASE_URL)("Focused Analysis with packet-c3 (test model)", () => {
  let db: Database;
  let pool: Pool;
  let caseId: number;
  let v1Run: number;
  const clock = { t: Date.now() };
  const plain: CaseRunDeps = { adjudicator: () => null, minilm: "off", sleep: async () => undefined };

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
    await emptyTables(db);
    await db.execute(sql`truncate evidence_migrations, evidence_quarantine, case_runs cascade`);
    await storeSessions(db, WEBB_SUITE);
    await storeSessions(db, { ...WHITFIELD_SUITE, caseName: WEBB_SUITE.caseName });
    [{ caseId }] = await db.select({ caseId: depositions.caseId }).from(depositions).limit(1);
    v1Run = (await createCaseRun(db, caseId, { mode: "mock", contract: "packet-v1" })).id;
    expect(await runCaseRun(db, pool, v1Run, plain)).toBe("completed");
  }, 120_000);
  afterAll(async () => { await pool?.end(); });

  // A stand-in packet-c3 model. fault: its first reply leaves one full verdict out, or dismisses with invented quotes.
  const c3Model = (fault?: "drop" | "badQuotes"): CasePacketModel & { requests: number; caps: (number | undefined)[] } => {
    const m = {
      model: PACKET_MODEL, effort: "medium", promptVersion: "packet-c3", requests: 0, caps: [] as (number | undefined)[],
      async adjudicate(packet: Parameters<CasePacketModel["adjudicate"]>[0], options?: { maxOutputTokens?: number }) {
        m.requests++;
        m.caps.push(options?.maxOutputTokens);
        const reply = JSON.parse(mockCompactReply(packet).text) as { screen: { quoteA: string; disposition: string }[]; verdicts: unknown[] };
        if (fault === "drop" && m.requests === 1) reply.verdicts = reply.verdicts.slice(1);
        if (fault === "badQuotes" && m.requests === 1) for (const r of reply.screen) if (r.disposition !== "verdict") r.quoteA = "invented words never testified";
        return { model: PACKET_MODEL, stopReason: "end_turn", usage: { input_tokens: 1000, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } as never, text: JSON.stringify(reply), latencyMs: 0, requestId: null };
      },
    };
    return m;
  };
  // Every read pair: its sides, its outcome, and its finding (type, score, evidence status) when it has one.
  const rows = async (id: number) => (await db.execute<{ k: string; outcome: string; f: string | null; dismissed: boolean; pv: string; contract: string }>(sql`
    select c.deposition_a || ':' || c.group_a || '|' || c.deposition_b || ':' || c.group_b as k, v.parsed->>'outcome' as outcome, v.prompt_version as pv, v.packet->>'contract' as contract,
      (v.parsed ? 'compactDismissal') as dismissed, case when f.id is null then null else f.type || ' ' || coalesce(f.score::text, '-') || ' ' || f.evidence_status || ' ' || f.priority end as f
    from candidates c join verdicts v on v.candidate_id = c.id left join findings f on f.verdict_id = v.id where c.candidate_set = ${caseRunSetOf(id)} order by 1`)).rows;
  const packetsOf = async (id: number) => (await db.execute<{ n: number }>(sql`select count(*)::int as n from screening_entries e join screening_runs s on s.id = e.run_id where s.case_run_id = ${id}`)).rows[0].n;
  // packet-c3 against packet-v1 on the same decisions: the same pairs, outcomes and findings; a dismissal has no finding.
  const expectSameAsV1 = async (id: number) => {
    const [v1, c3] = [await rows(v1Run), await rows(id)];
    expect(c3.map((r) => r.k)).toEqual(v1.map((r) => r.k));
    expect(c3.every((r) => r.pv === "packet-c3" && r.contract === "packet-c3")).toBe(true);
    for (const [i, r] of c3.entries()) {
      expect(r.outcome).toBe(v1[i].outcome);
      if (r.outcome === "false_positive") expect([r.dismissed, r.f]).toEqual([true, null]);
      else expect([r.dismissed, r.f]).toEqual([false, v1[i].f]);
    }
    expect(c3.some((r) => r.dismissed)).toBe(true);
    expect(c3.some((r) => !r.dismissed && r.f !== null)).toBe(true);
    const report = (await caseRunReport(db, id))!;
    expect(report.contract).toBe("packet-c3");
    expect(report.compact!.dismissed).toBe(c3.filter((r) => r.dismissed).length);
  };

  it("makes packet-c3 the default for a new run, and keeps a packet-v1 run on packet-v1", async () => {
    const run = (await createCaseRun(db, caseId, { mode: "mock" })).id;
    const [row] = await db.select().from(caseRuns).where(eq(caseRuns.id, run));
    expect([row.promptVersion, contractOf(row)]).toEqual(["packet-c3", "packet-c3"]);
    expect(await runCaseRun(db, pool, run, plain)).toBe("completed");
    await expectSameAsV1(run);
    const [old] = await db.select().from(caseRuns).where(eq(caseRuns.id, v1Run));
    expect(contractOf(old)).toBe("packet-v1");
    expect((await rows(v1Run)).every((r) => r.pv === "packet-v1" && r.contract === "packet-v1" && !r.dismissed)).toBe(true);
    expect((await caseRunReport(db, v1Run))!.compact).toBeNull();
  }, 180_000);

  it("Fast: sends packet-c3 at the Focused output cap, verifies and scores full verdicts, recovers a missing verdict", async () => {
    const model = c3Model("drop");
    const run = (await createCaseRun(db, caseId, { mode: "live", budgetUsd: 50, confirmed: true })).id;
    expect(await runCaseRun(db, pool, run, { ...plain, adjudicator: () => model })).toBe("completed");
    expect((await caseRunReport(db, run))!.coverageState).not.toBe("partial");
    await expectSameAsV1(run);
    expect(model.requests).toBe((await packetsOf(run)) + 1); // one recovery request for the verdict left out
    // No cap configured: packet-v1's default per pair, as on Economy, so the two transports send the same request. Sent = stored.
    const sent = await db.select({ max: adjudicationRequests.maxOutputTokens, n: sql<number>`cardinality(${adjudicationRequests.candidateIds})` }).from(adjudicationRequests).where(eq(adjudicationRequests.candidateSet, caseRunSetOf(run))).orderBy(asc(adjudicationRequests.id));
    expect(sent.map((r) => r.max)).toEqual(model.caps);
    expect(sent.every((r) => r.max === maxOutputTokensFor(r.n))).toBe(true);
  }, 180_000);

  it("Fast: a dismissal whose quotes aren't in the transcript is not accepted; the pair is asked again", async () => {
    const model = c3Model("badQuotes");
    const run = (await createCaseRun(db, caseId, { mode: "live", budgetUsd: 50, confirmed: true })).id;
    expect(await runCaseRun(db, pool, run, { ...plain, adjudicator: () => model })).toBe("completed");
    expect(model.requests).toBe((await packetsOf(run)) + 1);
    await expectSameAsV1(run);
  }, 180_000);

  it("Economy: sends packet-c3 through the batch transport and reaches the same verdicts and findings", async () => {
    const provider = new FakeBatchProvider({ model: PACKET_MODEL, processingMs: 1_000, now: () => clock.t });
    const standardThrows: CasePacketModel = { model: PACKET_MODEL, effort: "medium", promptVersion: "packet-c3", adjudicate: async () => { throw new Error("an economy run used the standard transport"); } };
    const deps: CaseRunDeps = { ...plain, adjudicator: () => standardThrows, batch: () => ({ provider, settings: { batchSize: 4, inFlight: 3 }, now: () => clock.t }) };
    const run = (await createCaseRun(db, caseId, { mode: "live", budgetUsd: 50, confirmed: true, execution: "batch" })).id;
    let out = "";
    for (let i = 0; i < 300 && (out = await runCaseRun(db, pool, run, deps)) === "polling"; i++) clock.t += 1_000;
    expect(out).toBe("completed");
    await expectSameAsV1(run);
    const calls = (await db.execute<{ n: number }>(sql`select count(*)::int as n from adjudication_requests r join llm_calls l on l.id = r.llm_call_id where r.candidate_set = ${caseRunSetOf(run)} and l.batch and r.prompt_version = 'packet-c3'`)).rows[0].n;
    expect(calls).toBe(await packetsOf(run));
  }, 180_000);
});
