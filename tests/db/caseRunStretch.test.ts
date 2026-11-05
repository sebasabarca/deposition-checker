// Whole-case runs with the experimental whole-stretch contract (stretch-v2) on the synthetic Webb and Whitfield
// case: Fast and Economy execution, accounting, crash recovery, and a correction while a run is pending. The test
// model and the fake batch provider only: this proves the pipeline carries stretch requests correctly, never that
// stretch-v2 finds contradictions. No key, no network, no paid call.

import { eq, sql } from "drizzle-orm";
import express from "express";
import type { PgBoss } from "pg-boss";
import { caseRunRoutes } from "../../server/src/api";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PACKET_MODEL, PACKET_PROMPT_VERSION } from "../../server/src/adjudicate/packetPrompt";
import { requestUnits, STRETCH_V2_PROMPT_VERSION } from "../../server/src/adjudicate/stretchPrompt";
import type { Database } from "../../server/src/db/client";
import { budgets, candidates, caseRuns, depositions, findings, llmCalls, screeningEntries, screeningRuns, verdicts } from "../../server/src/db/schema";
import { FakeBatchProvider } from "../../server/src/eval/mockPacketBatch";
import { WEBB_SUITE, WHITFIELD_SUITE } from "../../server/src/eval/synthetic";
import { storeSessions } from "../../server/src/eval/syntheticStore";
import { caseRunFindings, caseRunReport, caseRunSetOf, createCaseRun, mockCaseModel, resumeCaseRun, runCaseRun, type CasePacketModel, type CaseRunDeps } from "../../server/src/jobs/caseRun";
import { emptyTables, listen, openTestDatabase, TEST_DATABASE_URL } from "./database";

const STRETCH = STRETCH_V2_PROMPT_VERSION;

