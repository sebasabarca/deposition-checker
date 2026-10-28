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

    it("checks the bytes, not the Content-Type: a non-PDF is refused even when labelled as one", async () => {
      const res = await upload("just some text", undefined, "application/pdf");
      expect(res.status).toBe(415);
      expect(await res.json()).toEqual({ error: "The file is not a PDF." });
      const json = await upload(JSON.stringify({ not: "a pdf" }), undefined, "application/json");
      expect(json.status).toBe(415);
      expect(await upload(pdf("unlabelled"), undefined, "application/octet-stream").then((r) => r.status)).toBe(202);
      expect(await db.$count(depositions)).toBe(1);
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
});
