// A cross-witness analysis (one session of each of two witnesses) end to end, with a mock provider and
// no paid call: the API's checks and estimate, the request Opus is sent, verification and storage of findings with each side's witness,
// the refusal fallback to Fable, and deletion. See tests/db/database.ts for when these run.
import express from "express";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DiscoveryProvider, DiscoveryRequest, DiscoveryResult } from "../../server/src/adjudicate";
import { CROSS_DISCOVERY_MODEL, CROSS_FALLBACK_MODEL, CROSS_JSON_SCHEMA } from "../../server/src/adjudicate/discoverCross";
import { CROSS_SYSTEM_V2 } from "../../server/src/adjudicate/discoverCrossPrompt";
import { analysisFindings, analysisRoutes, caseRoutes, findingDetail } from "../../server/src/api";
import { deleteDeposition } from "../../server/src/api/remove";
import type { Database } from "../../server/src/db/client";
import { analyses, depositions, findings, lines } from "../../server/src/db/schema";
import { WEBB_SUITE, WHITFIELD_SUITE } from "../../server/src/eval/synthetic";
import { storeSessions } from "../../server/src/eval/syntheticStore";
import { createAnalysisQueues, runAnalysis, startBoss } from "../../server/src/jobs";
import { emptyTables, listen, openTestDatabase, TEST_DATABASE_URL } from "./database";

const USAGE = { input_tokens: 20000, output_tokens: 6000, output_tokens_details: { thinking_tokens: 5000 } };
const answer = (list: unknown[]) => JSON.stringify({ summary: { completion_status: "complete", limitations: [] }, findings: list });
const success = (text: string, model = CROSS_DISCOVERY_MODEL): DiscoveryResult => ({ type: "succeeded", message: { model, stop_reason: "end_turn", content: [{ type: "text", text }], usage: USAGE } as never });
const refusal: DiscoveryResult = { type: "succeeded", message: { model: CROSS_DISCOVERY_MODEL, stop_reason: "refusal", stop_details: { category: "x", explanation: "blocked" }, content: [], usage: USAGE } as never };

function mockProvider(results: DiscoveryResult[]) {
  const sent: DiscoveryRequest[] = [];
  const provider: DiscoveryProvider = {
    submit: async (r) => (sent.push(r), { batchId: `batch-${sent.length}` }),
    poll: async () => ({ ended: true, latencyMs: 1000 }),
    result: async (batchId) => results[Number(batchId.split("-")[1]) - 1],
    cancel: async () => undefined,
  };
  return { provider, sent };
}