describe.skipIf(!TEST_DATABASE_URL)("whole-case runs with the stretch-v2 contract (test model and fake provider)", () => {
  let db: Database;
  let pool: Pool;
  let caseId: number;
  const clock = { t: Date.now() };

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
    await emptyTables(db);
    await db.execute(sql`truncate evidence_migrations, evidence_quarantine, case_runs cascade`);
    await storeSessions(db, WEBB_SUITE);
    await storeSessions(db, { ...WHITFIELD_SUITE, caseName: WEBB_SUITE.caseName });
    [{ caseId }] = await db.select({ caseId: depositions.caseId }).from(depositions).limit(1);
  }, 120_000);
  afterAll(async () => { await pool?.end(); });

  const plain: CaseRunDeps = { adjudicator: () => null, minilm: "off", sleep: async () => undefined };
  // Live runs priced as Sonnet, answered by the label-blind test model in the run's own contract.
  const priced = (contract: typeof STRETCH | typeof PACKET_PROMPT_VERSION, extra: Partial<CaseRunDeps> = {}): CaseRunDeps & { calls: string[] } => {
    const m = mockCaseModel(PACKET_MODEL, contract);
    const model: CasePacketModel = { ...m, effort: "medium" };
    return { ...plain, adjudicator: () => model, calls: m.calls, ...extra };
  };
  const fake = () => new FakeBatchProvider({ model: PACKET_MODEL, processingMs: 1_000, now: () => clock.t });
  const batchDeps = (p: FakeBatchProvider): CaseRunDeps => ({ ...plain, adjudicator: () => { throw new Error("an economy run used the standard transport"); }, batch: () => ({ provider: p, settings: { batchSize: 4, inFlight: 3 }, now: () => clock.t }) });
  const drive = async (id: number, d: CaseRunDeps) => {
    for (let i = 0; i < 300; i++) { const out = await runCaseRun(db, pool, id, d); if (out !== "polling") return out; clock.t += 1_000; }
    throw new Error("still polling");
  };
  // Every read pair: its sides, its stretch status (or packet-v1 outcome) and, when it has one, its finding.
  const fingerprint = async (id: number) => (await db.execute<{ k: string }>(sql`
    select c.deposition_a || ':' || c.group_a || '|' || c.deposition_b || ':' || c.group_b || ' ' ||
      coalesce(v.packet->>'stretchStatus', v.parsed->>'outcome', '') || ' ' || coalesce(f.type, '-') || ' ' || coalesce(f.score::text, '-') || ' ' || coalesce(f.evidence_status, '-') as k
    from candidates c join verdicts v on v.candidate_id = c.id left join findings f on f.verdict_id = v.id where c.candidate_set = ${caseRunSetOf(id)} order by 1`)).rows.map((r) => r.k);
  const flaggedKeys = async (id: number, types: string[]) => (await db.execute<{ k: string; t: string; s: string | null }>(sql`
    select c.deposition_a || ':' || c.group_a || '|' || c.deposition_b || ':' || c.group_b as k, f.type as t, f.score::text as s from findings f join verdicts v on v.id = f.verdict_id join candidates c on c.id = v.candidate_id
    where c.candidate_set = ${caseRunSetOf(id)} and f.type in (${sql.join(types.map((t) => sql`${t}`), sql`, `)}) order by 1`)).rows;
  const budgetOf = async (id: number) => { const [r] = await db.select({ b: caseRuns.budgetId }).from(caseRuns).where(eq(caseRuns.id, id)); return (await db.select().from(budgets).where(eq(budgets.id, r.b!)))[0]; };
  const callsOf = async (id: number) => (await db.execute<{ n: number; cost: string | null }>(sql`select count(*)::int as n, sum(l.cost_usd)::text as cost from adjudication_requests r join llm_calls l on l.id = r.llm_call_id where r.candidate_set = ${caseRunSetOf(id)}`)).rows[0];

  let packetRun = 0;
  let stretchRun = 0;
  it("a test-model stretch run reads every kept pair once, flags exactly the pairs packet-v1's test model calls direct, and shows no 'compatible' finding", async () => {
    packetRun = (await createCaseRun(db, caseId, { mode: "mock" })).id;
    expect(await runCaseRun(db, pool, packetRun, plain)).toBe("completed");
    stretchRun = (await createCaseRun(db, caseId, { mode: "mock", contract: STRETCH })).id;
    expect(await runCaseRun(db, pool, stretchRun, plain)).toBe("completed");
    const [run] = await db.select().from(caseRuns).where(eq(caseRuns.id, stretchRun));
    expect(run.promptVersion).toBe(STRETCH);
    expect((run.config as { contract: string }).contract).toBe(STRETCH);
    // The ledger holds stretch requests: every one shows its stretches' items (more than its pairs' ends).
    const [ledger] = await db.select().from(screeningRuns).where(eq(screeningRuns.caseRunId, stretchRun));
    expect((ledger.settings as { contract: string }).contract).toBe(STRETCH);
    const report = (await caseRunReport(db, stretchRun))!;
    expect(report.contract).toBe(STRETCH);
    expect(report.coverageState).not.toBe("partial");
    const selected = await db.$count(candidates, sql`${candidates.candidateSet} = ${caseRunSetOf(stretchRun)} and ${candidates.status} <> 'deferred'`);
    expect(await db.$count(verdicts, sql`${verdicts.candidateId} in (select id from candidates where candidate_set = ${caseRunSetOf(stretchRun)})`)).toBe(selected); // one verdict per read pair
    // The same pairs are flagged with the same verdict, verification and score as packet-v1's direct findings.
    const stretchFlags = await flaggedKeys(stretchRun, ["direct", "inferential", "needs_more_context"]);
    const packetDirect = await flaggedKeys(packetRun, ["direct"]);
    expect(stretchFlags.map((f) => f.k)).toEqual(packetDirect.map((p) => p.k)); // on this case: none, in both
    // Every pair packet-v1's test model called compatible is "no conflict identified" (read, not cleared), and every
    // abstention "unclear": the same pairs, never shown as findings.
    const packetTypes = Object.fromEntries((await db.execute<{ t: string; n: number }>(sql`select f.type as t, count(*)::int as n from findings f join verdicts v on v.id = f.verdict_id join candidates c on c.id = v.candidate_id where c.candidate_set = ${caseRunSetOf(packetRun)} group by 1`)).rows.map((r) => [r.t, r.n]));
    expect(report.stretch!.no_conflict_identified).toBe(packetTypes.false_positive);
    expect(report.stretch!.unclear).toBe(packetTypes.insufficient_evidence);
    // A pair with no conflict identified has a verdict and no finding: never in the compatible lane.
    expect((await flaggedKeys(stretchRun, ["false_positive", "insufficient_evidence"])).length).toBe(0);
    expect(report.stretch!.no_conflict_identified).toBeGreaterThan(0);
    expect(report.stretch!.flagged).toBe(stretchFlags.length);
    expect((await caseRunFindings(db, stretchRun)).every((f) => f.type !== "false_positive")).toBe(true);
    expect((await db.execute<{ n: number }>(sql`select count(*)::int as n from findings f join verdicts v on v.id = f.verdict_id join candidates c on c.id = v.candidate_id where c.candidate_set = ${caseRunSetOf(stretchRun)} and f.checks->>'contract' = ${STRETCH}`)).rows[0].n).toBe(stretchFlags.length);
  }, 180_000);

  it("flagged pairs become verified, scored findings with their stretch status, shown with their stored lines", async () => {
    // A scripted stand-in that reports every original pair as direct, quoting each side's answer line verbatim.
    let unpairedShown = 0; // exchanges a request shows between its pairs, beyond the pairs' own ends
    const flagAll: CasePacketModel = {
      model: PACKET_MODEL, effort: "mock", promptVersion: STRETCH,
      async adjudicate(packet) {
        const ends = new Set(packet.pairs.flatMap((p) => [p.a, p.b]));
        unpairedShown += requestUnits(packet).flatMap((u) => [...u.a, ...u.b]).filter((id) => !ends.has(id)).length;
        const answer = (id: string) => { const p = packet.passages.find((x) => x.id === id)!; return ([...p.lines].reverse().find((l) => l.role === "answer") ?? p.lines.at(-1)!).text.replace(/^\s*(?:A[.:]|THE WITNESS:)\s*/i, "").trim(); };
        const units = requestUnits(packet).map((u) => ({ unitId: u.unitId, findings: u.pairs.map((p) => ({ outcome: "direct", evidenceAId: p.a, evidenceBId: p.b, keyPhraseA: answer(p.a), keyPhraseB: answer(p.b), attributionA: "asserted", attributionB: "asserted", stanceA: "affirms", stanceB: "affirms", sameEvent: "yes", scopeAligned: "yes", conflictBasis: "explicit_negation", conflictSource: "cited_exchanges", explanation: "Scripted.", alternativeExplanation: null, alternativeSupport: null, contextUsed: [] })) }));
        const ledger = requestUnits(packet).flatMap((u) => u.pairs.map((p) => ({ pairId: p.pairId, status: "checked" })));
        return { model: PACKET_MODEL, stopReason: "end_turn", usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } as never, text: JSON.stringify({ units, ledger }), latencyMs: 0, requestId: null };
      },
    };
    const run = await createCaseRun(db, caseId, { mode: "live", budgetUsd: 50, confirmed: true, contract: STRETCH });
    expect(await runCaseRun(db, pool, run.id, { ...plain, adjudicator: () => flagAll })).toBe("completed");
    expect(unpairedShown).toBeGreaterThan(0); // the stretches carry the testimony between the pairs, not only their ends
    const report = (await caseRunReport(db, run.id))!;
    const read = report.stretch!.flagged + report.stretch!.flagged_unverified + report.stretch!.unclear + report.stretch!.no_conflict_identified;
    expect(report.stretch!.flagged).toBeGreaterThan(0);
    expect(report.stretch!.flagged + report.stretch!.flagged_unverified).toBe(read); // every pair flagged by the script
    const shown = await caseRunFindings(db, run.id);
    expect(shown.length).toBe(read);
    const verified = shown.filter((f) => f.verification.a.status === "verified" && f.verification.b.status === "verified");
    expect(verified.length).toBe(report.stretch!.flagged);
    // Scored, with stored lines; or, when a deterministic safeguard fired (verify/safeguards.ts, e.g. a no-recall
    // answer quoted as a contradiction), published unscored as needs context with the model's outcome kept.
    expect(verified.every((f) => f.a.lines.length > 0 && f.b.lines.length > 0 && (f.score !== null || (f.type === "insufficient_evidence" && f.priority === "needs_context" && f.model.outcome === "direct")))).toBe(true);
    expect(verified.some((f) => f.score !== null)).toBe(true);
    expect(shown.every((f) => Array.isArray(f.safeguards) && f.safeguards.every((g) => g.detail.length > 0))).toBe(true); // the API shows why a finding was moved
    expect(shown.filter((f) => f.score === null && f.type === "insufficient_evidence").every((f) => f.safeguards.length > 0 && f.model.outcome === "direct")).toBe(true);
    const guarded = (await db.execute<{ r: string }>(sql`select distinct jsonb_array_elements(f.checks->'safeguards')->>'rule' as r from findings f join verdicts v on v.id = f.verdict_id join candidates c on c.id = v.candidate_id where c.candidate_set = ${caseRunSetOf(run.id)}`)).rows.map((x) => x.r);
    expect(verified.filter((f) => f.score === null).length === 0 || guarded.length > 0).toBe(true);
    const checks = (await db.execute<{ c: { contract: string; stretch: { stretchStatus: string; unitId: string } } }>(sql`select f.checks as c from findings f join verdicts v on v.id = f.verdict_id join candidates c on c.id = v.candidate_id where c.candidate_set = ${caseRunSetOf(run.id)}`)).rows;
    expect(checks.every((r) => r.c.contract === STRETCH && /^U\d+$/.test(r.c.stretch.unitId) && ["flagged", "flagged_unverified"].includes(r.c.stretch.stretchStatus))).toBe(true);
  }, 180_000);

  it("Economy (fake Batch provider) gives the same reading as Fast for a stretch run", async () => {
    const run = await createCaseRun(db, caseId, { mode: "mock", contract: STRETCH, execution: "batch" });
    const p = fake();
    expect(await drive(run.id, batchDeps(p))).toBe("completed");
    expect(await fingerprint(run.id)).toEqual(await fingerprint(stretchRun));
    expect(Math.max(...p.sentPerPacket.values())).toBe(1);
    expect([...p.batches.values()].every((b) => b.requests.every((r) => r.contract === STRETCH))).toBe(true);
    const unpaired = [...p.batches.values()].flatMap((b) => b.requests).reduce((n, r) => { const ends = new Set(r.packet.pairs.flatMap((x) => [x.a, x.b])); return n + r.packet.passages.filter((x) => !ends.has(x.id)).length; }, 0);
    expect(unpaired).toBeGreaterThan(0); // Economy requests carry the in-between exchanges too
  }, 180_000);

  it("live (priced test model): Fast and Economy record every request once, settle every reservation, and Economy costs half", async () => {
    const fast = await createCaseRun(db, caseId, { mode: "live", budgetUsd: 50, confirmed: true, contract: STRETCH });
    const d = priced(STRETCH);
    expect(await runCaseRun(db, pool, fast.id, d)).toBe("completed");
    const requests = (await db.select({ n: sql<number>`count(*)::int` }).from(screeningEntries).innerJoin(screeningRuns, eq(screeningRuns.id, screeningEntries.runId)).where(eq(screeningRuns.caseRunId, fast.id)))[0].n;
    expect(d.calls.length).toBe(requests); // one request per stretch request: none repeated
    expect((await callsOf(fast.id)).n).toBe(requests);
    expect((await budgetOf(fast.id)).reservedUsd).toBeCloseTo(0, 9);
    expect(await fingerprint(fast.id)).toEqual(await fingerprint(stretchRun));

    const eco = await createCaseRun(db, caseId, { mode: "live", budgetUsd: 50, confirmed: true, contract: STRETCH, execution: "batch" });
    expect(await drive(eco.id, batchDeps(fake()))).toBe("completed");
    expect((await callsOf(eco.id)).n).toBe(requests);
    expect(Number((await callsOf(eco.id)).cost)).toBeCloseTo(Number((await callsOf(fast.id)).cost) / 2, 6);
    expect((await budgetOf(eco.id)).reservedUsd).toBeCloseTo(0, 9);
    expect(await fingerprint(eco.id)).toEqual(await fingerprint(stretchRun));
  }, 180_000);

  it("recovers from a crash after a paid stretch reply without paying for it again or duplicating findings", async () => {
    const run = await createCaseRun(db, caseId, { mode: "live", budgetUsd: 50, confirmed: true, contract: STRETCH });
    let crashed = false;
    const d = priced(STRETCH);
    const crashing = { ...d, faults: { afterReplyRecorded: () => { if (d.calls.length === 2 && !crashed) { crashed = true; throw new Error("worker killed"); } } } };
    await expect(runCaseRun(db, pool, run.id, crashing)).rejects.toThrow("worker killed");
    expect(await runCaseRun(db, pool, run.id, d)).toBe("interrupted"); // a live run never resumes spending on its own
    expect(await resumeCaseRun(db, run.id)).toBe("queued");
    expect(await runCaseRun(db, pool, run.id, d)).toBe("completed");
    expect(new Set(d.calls).size).toBe(d.calls.length); // the stored reply was parsed, not bought again
    expect(await fingerprint(run.id)).toEqual(await fingerprint(stretchRun));
    expect((await db.execute<{ n: number }>(sql`select count(*)::int as n from (select candidate_id from verdicts v join candidates c on c.id = v.candidate_id where c.candidate_set = ${caseRunSetOf(run.id)} group by 1 having count(*) > 1) x`)).rows[0].n).toBe(0);
  }, 180_000);

  it("a correction while a live stretch Economy run is pending: nothing published, every billed reply recorded, nothing left reserved", async () => {
    const p = new FakeBatchProvider({ model: PACKET_MODEL, processingMs: 60_000, cancelMs: 5_000, completeOnCancel: 1, now: () => clock.t });
    const run = await createCaseRun(db, caseId, { mode: "live", budgetUsd: 50, confirmed: true, contract: STRETCH, execution: "batch" });
    expect(await runCaseRun(db, pool, run.id, batchDeps(p))).toBe("polling");
    const verdictsBefore = await db.$count(verdicts);
    const findingsBefore = await db.$count(findings);
    const callsBefore = await db.$count(llmCalls);
    await db.update(depositions).set({ evidenceEpoch: sql`${depositions.evidenceEpoch} + 1` }).where(eq(depositions.caseId, caseId));
    expect(await runCaseRun(db, pool, run.id, batchDeps(p))).toBe("polling");
    expect((await db.select({ s: caseRuns.status }).from(caseRuns).where(eq(caseRuns.id, run.id)))[0].s).toBe("reconciling");
    clock.t += 10_000;
    expect(await drive(run.id, batchDeps(p))).toBe("failed");
    const billed = [...p.batches.values()].length; // completeOnCancel: the first request of each batch still ran
    expect((await db.$count(llmCalls)) - callsBefore).toBe(billed);
    expect((await callsOf(run.id)).n).toBe(billed);
    expect(await db.$count(verdicts)).toBe(verdictsBefore);
    expect(await db.$count(findings)).toBe(findingsBefore);
    expect((await budgetOf(run.id)).reservedUsd).toBeCloseTo(0, 9);
  }, 180_000);

  it("is offered over the API only where the server allows it, and a stretch run keeps its contract", async () => {
    const boss = { send: async () => null } as unknown as PgBoss;
    const app = express();
    app.use(express.json());
    let env: Record<string, string> = { ALLOW_TEST_RUNS: "true" };
    app.use("/api", (req, res, next) => caseRunRoutes({ db, boss, env })(req, res, next));
    const server = await listen(app);
    const post = (body: unknown) => fetch(`${server.url}/api/cases/${caseId}/case-runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      const off = await post({ mode: "mock", contract: "stretch-v2" });
      expect(off.status).toBe(409);
      expect((await off.json()).code).toBe("stretch_disabled");
      expect((await (await fetch(`${server.url}/api/cases/${caseId}/case-runs`)).json()).stretchAvailable).toBe(false);
      expect((await post({ mode: "mock", contract: "stretch-v9" })).status).toBe(400);
      env = { ALLOW_TEST_RUNS: "true", ALLOW_STRETCH_V2: "true" };
      expect((await (await fetch(`${server.url}/api/cases/${caseId}/case-runs`)).json()).stretchAvailable).toBe(true);
      const on = await post({ mode: "mock", contract: "stretch-v2" });
      expect(on.status).toBe(202);
      const run = (await on.json()).caseRun;
      expect(run).toMatchObject({ contract: "stretch-v2", stretchAvailable: true });
      expect(await runCaseRun(db, pool, run.id, plain)).toBe("completed");
      // Without a contract a run is packet-v1, as before.
      const plainRun = (await (await post({ mode: "mock" })).json()).caseRun;
      expect(plainRun.contract).toBe(PACKET_PROMPT_VERSION);
      expect(await runCaseRun(db, pool, plainRun.id, plain)).toBe("completed");
    } finally {
      await server.close();
    }
  }, 180_000);
});
