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
import { caseRoutes, depositionRoutes } from "../../server/src/api";
import type { Database } from "../../server/src/db/client";
import { analyses, candidates, cases, depositions, lines, llmCalls } from "../../server/src/db/schema";
import { WEBB_SUITE } from "../../server/src/eval/synthetic";
import { storeSynthetic } from "../../server/src/eval/syntheticStore";
import { createIngestQueues, startBoss, startIngestWorkers } from "../../server/src/jobs";
import { emptyTables, listen, openTestDatabase, TEST_DATABASE_URL } from "./database";
import { docx, para, rtf, run } from "../fixtures/transcripts/build";

const P3171 = "data/raw/ellison/p3171.pdf";
const P3173 = "data/raw/ellison/p3173.pdf";

describe.skipIf(!TEST_DATABASE_URL)("case and deposition endpoints (Postgres)", () => {
  let pool: Pool;
  let db: Database;
  let boss: PgBoss;
  let uploads: string;
  let api: { url: string; close: () => Promise<void> };

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
    boss = await startBoss(TEST_DATABASE_URL!, { supervise: true });
    await createIngestQueues(boss, { retryDelay: 1 });
    uploads = mkdtempSync(path.join(tmpdir(), "uploads-"));
    await startIngestWorkers(boss, db, { uploadsDir: uploads, pollingIntervalSeconds: 0.5 });
    const app = express();
    app.use(express.json());
    app.use("/api", caseRoutes({ db }));
    app.use("/api", depositionRoutes({ db, pool, boss, uploadsDir: uploads }));
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

    // Renaming: only the name changes; an empty or overlong name, an extra field or an unknown case is refused.
    const renamed = await call("PATCH", `/cases/${id}`, { name: "  U.S. v. Oracle Corp.  " });
    expect(renamed).toMatchObject({ status: 200, body: { case: { id, name: "U.S. v. Oracle Corp." } } });
    expect(renamed.body.witnesses).toHaveLength(2); // its witnesses are untouched
    expect((await call("GET", "/cases")).body.cases[0]).toMatchObject({ id, name: "U.S. v. Oracle Corp.", witnesses: 2 });
    for (const bad of [{ name: "   " }, { name: "x".repeat(201) }, {}, { name: "Ok", orgId: 2 }]) expect((await call("PATCH", `/cases/${id}`, bad)).status).toBe(400);
    expect((await call("PATCH", "/cases/999999", { name: "Nobody" })).status).toBe(404);
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

  // Two-session checks are no longer started, but databases still hold earlier ones: deleting removes them with
  // their deposition, and still waits while one is marked running, so no job loses its rows.
  it("deletes a deposition with an earlier two-session check, refuses while it is being checked, and deletes a case", async () => {
    await storeSynthetic(db, WEBB_SUITE);
    const docs = await db.select().from(depositions).orderBy(depositions.id);
    const caseId = docs[0].caseId;
    const [{ id }] = await db.insert(analyses).values({ caseId, witnessId: docs[0].witnessId, depositionA: docs[0].id, depositionB: docs[1].id, mode: "demo", status: "completed", promptVersion: "adjudicate-v1", effort: "medium", maxCandidates: 10, budgetUsd: 1 }).returning({ id: analyses.id });
    await db.update(analyses).set({ status: "adjudicating" }).where(eq(analyses.id, id));
    expect(await call("DELETE", `/depositions/${docs[0].id}`)).toMatchObject({ status: 409, body: { analyses: [id] } });
    expect((await call("DELETE", `/cases/${caseId}`)).status).toBe(409);
    await db.update(analyses).set({ status: "completed" }).where(eq(analyses.id, id));

    expect(await call("DELETE", `/depositions/${docs[0].id}`)).toMatchObject({ status: 200, body: { deleted: { depositions: 1, analyses: 1 } } });
    expect((await call("GET", `/depositions/${docs[0].id}`)).status).toBe(404);
    expect(await db.$count(analyses)).toBe(0);
    expect(await db.$count(lines, eq(lines.depositionId, docs[0].id))).toBe(0);
    expect(await db.$count(candidates, eq(candidates.depositionA, docs[0].id))).toBe(0);
    expect((await call("GET", `/depositions/${docs[1].id}`)).status).toBe(200);
    expect((await call("DELETE", `/depositions/${docs[0].id}`)).status).toBe(404);

    expect(await call("DELETE", `/cases/${caseId}`)).toMatchObject({ status: 200, body: { deleted: { depositions: 1 } } });
    expect((await call("GET", `/cases/${caseId}`)).status).toBe(404);
    expect(await db.$count(cases)).toBe(0);
    expect(await db.$count(depositions)).toBe(0);
  });

});

void eq;
