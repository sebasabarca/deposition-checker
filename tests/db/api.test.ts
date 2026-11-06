// The upload and status endpoints over HTTP, with a real queue but no worker running: nothing is
// ever parsed here, which shows the API answers without waiting for parsing.
// See tests/db/database.ts for when these run.

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import type { PgBoss } from "pg-boss";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { depositionRoutes } from "../../server/src/api";
import type { Database } from "../../server/src/db/client";
import { cases, depositions, orgs } from "../../server/src/db/schema";
import { createIngestQueues, INGEST_QUEUE, recordIngestFailure, startBoss } from "../../server/src/jobs";
import { emptyTables, jobsFor, listen, openTestDatabase, TEST_DATABASE_URL } from "./database";

const pdf = (text: string) => new TextEncoder().encode(`%PDF-1.4\n${text}\n%%EOF\n`);

describe.skipIf(!TEST_DATABASE_URL)("deposition endpoints (Postgres)", () => {
  let pool: Pool;
  let db: Database;
  let boss: PgBoss;
  let uploads: string;
  let api: { url: string; close: () => Promise<void> };
  let caseId: number;

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
    boss = await startBoss(TEST_DATABASE_URL!, { supervise: false });
    await createIngestQueues(boss);
    uploads = mkdtempSync(path.join(tmpdir(), "uploads-"));
    const app = express();
    app.use(express.json()); // as in server/src/index.ts, to check it doesn't swallow uploads
    app.use("/api", depositionRoutes({ db, pool, boss, uploadsDir: uploads }));
    api = await listen(app);
  });

  afterAll(async () => {
    await api?.close();
    await boss?.stop({ graceful: false });
    await pool?.end();
    rmSync(uploads, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await emptyTables(db);
    const [org] = await db.insert(orgs).values({ name: "Demo" }).returning();
    const [kase] = await db.insert(cases).values({ orgId: org.id, name: "U.S. v. Oracle" }).returning();
    caseId = kase.id;
  });

  const upload = (body: Uint8Array<ArrayBuffer> | string, query = "witness=Lawrence%20Ellison&takenOn=2004-01-20", contentType = "application/pdf") =>
    fetch(`${api.url}/api/cases/${caseId}/depositions?${query}`, { method: "POST", body, headers: { "content-type": contentType } });

  describe("POST /api/cases/:caseId/depositions", () => {
    it("stores the file, records the deposition as processing, queues one job, and answers before any parsing", async () => {
      const res = await upload(pdf("deposition"));
      expect(res.status).toBe(202);
      const { created, deposition } = await res.json();
      expect(created).toBe(true);
      expect(deposition).toMatchObject({
        id: expect.any(Number),
        caseId,
        witness: { name: "Lawrence Ellison" },
        takenOn: "2004-01-20",
        status: "processing",
        error: null,
        pageCount: null,
        validation: null,
        stored: { lines: 0, exchanges: 0, parts: 0 },
      });
      expect(readdirSync(uploads)).toHaveLength(1);
      expect(await jobsFor(db, INGEST_QUEUE, deposition.id)).toEqual([{ state: "created", retry_count: 0 }]);
    });

    it("returns the existing deposition for a file already uploaded to the case, without queuing again", async () => {
      const first = await (await upload(pdf("deposition"))).json();
      const res = await upload(pdf("deposition"), "witness=Someone%20Else");
      expect(res.status).toBe(200);
      const again = await res.json();
      expect(again).toMatchObject({ created: false, deposition: { id: first.deposition.id, witness: { name: "Lawrence Ellison" } } });
      expect(await jobsFor(db, INGEST_QUEUE, first.deposition.id)).toHaveLength(1);
    });

    it("concurrent uploads of the same file create one deposition and one job", async () => {
      const responses = await Promise.all(Array.from({ length: 8 }, () => upload(pdf("same file"))));
      const bodies = await Promise.all(responses.map((r) => r.json()));
      expect(responses.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 202]);
      expect(new Set(bodies.map((b) => b.deposition.id)).size).toBe(1);
      expect(await db.$count(depositions)).toBe(1);
      expect(await jobsFor(db, INGEST_QUEUE, bodies[0].deposition.id)).toHaveLength(1);
    });

    it("checks the bytes, not the Content-Type: binary that isn't a PDF is refused even when labelled as one", async () => {
      const res = await upload(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0xff, 0xfe]), undefined, "application/pdf");
      expect(res.status).toBe(415);
      expect(await res.json()).toEqual({ code: "unsupported_format", error: "This file isn't a transcript format Veridict can read. Upload a PDF, a text file (.txt, .asc), an RTF or a Word (.docx) document." });
      expect(await upload(pdf("unlabelled"), undefined, "application/octet-stream").then((r) => r.status)).toBe(202);
      expect(await db.$count(depositions)).toBe(1);
    });

    it("accepts plain text, whatever it is labelled, as a text deposition", async () => {
      const res = await upload(" 1   Q.  Where were you?\n 2   A.  Home.", undefined, "text/plain");
      expect(res.status).toBe(202);
      const [row] = await db.select({ format: depositions.sourceFormat }).from(depositions);
      expect(row.format).toBe("text");
    });

    it("refuses an empty body, a missing witness, a bad date, a bad case ID and an unknown case", async () => {
      expect((await upload(new Uint8Array())).status).toBe(400);
      expect((await upload(pdf("a"), "takenOn=2004-01-20")).status).toBe(400);
      expect((await upload(pdf("a"), "witness=X&takenOn=2004-13-45")).status).toBe(400);
      const badId = await fetch(`${api.url}/api/cases/abc/depositions?witness=X`, { method: "POST", body: pdf("a") });
      expect(badId.status).toBe(400);
      const unknown = await fetch(`${api.url}/api/cases/999999/depositions?witness=X`, { method: "POST", body: pdf("a") });
      expect([unknown.status, await unknown.json()]).toEqual([404, { error: "Case not found." }]);
      expect(await db.$count(depositions)).toBe(0);
    });

    it("refuses a file over 50 MB", async () => {
      const big = new Uint8Array(51 * 1024 * 1024);
      big.set(pdf("big"));
      const files = readdirSync(uploads).length;
      const res = await upload(big);
      expect([res.status, await res.json()]).toEqual([413, { error: "The file is larger than 50 MB." }]);
      expect(readdirSync(uploads)).toHaveLength(files);
      expect(await db.$count(depositions)).toBe(0);
    });
  });

  describe("GET /api/depositions/:id", () => {
    it("shows a processing deposition with nulls for what isn't known yet", async () => {
      const { deposition } = await (await upload(pdf("deposition"))).json();
      const res = await fetch(`${api.url}/api/depositions/${deposition.id}`);
      expect(res.status).toBe(200);
      expect((await res.json()).deposition).toMatchObject({ status: "processing", pageCount: null, validation: null, error: null });
    });

    it("answers 400 for a bad ID and 404 for an unknown one", async () => {
      expect((await fetch(`${api.url}/api/depositions/abc`)).status).toBe(400);
      expect((await fetch(`${api.url}/api/depositions/999999`)).status).toBe(404);
    });
  });

  describe("GET /api/depositions/:id/pdf", () => {
    it("serves the original file inline, for checking OCR against the scan", async () => {
      const file = pdf("scan");
      const { deposition } = (await (await upload(file)).json()) as { deposition: { id: number } };
      const res = await fetch(`${api.url}/api/depositions/${deposition.id}/pdf`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/pdf");
      expect(res.headers.get("content-disposition")).toBe("inline");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(file);
    });
    it("answers 404 for an unknown deposition", async () => {
      expect((await fetch(`${api.url}/api/depositions/999999/pdf`)).status).toBe(404);
    });
  });

  describe("POST /api/depositions/:id/retry", () => {
    it("re-queues a failed deposition once, and refuses any other status", async () => {
      const { deposition } = await (await upload(pdf("deposition"))).json();
      const retry = () => fetch(`${api.url}/api/depositions/${deposition.id}/retry`, { method: "POST" });

      const early = await retry();
      expect([early.status, await early.json()]).toEqual([409, { error: "Only failed depositions can be retried; this one is processing." }]);

      await recordIngestFailure(db, { depositionId: deposition.id, run: deposition.ingestRun }, "Ingestion failed after every attempt: ENOENT");
      const results = await Promise.all([retry(), retry(), retry()]);
      expect(results.map((r) => r.status).sort()).toEqual([202, 409, 409]);
      const queued = await (results.find((r) => r.status === 202)!).json();
      expect(queued.deposition).toMatchObject({ status: "processing", error: null, ingestRun: 2 });
      expect(await jobsFor(db, INGEST_QUEUE, deposition.id)).toHaveLength(2); // the upload's job and the retry's
    });

    it("answers 404 for an unknown deposition", async () => {
      expect((await fetch(`${api.url}/api/depositions/999999/retry`, { method: "POST" })).status).toBe(404);
    });
  });

  const send = (method: string, url: string, body: unknown) => fetch(`${api.url}/api${url}`, { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });

  describe("PATCH /api/depositions/:id", () => {
    it("sets, corrects and clears the date taken", async () => {
      const { deposition } = await (await upload(pdf("a"), "witness=Lawrence%20Ellison")).json();
      expect(deposition.takenOn).toBeNull();
      const set = await send("PATCH", `/depositions/${deposition.id}`, { takenOn: "2004-01-20" });
      expect(set.status).toBe(200);
      expect((await set.json()).deposition.takenOn).toBe("2004-01-20");
      const cleared = (await (await send("PATCH", `/depositions/${deposition.id}`, { takenOn: null })).json()).deposition;
      expect(cleared).toMatchObject({ takenOn: null, dateConfirmed: null });
      expect((await send("PATCH", `/depositions/${deposition.id}`, { takenOn: "2004-13-45" })).status).toBe(400);
      expect((await send("PATCH", "/depositions/999999", { takenOn: null })).status).toBe(404);
    });
  });

  describe("POST /api/depositions/:id/move", () => {
    it("re-files the deposition under another witness from its stored file, keeping its date, and queues it to be read again", async () => {
      const { deposition: old } = await (await upload(pdf("a"))).json();
      const files = readdirSync(uploads).length;
      const res = await send("POST", `/depositions/${old.id}/move`, { caseId, witness: "Safra Catz" });
      expect(res.status).toBe(202);
      const { deposition } = await res.json();
      expect(deposition).toMatchObject({ caseId, witness: { name: "Safra Catz" }, takenOn: "2004-01-20", status: "processing" });
      expect(deposition.id).not.toBe(old.id);
      expect((await fetch(`${api.url}/api/depositions/${old.id}`)).status).toBe(404);
      expect(readdirSync(uploads)).toHaveLength(files); // the file is kept: the new deposition uses it
      expect(await jobsFor(db, INGEST_QUEUE, deposition.id)).toEqual([{ state: "created", retry_count: 0 }]);
    });

    it("moves to another case of the same firm, never to another firm's", async () => {
      const { deposition } = await (await upload(pdf("a"))).json();
      const [org] = await db.select().from(orgs);
      const [mine] = await db.insert(cases).values({ orgId: org.id, name: "Second case" }).returning();
      const [other] = await db.insert(orgs).values({ name: "Another firm" }).returning();
      const [theirs] = await db.insert(cases).values({ orgId: other.id, name: "Their case" }).returning();
      expect((await send("POST", `/depositions/${deposition.id}/move`, { caseId: theirs.id, witness: "Lawrence Ellison" })).status).toBe(404);
      const moved = await send("POST", `/depositions/${deposition.id}/move`, { caseId: mine.id, witness: "Lawrence Ellison" });
      expect(moved.status).toBe(202);
      expect((await moved.json()).deposition.caseId).toBe(mine.id);
    });

    it("refuses a move that changes nothing, or into a case that already has the file", async () => {
      const { deposition } = await (await upload(pdf("a"))).json();
      expect((await send("POST", `/depositions/${deposition.id}/move`, { caseId, witness: "Lawrence Ellison" })).status).toBe(400);
      const [org] = await db.select().from(orgs);
      const [second] = await db.insert(cases).values({ orgId: org.id, name: "Second case" }).returning();
      await fetch(`${api.url}/api/cases/${second.id}/depositions?witness=X`, { method: "POST", body: pdf("a"), headers: { "content-type": "application/pdf" } });
      const res = await send("POST", `/depositions/${deposition.id}/move`, { caseId: second.id, witness: "Lawrence Ellison" });
      expect(res.status).toBe(409);
      expect((await fetch(`${api.url}/api/depositions/${deposition.id}`)).status).toBe(200); // rolled back: nothing deleted
    });
  });
});
