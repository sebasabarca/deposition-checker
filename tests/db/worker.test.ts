// End to end: upload over HTTP, the queue, the worker and the stored result, with short retry
// delays. See tests/db/database.ts for when these run.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import type { PgBoss } from "pg-boss";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { depositionRoutes } from "../../server/src/api";
import type { Database } from "../../server/src/db/client";
import { cases, depositions, orgs, witnesses } from "../../server/src/db/schema";
import { PARSER_VERSION, storeUpload } from "../../server/src/ingest";
import { createIngestQueues, INGEST_FAILED_QUEUE, INGEST_QUEUE, startBoss, startIngestWorkers } from "../../server/src/jobs";
import { emptyTables, jobsFor, listen, openTestDatabase, TEST_DATABASE_URL } from "./database";

const P3173 = "data/raw/ellison/p3173.pdf";
const NOT_A_READABLE_PDF = new TextEncoder().encode("%PDF-1.4\nthis is not really a PDF\n");
const TIMEOUT = 120_000;

describe.skipIf(!TEST_DATABASE_URL)("background ingestion end to end (Postgres)", () => {
  let pool: Pool;
  let db: Database;
  let boss: PgBoss;
  let uploads: string; // where the API stores files
  let api: { url: string; close: () => Promise<void> };
  let caseId: number;

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
    boss = await startBoss(TEST_DATABASE_URL!, { supervise: true });
    await createIngestQueues(boss, { retryDelay: 1 }); // backoff of about 1 s, then 2 s, instead of 10 s and 20 s
    uploads = mkdtempSync(path.join(tmpdir(), "uploads-"));
    const app = express();
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

  afterEach(async () => {
    await boss.offWork(INGEST_QUEUE);
    await boss.offWork(INGEST_FAILED_QUEUE);
  });

  // The worker reads files from `dir`; pointing it at an empty folder makes every attempt fail.
  const startWorker = (dir: string) => startIngestWorkers(boss, db, { uploadsDir: dir, pollingIntervalSeconds: 0.5 });

  const upload = async (data: Uint8Array<ArrayBuffer>) => {
    const res = await fetch(`${api.url}/api/cases/${caseId}/depositions?witness=Lawrence%20Ellison`, { method: "POST", body: data });
    return { status: res.status, deposition: (await res.json()).deposition };
  };

  // Polls the status endpoint until the deposition is no longer processing.
  async function finished(id: number) {
    for (const started = Date.now(); Date.now() - started < TIMEOUT - 5_000; ) {
      const { deposition } = await (await fetch(`${api.url}/api/depositions/${id}`)).json();
      if (deposition.status !== "processing") return deposition;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`deposition ${id} was still processing`);
  }

  it(
    "answers the upload at once, then the worker stores a file it can't read as unsupported",
    async () => {
      await startWorker(uploads);
      const { status, deposition } = await upload(NOT_A_READABLE_PDF);
      expect([status, deposition.status]).toEqual([202, "processing"]);
      expect(await finished(deposition.id)).toMatchObject({ status: "unsupported", error: null, pageCount: 0 });
    },
    TIMEOUT,
  );

  it.skipIf(!existsSync(P3173))(
    "uploads Ellison P3173: the API returns its ID while it is processing, and the worker makes it ready",
    async () => {
      await startWorker(uploads);
      const { status, deposition } = await upload(new Uint8Array(readFileSync(P3173)));
      expect([status, deposition.status, deposition.stored.lines]).toEqual([202, "processing", 0]);
      const done = await finished(deposition.id);
      expect(done).toMatchObject({ status: "ready", pageCount: 108, stored: { lines: 1660, exchanges: 209 } });
      expect(done.validation.pages).toEqual({ text: 99, blank: 9, needs_ocr: 0, failed: 0 });
    },
    TIMEOUT,
  );

  describe("jobs queued before runs existed (migration 0003), with only { depositionId }", () => {
    // A processing deposition and a job in the old format, as left by the previous code.
    async function legacyJob() {
      const { fileSha256, storageKey } = await storeUpload(NOT_A_READABLE_PDF, uploads);
      const [witness] = await db.insert(witnesses).values({ caseId, name: "Lawrence Ellison" }).returning();
      const [row] = await db
        .insert(depositions)
        .values({ caseId, witnessId: witness.id, fileSha256, storageKey, parserVersion: PARSER_VERSION, status: "processing" })
        .returning();
      await boss.send(INGEST_QUEUE, { depositionId: row.id });
      return row;
    }

    it(
      "are processed as run 1 instead of being skipped",
      async () => {
        await startWorker(uploads);
        const row = await legacyJob();
        expect(await finished(row.id)).toMatchObject({ status: "unsupported", ingestRun: 1 });
      },
      TIMEOUT,
    );

    it(
      "still have their final failure recorded",
      async () => {
        const empty = mkdtempSync(path.join(tmpdir(), "worker-uploads-"));
        try {
          await startWorker(empty);
          const row = await legacyJob();
          const failed = await finished(row.id);
          expect(failed).toMatchObject({ status: "failed", ingestRun: 1 });
          expect(failed.error).toMatch(/ENOENT/);
        } finally {
          rmSync(empty, { recursive: true, force: true });
        }
      },
      TIMEOUT,
    );
  });

  it(
    "a system failure is tried 3 times, recorded as failed with its error, and an explicit retry then succeeds",
    async () => {
      const empty = mkdtempSync(path.join(tmpdir(), "worker-uploads-"));
      try {
        await startWorker(empty);
        const { deposition } = await upload(NOT_A_READABLE_PDF);
        const failed = await finished(deposition.id);
        expect(failed).toMatchObject({ status: "failed", validation: null, pageCount: null });
        expect(failed.error).toMatch(/^Ingestion failed after every attempt: ENOENT/);
        expect(await jobsFor(db, INGEST_QUEUE, deposition.id)).toEqual([{ state: "failed", retry_count: 2 }]); // 3 attempts

        // Fix the cause (point the worker at the folder that has the file), then retry.
        await boss.offWork(INGEST_QUEUE);
        await boss.offWork(INGEST_FAILED_QUEUE);
        await startWorker(uploads);
        const retry = await fetch(`${api.url}/api/depositions/${deposition.id}/retry`, { method: "POST" });
        expect([retry.status, (await retry.json()).deposition.status]).toEqual([202, "processing"]);
        expect(await finished(deposition.id)).toMatchObject({ id: deposition.id, status: "unsupported", error: null });
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});
