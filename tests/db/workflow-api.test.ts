// The product workflow over HTTP: cases, uploads, analyses and findings, with a real queue and the
// analysis worker running in demo mode. No model is ever called: live analyses get no adjudicator.
// See tests/db/database.ts for when these run. The upload-to-findings test also needs the real
// Ellison PDFs (scripts/spike/download.sh), and is skipped without them.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { eq, inArray } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { analysisRoutes, caseRoutes, depositionRoutes, reportData, reportRoutes } from "../../server/src/api";
import type { Database } from "../../server/src/db/client";
import { analyses, candidates, cases, depositions, lines, llmCalls } from "../../server/src/db/schema";
import { WEBB_SUITE } from "../../server/src/eval/synthetic";
import { storeSynthetic } from "../../server/src/eval/syntheticStore";
import { createAnalysisQueues, createIngestQueues, startAnalysisWorkers, startBoss, startIngestWorkers } from "../../server/src/jobs";
import { emptyTables, listen, openTestDatabase, TEST_DATABASE_URL } from "./database";
import { docx, para, rtf, run } from "../fixtures/transcripts/build";

const P3171 = "data/raw/ellison/p3171.pdf";
const P3173 = "data/raw/ellison/p3173.pdf";

describe.skipIf(!TEST_DATABASE_URL)("case, analysis and findings endpoints (Postgres, demo mode)", () => {
  let pool: Pool;
  let db: Database;
  let boss: PgBoss;
  let uploads: string;
  let api: { url: string; close: () => Promise<void> };

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
    boss = await startBoss(TEST_DATABASE_URL!, { supervise: true });
    await createIngestQueues(boss, { retryDelay: 1 });
    await createAnalysisQueues(boss, { retryDelay: 1 });
    uploads = mkdtempSync(path.join(tmpdir(), "uploads-"));
    await startIngestWorkers(boss, db, { uploadsDir: uploads, pollingIntervalSeconds: 0.5 });
    await startAnalysisWorkers(boss, db, { liveAdjudicator: () => null }, { pollingIntervalSeconds: 0.5 });
    const app = express();
    app.use(express.json());
    app.use("/api", caseRoutes({ db }));
    app.use("/api", analysisRoutes({ db, pool, boss }));
    app.use("/api", depositionRoutes({ db, pool, boss, uploadsDir: uploads }));
    app.use("/api", reportRoutes({ db }));
    api = await listen(app);
  });

  afterAll(async () => {
    await api?.close();
    await boss?.stop({ graceful: false });
    await pool?.end();
    if (uploads) rmSync(uploads, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await emptyTables(db);
  });

  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${api.url}/api${url}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const until = async <T,>(read: () => Promise<T>, done: (v: T) => boolean, ms = 30_000) => {
    const start = Date.now();
    for (;;) {
      const v = await read();
      if (done(v) || Date.now() - start > ms) return v;
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  it("creates, lists and shows cases, and adds witnesses", async () => {
    expect((await call("POST", "/cases", {})).status).toBe(400);
    const created = await call("POST", "/cases", { name: "U.S. v. Oracle", witness: "Lawrence Ellison" });
    expect(created.status).toBe(201);
    expect(created.body.witnesses.map((w: { name: string }) => w.name)).toEqual(["Lawrence Ellison"]);
    const id = created.body.case.id;
    expect((await call("POST", `/cases/${id}/witnesses`, { name: "Safra Catz" })).status).toBe(201);
    expect((await call("POST", `/cases/${id}/witnesses`, { name: "Safra Catz" })).status).toBe(409);
    const list = await call("GET", "/cases");
    expect(list.body.cases).toEqual([expect.objectContaining({ id, name: "U.S. v. Oracle", depositions: 0, witnesses: 2, findings: 0, lastAnalysis: null })]);
    expect((await call("GET", "/cases/999999")).status).toBe(404);
    expect((await call("GET", "/cases/abc")).status).toBe(400);
  });

  it("keeps an upload's original filename for display, never as a path", async () => {
    const { body } = await call("POST", "/cases", { name: "Case" });
    const pdf = new TextEncoder().encode("%PDF-1.4\nnot readable\n%%EOF\n");
    const res = await fetch(`${api.url}/api/cases/${body.case.id}/depositions?witness=W&filename=${encodeURIComponent("C:\\docs\\../Ellison Day 1.pdf")}`, { method: "POST", body: pdf });
    expect(res.status).toBe(202);
    expect((await res.json()).deposition.originalFilename).toBe("Ellison Day 1.pdf");
  });

  it("reads RTF and Word uploads in the worker, recognises a repeat upload, and refuses .ptx with what to ask for", async () => {
    const { body } = await call("POST", "/cases", { name: "Formats" });
    const upload = (data: Uint8Array, filename: string) => fetch(`${api.url}/api/cases/${body.case.id}/depositions?witness=Avery&filename=${encodeURIComponent(filename)}`, { method: "POST", body: Buffer.from(data) });
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `${String(i + 1).padStart(2)}  ${i % 2 ? "A.  Yes." : "Q.  Did you?"}`);
    const files = {
      "day1.rtf": rtf(lines(4).map((l) => `${l}\\par`).join("\n")),
      "day2.docx": docx(lines(4).map((l) => para(run(l))).join("")),
    };
    for (const [name, data] of Object.entries(files)) {
      const first = await upload(data, name);
      expect(first.status).toBe(202);
      const d = (await first.json()).deposition;
      expect(d.sourceFormat).toBe(name.split(".")[1]);
      const done = await until(() => call("GET", `/depositions/${d.id}`), (r) => r.body.deposition.status !== "processing");
      expect(done.body.deposition).toMatchObject({ status: "ready", pageCount: 1, stored: { lines: 4 } });
      const page = (await call("GET", `/depositions/${d.id}/lines?page=1`)).body;
      expect(page.lines.map((l: { text: string }) => l.text)).toEqual(["Q.  Did you?", "A.  Yes.", "Q.  Did you?", "A.  Yes."]);
      // The same file again is the same deposition: no second parse, no second set of lines.
      const again = await upload(data, name);
      expect(again.status).toBe(200);
      expect((await again.json()).deposition.id).toBe(d.id);
      const original = await fetch(`${api.url}/api/depositions/${d.id}/pdf`);
      expect(original.headers.get("content-disposition")).toBe("attachment");
    }
    const ptx = await upload(new TextEncoder().encode("anything"), "Avery 2024-03-07.ptx");
    expect(ptx.status).toBe(415);
    expect(await ptx.json()).toMatchObject({ code: "unsupported_format", error: expect.stringMatching(/E-Transcript.*ASCII/) });
    expect((await call("GET", `/cases/${body.case.id}`)).body.depositions).toHaveLength(2);
  });

  it("validates analysis requests and never queues a duplicate", async () => {
    const ids = await storeSynthetic(db, WEBB_SUITE);
    void ids;
    const docs = await db.select().from(depositions).orderBy(depositions.id);
    const caseId = docs[0].caseId;
    expect((await call("POST", `/cases/${caseId}/analyses`, { depositionA: docs[0].id, depositionB: docs[0].id })).status).toBe(400);
    expect((await call("POST", `/cases/${caseId}/analyses`, { depositionA: docs[0].id, depositionB: 999999 })).status).toBe(404);
    expect((await call("POST", `/cases/${caseId}/analyses`, { depositionA: docs[0].id, depositionB: docs[1].id, budgetUsd: 500 })).status).toBe(400);
    const [other] = await db.insert(cases).values({ orgId: (await db.select().from(cases))[0].orgId, name: "Other" }).returning();
    expect((await call("POST", `/cases/${other.id}/analyses`, { depositionA: docs[0].id, depositionB: docs[1].id })).status).toBe(404);

    const first = await call("POST", `/cases/${caseId}/analyses`, { depositionA: docs[1].id, depositionB: docs[0].id });
    expect(first.status).toBe(202);
    expect(first.body.analysis).toMatchObject({ mode: "demo", depositions: [expect.objectContaining({ id: docs[0].id }), expect.objectContaining({ id: docs[1].id })] });
    const again = await call("POST", `/cases/${caseId}/analyses`, { depositionA: docs[0].id, depositionB: docs[1].id });
    if (again.body.analysis.status !== "completed") {
      expect(again.status).toBe(200);
      expect(again.body.analysis.id).toBe(first.body.analysis.id);
    }
  });

  it("runs a demo analysis in the worker and serves grouped findings with verbatim testimony side by side", async () => {
    await storeSynthetic(db, WEBB_SUITE);
    const docs = await db.select().from(depositions).orderBy(depositions.id);
    const started = await call("POST", `/cases/${docs[0].caseId}/analyses`, { depositionA: docs[0].id, depositionB: docs[1].id, mode: "demo" });
    const id = started.body.analysis.id;
    const done = await until(() => call("GET", `/analyses/${id}`), (r) => r.body.analysis.status === "completed");
    expect(done.body.analysis).toMatchObject({ status: "completed", mode: "demo", cost: { calls: 0, actualUsd: 0 } });
    expect(done.body.analysis.progress).toMatchObject({ fixture: 5, replayed: 0, findings: 5 });

    const { body } = await call("GET", `/analyses/${id}/findings`);
    expect(body.groups.map((g: { group: string }) => g.group)).toEqual(["contradictions", "needs_context", "compatible", "unverified"]);
    const all = body.groups.flatMap((g: { findings: unknown[] }) => g.findings);
    expect(all).toHaveLength(5);
    expect(all.every((f: { source: string }) => f.source === "fixture")).toBe(true);
    for (const g of body.groups) for (const f of g.findings) expect(f.group).toBe(g.group);

    const detail = (await call("GET", `/findings/${all[0].id}`)).body.finding;
    expect(detail.source).toMatchObject({ kind: "fixture", label: expect.stringMatching(/Not produced by a model/) });
    for (const side of [detail.a, detail.b]) {
      expect(side.lines.length).toBeGreaterThan(0);
      expect(side.lines.some((l: { highlighted: boolean }) => l.highlighted)).toBe(true);
      // Every line shown is the stored transcript line, verbatim, at its stored page:line.
      const stored = await db.select().from(lines).where(inArray(lines.id, side.lines.map((l: { id: number }) => l.id)));
      for (const l of side.lines) {
        const s = stored.find((x) => x.id === l.id)!;
        expect(l.text).toBe(s.rawText);
        expect(l.ref).toBe(`${s.printedPage}:${String(s.lineNo).padStart(2, "0")}`);
      }
    }
    expect((await call("GET", "/findings/999999")).status).toBe(404);
    const caseView = await call("GET", `/cases/${docs[0].caseId}`);
    expect(caseView.body.analyses[0]).toMatchObject({ id, status: "completed" });
    expect(await db.$count(llmCalls)).toBe(0);

    // The cross-case screens read all of this in one response, with each finding's analysis and case.
    const ws = (await call("GET", "/workspace")).body;
    expect(ws.cases).toHaveLength(1);
    expect(ws.details[0].case.id).toBe(docs[0].caseId);
    expect(ws.analyses.map((a: { id: number }) => a.id)).toEqual([id]);
    expect(ws.findings).toHaveLength(5);
    expect(ws.findings[0]).toMatchObject({ analysisId: id, caseName: ws.cases[0].name });
  });

  it("blocks a live analysis without credentials, visibly, and resumes only blocked or failed ones", async () => {
    await storeSynthetic(db, WEBB_SUITE);
    const docs = await db.select().from(depositions).orderBy(depositions.id);
    const started = await call("POST", `/cases/${docs[0].caseId}/analyses`, { depositionA: docs[0].id, depositionB: docs[1].id, mode: "live" });
    const id = started.body.analysis.id;
    const blocked = await until(() => call("GET", `/analyses/${id}`), (r) => r.body.analysis.status === "blocked_credentials");
    expect(blocked.body.analysis).toMatchObject({ status: "blocked_credentials", error: expect.stringMatching(/Nothing was sent/) });
    expect((await call("POST", `/analyses/${id}/resume`, { budgetUsd: 1 })).status).toBe(400); // lower than $3
    expect((await call("POST", `/analyses/${id}/resume`, {})).status).toBe(202);
    await until(() => call("GET", `/analyses/${id}`), (r) => r.body.analysis.status === "blocked_credentials");
    const demo = await call("POST", `/cases/${docs[0].caseId}/analyses`, { depositionA: docs[0].id, depositionB: docs[1].id });
    await until(() => call("GET", `/analyses/${demo.body.analysis.id}`), (r) => r.body.analysis.status === "completed");
    expect((await call("POST", `/analyses/${demo.body.analysis.id}/resume`, {})).status).toBe(409);
    expect(await db.$count(llmCalls)).toBe(0);
  });

  it.skipIf(!existsSync(P3171) || !existsSync(P3173))(
    "end to end: create a case, upload two real PDFs, parse them, analyse, and read the result",
    async () => {
      const kase = (await call("POST", "/cases", { name: "U.S. v. Oracle" })).body.case;
      const upload = async (file: string, takenOn?: string) => {
        const res = await fetch(`${api.url}/api/cases/${kase.id}/depositions?witness=Lawrence%20Ellison${takenOn ? `&takenOn=${takenOn}` : ""}&filename=${path.basename(file)}`, { method: "POST", body: new Uint8Array(readFileSync(file)) });
        return (await res.json()).deposition;
      };
      const a = await upload(P3171, "2004-01-20");
      const b = await upload(P3173);
      const duplicate = await fetch(`${api.url}/api/cases/${kase.id}/depositions?witness=Lawrence%20Ellison`, { method: "POST", body: new Uint8Array(readFileSync(P3171)) });
      expect(duplicate.status).toBe(200);
      for (const d of [a, b]) {
        const read = await until(() => call("GET", `/depositions/${d.id}`), (r) => r.body.deposition.status !== "processing", 180_000);
        expect(read.body.deposition.status).toBe("ready");
      }
      // No check until both sessions have a date: the dates decide which testimony came first.
      const undated = await call("POST", `/cases/${kase.id}/analyses`, { depositionA: a.id, depositionB: b.id, maxCandidates: 30 });
      expect([undated.status, undated.body.code]).toEqual([400, "date_missing"]);
      expect((await call("PATCH", `/depositions/${b.id}`, { takenOn: "2004-01-21" })).status).toBe(200);
      const started = await call("POST", `/cases/${kase.id}/analyses`, { depositionA: a.id, depositionB: b.id, maxCandidates: 30 });
      const done = await until(() => call("GET", `/analyses/${started.body.analysis.id}`), (r) => !["queued", "parsing", "retrieving", "adjudicating"].includes(r.body.analysis.status), 120_000);
      expect(done.body.analysis.status).toBe("completed");
      // A fresh database has no stored model verdicts to replay: every candidate is counted, none invented.
      expect(done.body.analysis.progress).toMatchObject({ candidates: { selected: 30 }, withoutVerdict: 30, findings: 0 });
      const view = (await call("GET", `/cases/${kase.id}`)).body;
      expect(view.depositions.map((d: { originalFilename: string }) => d.originalFilename)).toEqual(["p3171.pdf", "p3173.pdf"]);
      expect(await db.$count(llmCalls)).toBe(0);
    },
    300_000,
  );

  it("starts an analysis with a strategy, cancels one that hasn't started, and resumes it", async () => {
    const stored = await storeSynthetic(db, WEBB_SUITE);
    const [c] = await db.select().from(candidates).where(eq(candidates.id, [...stored.values()][0]));
    const [d] = await db.select().from(depositions).where(eq(depositions.id, c.depositionA));
    await boss.offWork("run-analysis");
    const start = await call("POST", `/cases/${d.caseId}/analyses`, { depositionA: c.depositionA, depositionB: c.depositionB, mode: "live", budgetUsd: 1 });
    expect(start.status).toBe(202);
    const a = start.body.analysis;
    expect([a.mode, a.strategy, a.candidatesPerRequest, a.maxConcurrency, a.promptVersion]).toEqual(["live", "C", 1, 10, "discover-v1"]);
    expect(a.retrieval).toBe("direct_fable"); // the default method for a live analysis
    expect((await call("POST", `/cases/${d.caseId}/analyses`, { depositionA: c.depositionA, depositionB: c.depositionB, mode: "demo", method: "direct_fable" })).status).toBe(400);
    const cancelled = await call("POST", `/analyses/${a.id}/cancel`, {});
    expect(cancelled.status).toBe(202);
    expect(cancelled.body.analysis.status).toBe("cancelled");
    expect((await call("POST", `/analyses/${a.id}/cancel`, {})).status).toBe(409);
    const resumed = await call("POST", `/analyses/${a.id}/resume`, { retryInvalid: true });
    expect(resumed.status).toBe(202);
    expect(resumed.body.analysis.status).toBe("queued");
    expect(resumed.body.analysis.cancelRequested).toBe(false);
    await startAnalysisWorkers(boss, db, { liveAdjudicator: () => null }, { pollingIntervalSeconds: 0.5 });
  });

  it("saves, returns and clears a review decision, and counts what needs one", async () => {
    const stored = await storeSynthetic(db, WEBB_SUITE);
    const [c] = await db.select().from(candidates).where(eq(candidates.id, [...stored.values()][0]));
    const [d] = await db.select().from(depositions).where(eq(depositions.id, c.depositionA));
    const started = await call("POST", `/cases/${d.caseId}/analyses`, { depositionA: c.depositionA, depositionB: c.depositionB });
    let view = started.body.analysis;
    for (let i = 0; i < 100 && view.status !== "completed"; i++) {
      await new Promise((done) => setTimeout(done, 100));
      view = (await call("GET", `/analyses/${view.id}`)).body.analysis;
    }
    const open = (await call("GET", `/analyses/${view.id}/findings`)).body.groups.flatMap((g: { findings: { id: number; group: string }[] }) => g.findings).find((f: { group: string }) => f.group === "contradictions");
    const needed = (await call("GET", "/cases")).body.cases[0].needsReview;
    expect(needed).toBeGreaterThan(0);
    expect((await call("PATCH", `/findings/${open.id}/review`, { decision: "bad" })).status).toBe(400);
    expect((await call("PATCH", "/findings/999999/review", { decision: "dismissed" })).status).toBe(404);
    const saved = await call("PATCH", `/findings/${open.id}/review`, { decision: "dismissed", note: "Not material" });
    expect(saved.body.review).toMatchObject({ reviewState: "dismissed", reviewNote: "Not material" });
    expect((await call("GET", `/findings/${open.id}`)).body.finding).toMatchObject({ reviewState: "dismissed", reviewNote: "Not material" });
    expect((await call("GET", "/cases")).body.cases[0].needsReview).toBe(needed - 1);
    await call("PATCH", `/findings/${open.id}/review`, { decision: null });
    expect((await call("GET", `/findings/${open.id}`)).body.finding).toMatchObject({ reviewState: "unreviewed", reviewNote: null, reviewedAt: null });
  });

  it("downloads the kept findings as a PDF, for one analysis or the whole case", async () => {
    await storeSynthetic(db, WEBB_SUITE);
    const docs = await db.select().from(depositions).orderBy(depositions.id);
    const caseId = docs[0].caseId;
    const started = await call("POST", `/cases/${caseId}/analyses`, { depositionA: docs[0].id, depositionB: docs[1].id, mode: "demo" });
    const id = started.body.analysis.id;
    await until(() => call("GET", `/analyses/${id}`), (r) => r.body.analysis.status === "completed");
    const [f] = (await call("GET", `/analyses/${id}/findings`)).body.groups.flatMap((g: { findings: { id: number }[] }) => g.findings);
    await call("PATCH", `/findings/${f.id}/review`, { decision: "confirmed", note: "Ask about the date" });

    const data = await reportData(db, caseId, [id], false);
    expect(data).toMatchObject({ kept: 1, entries: [expect.objectContaining({ id: f.id, reviewNote: "Ask about the date" })] });
    expect(data!.covered).toHaveLength(1);
    expect((await reportData(db, caseId, null, true))!.entries.length).toBeGreaterThanOrEqual(1);

    for (const q of [`?analyses=${id}`, "", "?context=1"]) {
      const res = await fetch(`${api.url}/api/cases/${caseId}/report.pdf${q}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="Veridict report - /);
      expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
    }
    // An analysis of another case, or one that isn't finished, isn't reported.
    expect((await fetch(`${api.url}/api/cases/${caseId}/report.pdf?analyses=999999`)).status).toBe(404);
    expect((await fetch(`${api.url}/api/cases/${caseId}/report.pdf?analyses=x`)).status).toBe(400);
  });

  it("deletes a deposition with its analyses and findings, refuses while it is being checked, and deletes a case", async () => {
    await storeSynthetic(db, WEBB_SUITE);
    const docs = await db.select().from(depositions).orderBy(depositions.id);
    const caseId = docs[0].caseId;
    const started = await call("POST", `/cases/${caseId}/analyses`, { depositionA: docs[0].id, depositionB: docs[1].id, mode: "demo" });
    const id = started.body.analysis.id;
    // Held as running: deletion must wait for the check, so no job loses its rows.
    await db.update(analyses).set({ status: "adjudicating" }).where(eq(analyses.id, id));
    expect(await call("DELETE", `/depositions/${docs[0].id}`)).toMatchObject({ status: 409, body: { analyses: [id] } });
    expect((await call("DELETE", `/cases/${caseId}`)).status).toBe(409);
    await db.update(analyses).set({ status: "completed" }).where(eq(analyses.id, id));

    expect(await call("DELETE", `/depositions/${docs[0].id}`)).toMatchObject({ status: 200, body: { deleted: { depositions: 1, analyses: 1 } } });
    expect((await call("GET", `/depositions/${docs[0].id}`)).status).toBe(404);
    expect((await call("GET", `/analyses/${id}`)).status).toBe(404);
    expect(await db.$count(lines, eq(lines.depositionId, docs[0].id))).toBe(0);
    expect(await db.$count(candidates, eq(candidates.depositionA, docs[0].id))).toBe(0);
    expect((await call("GET", `/depositions/${docs[1].id}`)).status).toBe(200);
    expect((await call("DELETE", `/depositions/${docs[0].id}`)).status).toBe(404);

    expect(await call("DELETE", `/cases/${caseId}`)).toMatchObject({ status: 200, body: { deleted: { depositions: 1 } } });
    expect((await call("GET", `/cases/${caseId}`)).status).toBe(404);
    expect(await db.$count(cases)).toBe(0);
    expect(await db.$count(depositions)).toBe(0);
  });

  it("never answers with an active analysis of another method", async () => {
    const stored = await storeSynthetic(db, WEBB_SUITE);
    const [c] = await db.select().from(candidates).where(eq(candidates.id, [...stored.values()][0]));
    const [d] = await db.select().from(depositions).where(eq(depositions.id, c.depositionA));
    await boss.offWork("run-analysis");
    const start = (body: object) => call("POST", `/cases/${d.caseId}/analyses`, { depositionA: c.depositionA, depositionB: c.depositionB, mode: "live", ...body });
    const direct = await start({});
    const hybrid = await start({ method: "hybrid" });
    expect([direct.status, hybrid.status]).toEqual([202, 202]);
    expect([direct.body.analysis.retrieval, hybrid.body.analysis.retrieval]).toEqual(["direct_fable", "hybrid"]);
    const again = await start({});
    expect([again.status, again.body.analysis.id]).toEqual([200, direct.body.analysis.id]);
    await startAnalysisWorkers(boss, db, { liveAdjudicator: () => null }, { pollingIntervalSeconds: 0.5 });
  });

  it("refuses to resume a direct analysis that can't make progress", async () => {
    const stored = await storeSynthetic(db, WEBB_SUITE);
    const [c] = await db.select().from(candidates).where(eq(candidates.id, [...stored.values()][0]));
    const [d] = await db.select().from(depositions).where(eq(depositions.id, c.depositionA));
    await boss.offWork("run-analysis");
    const { id } = (await call("POST", `/cases/${d.caseId}/analyses`, { depositionA: c.depositionA, depositionB: c.depositionB, mode: "live" })).body.analysis;
    await db.update(analyses).set({ status: "failed", error: "x" }).where(eq(analyses.id, id));
    expect((await call("POST", `/analyses/${id}/resume`, {})).status).toBe(409);
    await startAnalysisWorkers(boss, db, { liveAdjudicator: () => null }, { pollingIntervalSeconds: 0.5 });
  });

  it("keeps concurrency configurable and the sequential fallback sequential, with no paid default", async () => {
    const stored = await storeSynthetic(db, WEBB_SUITE);
    const [c] = await db.select().from(candidates).where(eq(candidates.id, [...stored.values()][0]));
    const [d] = await db.select().from(depositions).where(eq(depositions.id, c.depositionA));
    const start = (body: object) => call("POST", `/cases/${d.caseId}/analyses`, { depositionA: c.depositionA, depositionB: c.depositionB, ...body });
    const plain = (await start({})).body.analysis;
    expect(plain.mode).toBe("demo");
    await until(() => call("GET", `/analyses/${plain.id}`), (r) => r.body.analysis.status === "completed");
    const custom = (await start({ mode: "live", method: "hybrid", maxConcurrency: 3 })).body.analysis;
    expect([custom.strategy, custom.maxConcurrency]).toEqual(["C", 3]);
    await until(() => call("GET", `/analyses/${custom.id}`), (r) => r.body.analysis.status === "blocked_credentials");
    const fallback = (await start({ mode: "live", method: "hybrid", strategy: "A", maxConcurrency: 8 })).body.analysis;
    expect([fallback.strategy, fallback.maxConcurrency]).toEqual(["A", 1]);
    await until(() => call("GET", `/analyses/${fallback.id}`), (r) => r.body.analysis.status === "blocked_credentials");
  });

  it.each(["D", "E", "F", "P"])("refuses batching strategy %s in the normal workflow", async (strategy) => {
    const stored = await storeSynthetic(db, WEBB_SUITE);
    const [c] = await db.select().from(candidates).where(eq(candidates.id, [...stored.values()][0]));
    const [d] = await db.select().from(depositions).where(eq(depositions.id, c.depositionA));
    expect((await call("POST", `/cases/${d.caseId}/analyses`, { depositionA: c.depositionA, depositionB: c.depositionB, strategy })).status).toBe(400);
  });

  it("refuses an unknown strategy", async () => {
    const stored = await storeSynthetic(db, WEBB_SUITE);
    const [c] = await db.select().from(candidates).where(eq(candidates.id, [...stored.values()][0]));
    const [d] = await db.select().from(depositions).where(eq(depositions.id, c.depositionA));
    expect((await call("POST", `/cases/${d.caseId}/analyses`, { depositionA: c.depositionA, depositionB: c.depositionB, strategy: "Z" })).status).toBe(400);
  });

  it("runs every new analysis as hybrid", async () => {
    const stored = await storeSynthetic(db, WEBB_SUITE);
    const [c] = await db.select().from(candidates).where(eq(candidates.id, [...stored.values()][0]));
    const [d] = await db.select().from(depositions).where(eq(depositions.id, c.depositionA));
    const started = await call("POST", `/cases/${d.caseId}/analyses`, { depositionA: c.depositionA, depositionB: c.depositionB });
    const { analysis } = started.body as { analysis: { retrieval: string; coverage: { candidates: { total: number } } } };
    expect(analysis.retrieval).toBe("hybrid");
    expect(analysis.coverage.candidates.total).toBe(0);
  });
});

void eq;