describe.skipIf(!TEST_DATABASE_URL)("cross-witness analysis (Postgres, mock provider)", () => {
  let db: Database;
  let pool: Pool;
  let boss: PgBoss;
  let api: { url: string; close: () => Promise<void> };
  let caseId: number;
  let sessionsA: number[];
  let sessionsB: number[];
  // The two sessions compared, earlier first: the earlier session's witness is witness A.
  let first: { id: number; witness: string };
  let second: { id: number; witness: string };

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
    boss = await startBoss(TEST_DATABASE_URL!, { supervise: false });
    await createAnalysisQueues(boss, { retryDelay: 1 }); // no worker: the tests run the job themselves
    const app = express();
    app.use(express.json());
    app.use("/api", caseRoutes({ db }));
    app.use("/api", analysisRoutes({ db, pool, boss }));
    api = await listen(app);
  });
  afterAll(async () => {
    await api?.close();
    await boss?.stop({ graceful: false });
    await pool?.end();
  });
  beforeEach(async () => {
    await emptyTables(db);
    // Two witnesses of one case: Whitfield's sessions on side A, Webb's on side B.
    ({ depositionIds: sessionsA } = await storeSessions(db, WHITFIELD_SUITE));
    ({ depositionIds: sessionsB } = await storeSessions(db, { ...WEBB_SUITE, caseName: WHITFIELD_SUITE.caseName }));
    const [x, y] = await Promise.all([sessionsA[0], sessionsB[0]].map(async (id) => (await db.select().from(depositions).where(eq(depositions.id, id)))[0]));
    caseId = x.caseId;
    const named = (d: typeof x, witness: string) => ({ id: d.id, witness });
    [first, second] = (x.takenOn! <= y.takenOn! ? [named(x, WHITFIELD_SUITE.witness), named(y, WEBB_SUITE.witness)] : [named(y, WEBB_SUITE.witness), named(x, WHITFIELD_SUITE.witness)]);
  });

  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${api.url}/api${url}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const start = (over = {}) => call("POST", `/cases/${caseId}/analyses`, { depositionA: sessionsA[0], depositionB: sessionsB[0], mode: "live", ...over });
  async function finish(id: number, provider: DiscoveryProvider) {
    for (let i = 0; i < 8; i++) {
      const outcome = await runAnalysis(db, id, { liveAdjudicator: () => null, discovery: () => provider });
      if (outcome !== "polling") return outcome;
    }
    throw new Error("still polling");
  }
  // A real witness line of a session, cited and quoted as the model would.
  async function line(depositionId: number, nth = 0) {
    const rows = (await db.select().from(lines).where(eq(lines.depositionId, depositionId))).sort((x, y) => x.printedPage - y.printedPage || x.lineNo - y.lineNo);
    const l = rows.filter((r) => r.speakerRole === "witness" && r.rawText.replace(/^A\.\s*/, "").length > 10)[nth];
    return { citation: `${l.printedPage}:${String(l.lineNo).padStart(2, "0")}`, excerpt: l.rawText.replace(/^A\.\s*/, "") };
  }
  async function crossFinding(sessionA: string, depA: number, sessionB: string, depB: number, over = {}) {
    const [x, y] = [await line(depA), await line(depB)];
    return { finding_id: "F1", subject: "the meeting", classification: "direct_conflict", session_a: sessionA, citation_a: x.citation, excerpt_a: x.excerpt, basis_a: "personal_observation", session_b: sessionB, citation_b: y.citation, excerpt_b: y.excerpt, basis_b: "personal_observation", explanation: "e", missing_context: "", ...over };
  }

  it("refuses an example or hybrid run, or a session without its date, before anything is stored", async () => {
    expect((await start({ mode: "demo" })).status).toBe(400);
    expect((await start({ method: "hybrid" })).status).toBe(400);
    await db.update(depositions).set({ takenOn: null }).where(eq(depositions.id, sessionsB[0]));
    expect(await start()).toMatchObject({ status: 400, body: { code: "date_missing" } });
    expect(await db.select().from(analyses)).toEqual([]);
  });

  it("estimates two sessions of different witnesses at Opus's prices", async () => {
    const r = await call("GET", `/cases/${caseId}/estimate?a=${sessionsA[0]}&b=${sessionsB[0]}`);
    expect(r.status).toBe(200);
    expect(r.body.estimate).toMatchObject({ model: CROSS_DISCOVERY_MODEL, fits: true });
    expect(r.body.estimate.worstUsd).toBeGreaterThan(r.body.estimate.typicalUsd);
  });

  it("starts a cross-witness analysis of the two sessions, witness A's the earlier, and no second while it runs", async () => {
    const started = await start();
    expect(started.status).toBe(202);
    const view = started.body.analysis;
    expect(view).toMatchObject({ kind: "cross_witness", witnesses: { a: { name: first.witness }, b: { name: second.witness } } });
    expect(view.depositions.map((d: { id: number; side: string }) => [d.side, d.id])).toEqual([["A", first.id], ["B", second.id]]);
    expect(view.discovery.primaryModel).toBe(CROSS_DISCOVERY_MODEL);
    const again = await start();
    expect(again).toMatchObject({ status: 200, body: { created: false, analysis: { id: view.id } } });
  });

  it("sends Opus both sessions, then stores verified findings with each side's witness", async () => {
    const id = (await start()).body.analysis.id;
    const f = await crossFinding("A1", first.id, "B1", second.id);
    const { provider, sent } = mockProvider([success(answer([f]))]);
    expect(await finish(id, provider)).toBe("completed");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ model: CROSS_DISCOVERY_MODEL, system: CROSS_SYSTEM_V2, schema: CROSS_JSON_SCHEMA, maxOutputTokens: 64_000 });
    expect(sent[0].user).toContain(`Witness A: ${first.witness}`);
    expect(sent[0].user).toContain(`Witness B: ${second.witness}`);
    expect(sent[0].user.match(/<session label="/g)).toHaveLength(2); // only the two sessions chosen
    for (const label of ["A1", "B1"]) expect(sent[0].user).toContain(`<session label="${label}"`);

    const { groups } = await analysisFindings(db, id);
    const all = groups.flatMap((g) => g.findings);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ group: "contradictions", modelName: "Veridict's analysis", cross: { witnessA: first.witness, witnessB: second.witness } });
    const detail = (await findingDetail(db, all[0].id))!;
    expect(detail.a.deposition).toMatchObject({ id: first.id, witness: first.witness });
    expect(detail.b.deposition).toMatchObject({ id: second.id, witness: second.witness });
    expect(detail.cross).toMatchObject({ sessionA: "A1", sessionB: "B1", basisA: "personal_observation" });
    expect(detail.source.label).toMatch(/both witnesses' sessions/);
    expect(detail.a.lines.some((l) => l.highlighted)).toBe(true);
    const [row] = await db.select().from(findings);
    expect(row.rubricVersion).toBe("evidence-strength-cross-v1");
  });

  it("puts witness A's side first when the model cited them the other way round", async () => {
    const id = (await start()).body.analysis.id;
    const f = await crossFinding("B1", second.id, "A1", first.id);
    expect(await finish(id, mockProvider([success(answer([f]))]).provider)).toBe("completed");
    const [only] = (await analysisFindings(db, id)).groups.flatMap((g) => g.findings);
    const detail = (await findingDetail(db, only.id))!;
    expect(detail.a.deposition.witness).toBe(first.witness);
    expect(detail.b.deposition.witness).toBe(second.witness);
    expect(detail.cross).toMatchObject({ sessionA: "A1", sessionB: "B1" });
  });

  it("never shows two passages of one witness as a conflict between witnesses", async () => {
    const id = (await start()).body.analysis.id;
    const f = await crossFinding("A1", first.id, "A1", first.id); // both passages from witness A's session
    expect(await finish(id, mockProvider([success(answer([f]))]).provider)).toBe("completed");
    const result = await analysisFindings(db, id);
    expect(result.groups.flatMap((g) => g.findings)).toEqual([]);
    expect(result.notStored).toHaveLength(1); // listed as a proposal that couldn't be checked, never hidden
  });

  it("asks Fable once after a confirmed refusal, with the same prompt", async () => {
    const id = (await start()).body.analysis.id;
    const f = await crossFinding("A1", first.id, "B1", second.id);
    const { provider, sent } = mockProvider([refusal, success(answer([f]), CROSS_FALLBACK_MODEL)]);
    expect(await finish(id, provider)).toBe("completed");
    expect(sent.map((r) => r.model)).toEqual([CROSS_DISCOVERY_MODEL, CROSS_FALLBACK_MODEL]);
    expect(sent[1].system).toBe(CROSS_SYSTEM_V2);
    const [only] = (await analysisFindings(db, id)).groups.flatMap((g) => g.findings);
    expect(only.modelName).toBe("Veridict's second reading");
  });

  it("reports what each session's coverage was", async () => {
    const id = (await start()).body.analysis.id;
    await finish(id, mockProvider([success(answer([]))]).provider);
    const view = (await call("GET", `/analyses/${id}`)).body.analysis;
    expect(view.evidence.sessions.map((s: { depositionId: number }) => s.depositionId)).toEqual([first.id, second.id]);
  });

  it("is removed with either session it compared", async () => {
    const id = (await start()).body.analysis.id;
    await finish(id, mockProvider([success(answer([await crossFinding("A1", first.id, "B1", second.id)]))]).provider);
    const removed = await deleteDeposition(db, pool, second.id, "/nonexistent-uploads");
    expect(removed).toMatchObject({ outcome: "deleted", analyses: 1 });
    expect(await db.select().from(analyses).where(eq(analyses.id, id))).toEqual([]);
  });
});
