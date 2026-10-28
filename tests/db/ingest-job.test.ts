// The worker's job handlers, called directly against the test database (no queue). They must tell
// a bad PDF (stored as unsupported) from a system failure (thrown, so pg-boss retries it), be safe
// to run again, and never let a failure overwrite a finished deposition.
// See tests/db/database.ts for when these run.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../server/src/db/client";
import * as schema from "../../server/src/db/schema";
import { cases, depositions, exchanges, lines, orgs, witnesses } from "../../server/src/db/schema";
import { PARSER_VERSION, readDeposition, saveDeposition, storeUpload } from "../../server/src/ingest";
import { failureMessage, recordIngestFailure, runIngestJob } from "../../server/src/jobs";
import { adoptParserVersion } from "../../server/src/jobs/ingest";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

const P3173 = "data/raw/ellison/p3173.pdf";
const NOT_A_READABLE_PDF = new TextEncoder().encode("%PDF-1.4\nthis is not really a PDF\n");

describe.skipIf(!TEST_DATABASE_URL)("ingest job handlers (Postgres)", () => {
  let pool: Pool;
  let db: Database;
  let uploads: string;
  let target: { caseId: number; witnessId: number };

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await emptyTables(db);
    uploads = mkdtempSync(path.join(tmpdir(), "uploads-"));
    const [org] = await db.insert(orgs).values({ name: "Demo" }).returning();
    const [kase] = await db.insert(cases).values({ orgId: org.id, name: "U.S. v. Oracle" }).returning();
    const [witness] = await db.insert(witnesses).values({ caseId: kase.id, name: "Lawrence Ellison" }).returning();
    target = { caseId: kase.id, witnessId: witness.id };
  });

  afterEach(() => rmSync(uploads, { recursive: true, force: true }));

  // A deposition as the upload endpoint leaves it: the file stored, the row processing.
  async function uploaded(data: Uint8Array, status: "processing" | "ready" = "processing", parserVersion = PARSER_VERSION) {
    const { fileSha256, storageKey } = await storeUpload(data, uploads);
    const read = status === "ready" ? { validation: { status: "ready", reasons: [] } as never, pageCount: 1 } : {};
    const [row] = await db
      .insert(depositions)
      .values({ ...target, fileSha256, storageKey, parserVersion, status, ...read })
      .returning();
    return row;
  }

  const jobOf = (row: { id: number; ingestRun: number }) => ({ depositionId: row.id, run: row.ingestRun });
  const reload = async (id: number) => (await db.select().from(depositions).where(eq(depositions.id, id)))[0];

  it("stores a PDF that can't be read as unsupported, with the reason: a bad file, not a failure", async () => {
    const row = await uploaded(NOT_A_READABLE_PDF);
    const result = await runIngestJob(db, jobOf(row), uploads);
    expect(result).toMatchObject({ outcome: "replaced", status: "unsupported", lines: 0 });
    const after = await reload(row.id);
    expect(after).toMatchObject({ status: "unsupported", ingestError: null, pageCount: 0 });
    expect(after.validation?.reasons[0]).toMatch(/could not be read as a PDF/);
  });

  it("throws when the stored file is missing or damaged, leaving the deposition processing for a retry", async () => {
    const row = await uploaded(NOT_A_READABLE_PDF);
    const file = path.join(uploads, row.storageKey);

    writeFileSync(file, "%PDF-1.4 something else");
    await expect(runIngestJob(db, jobOf(row), uploads)).rejects.toThrow(/is damaged/);
    rmSync(file);
    await expect(runIngestJob(db, jobOf(row), uploads)).rejects.toThrow(/ENOENT/);

    expect(await reload(row.id)).toMatchObject({ status: "processing", validation: null, pageCount: null, ingestError: null });
  });

  it("does nothing when run again after it finished (a worker that crashed before acknowledging the job)", async () => {
    const row = await uploaded(NOT_A_READABLE_PDF);
    await runIngestJob(db, jobOf(row), uploads);
    const before = await reload(row.id);
    expect(await runIngestJob(db, jobOf(row), uploads)).toEqual({ outcome: "skipped", status: "unsupported" });
    expect(await reload(row.id)).toEqual(before);
  });

  it("skips a deposition that no longer exists", async () => {
    expect(await runIngestJob(db, { depositionId: 999_999, run: 1 }, uploads)).toEqual({ outcome: "skipped", status: null });
  });

  it.skipIf(!existsSync(P3173))(
    "ingests Ellison P3173 to ready, and a repeated job leaves its rows alone",
    async () => {
      const row = await uploaded(new Uint8Array(readFileSync(P3173)));
      expect(await runIngestJob(db, jobOf(row), uploads)).toMatchObject({ status: "ready", lines: 1660, exchanges: 209 });
      const ids = await db.select({ id: lines.id }).from(lines).orderBy(lines.id);
      expect(await runIngestJob(db, jobOf(row), uploads)).toMatchObject({ outcome: "skipped", status: "ready" });
      expect(await db.select({ id: lines.id }).from(lines).orderBy(lines.id)).toEqual(ids);
    },
    120_000,
  );

  describe("a deposition queued for an older parser version (the parser changed before the worker ran)", () => {
    const OLD_VERSION = "pdfjs-ellison-doj-v1-r0";

    it("is ingested into the same deposition under the worker's version, not left processing", async () => {
      const row = await uploaded(NOT_A_READABLE_PDF, "processing", OLD_VERSION);
      expect(await runIngestJob(db, jobOf(row), uploads)).toMatchObject({ depositionId: row.id, status: "unsupported" });
      expect(await db.select({ id: depositions.id, version: depositions.parserVersion, status: depositions.status }).from(depositions)).toEqual([
        { id: row.id, version: PARSER_VERSION, status: "unsupported" },
      ]);
    });

    it("overlapping attempts that both saw the old version both adopt it; the second doesn't call it a duplicate of itself", async () => {
      const row = await uploaded(NOT_A_READABLE_PDF, "processing", OLD_VERSION);
      expect(await adoptParserVersion(db, row, jobOf(row))).toBe("adopted");
      expect(await adoptParserVersion(db, row, jobOf(row))).toBe("adopted"); // the same stale snapshot
      expect(await reload(row.id)).toMatchObject({ status: "processing", parserVersion: PARSER_VERSION, ingestError: null });
      expect(await runIngestJob(db, jobOf(row), uploads)).toMatchObject({ depositionId: row.id, status: "unsupported" });
    });

    it("is marked failed, pointing to the existing deposition, when the file is already stored under the worker's version", async () => {
      const current = await uploaded(NOT_A_READABLE_PDF);
      await runIngestJob(db, jobOf(current), uploads);
      const queued = (
        await db
          .insert(depositions)
          .values({ ...target, fileSha256: current.fileSha256, storageKey: current.storageKey, parserVersion: OLD_VERSION, status: "processing" })
          .returning()
      )[0];

      expect(await runIngestJob(db, jobOf(queued), uploads)).toEqual({ outcome: "skipped", status: "failed" });
      const after = await reload(queued.id);
      expect(after).toMatchObject({ status: "failed", parserVersion: OLD_VERSION });
      expect(after.ingestError).toContain(`already stored as deposition ${current.id}`);
      expect((await reload(current.id)).status).toBe("unsupported");
    });
  });

  describe("runs: a retry is a new run, and messages from an earlier run can't touch it", () => {
    // What the retry endpoint does: back to processing, as the next run.
    async function retry(id: number) {
      const [row] = await db
        .update(depositions)
        .set({ status: "processing", ingestError: null, ingestRun: sql`${depositions.ingestRun} + 1` })
        .where(eq(depositions.id, id))
        .returning();
      return row;
    }

    it("a redelivered failure from run 1 doesn't fail run 2, and run 2's job still does the work", async () => {
      const row = await uploaded(NOT_A_READABLE_PDF);
      expect(await recordIngestFailure(db, jobOf(row), "run 1 failed")).toBe(true);
      const retried = await retry(row.id);
      expect(retried.ingestRun).toBe(2);

      expect(await recordIngestFailure(db, jobOf(row), "run 1 failed (redelivered)")).toBe(false);
      expect(await reload(row.id)).toMatchObject({ status: "processing", ingestError: null });

      expect(await runIngestJob(db, jobOf(row), uploads)).toEqual({ outcome: "skipped", status: "processing" }); // a stale run 1 job
      expect(await runIngestJob(db, jobOf(retried), uploads)).toMatchObject({ status: "unsupported" });
    });

    it("a run given up on while it was still parsing can't save over the newer run", async () => {
      const row = await uploaded(NOT_A_READABLE_PDF);
      const read = await readDeposition(NOT_A_READABLE_PDF); // run 1 has parsed and is about to save
      await recordIngestFailure(db, jobOf(row), "run 1 expired");
      const retried = await retry(row.id);

      const input = { ...target, takenOn: null, fileSha256: row.fileSha256, storageKey: row.storageKey, read };
      expect(await saveDeposition(db, input, jobOf(row))).toEqual({ outcome: "not_current", depositionId: row.id, status: "processing" });
      expect(await reload(row.id)).toMatchObject({ status: "processing", ingestRun: 2, validation: null });
      expect(await runIngestJob(db, jobOf(retried), uploads)).toMatchObject({ status: "unsupported" });
    });

    it("a save can't land on another deposition: it throws rather than leaving its own processing", async () => {
      const stored = await uploaded(NOT_A_READABLE_PDF);
      await runIngestJob(db, jobOf(stored), uploads);
      const [queued] = await db
        .insert(depositions)
        .values({ ...target, fileSha256: stored.fileSha256, storageKey: stored.storageKey, parserVersion: "pdfjs-ellison-doj-v1-r0", status: "processing" })
        .returning();
      const input = { ...target, takenOn: null, fileSha256: stored.fileSha256, storageKey: stored.storageKey, read: await readDeposition(NOT_A_READABLE_PDF) };
      await expect(saveDeposition(db, input, jobOf(queued))).rejects.toThrow(`that is deposition ${stored.id}`);
      expect((await reload(queued.id)).status).toBe("processing");
    });

    it("run 2's own failure is still recorded", async () => {
      const row = await uploaded(NOT_A_READABLE_PDF);
      await recordIngestFailure(db, jobOf(row), "run 1 failed");
      const retried = await retry(row.id);
      expect(await recordIngestFailure(db, jobOf(retried), "run 2 failed")).toBe(true);
      expect(await reload(row.id)).toMatchObject({ status: "failed", ingestError: "run 2 failed", ingestRun: 2 });
    });
  });

  describe("recordIngestFailure", () => {
    it("marks a processing deposition failed with the error, once", async () => {
      const row = await uploaded(NOT_A_READABLE_PDF);
      expect(await recordIngestFailure(db, jobOf(row), "Ingestion failed after every attempt: ENOENT")).toBe(true);
      expect(await reload(row.id)).toMatchObject({ status: "failed", ingestError: "Ingestion failed after every attempt: ENOENT" });
      expect(await recordIngestFailure(db, jobOf(row), "again")).toBe(false);
      expect((await reload(row.id)).ingestError).toBe("Ingestion failed after every attempt: ENOENT");
    });

    it("never overwrites a deposition that finished, ready or not, and never touches its evidence", async () => {
      const ready = await uploaded(new TextEncoder().encode("%PDF-1.4 ready"), "ready");
      const [line] = await db
        .insert(lines)
        .values({ depositionId: ready.id, pdfPage: 1, printedPage: 1, lineNo: 1, speakerRole: "witness", rawText: "Yes.", normText: "yes" })
        .returning();
      await db.insert(exchanges).values({
        depositionId: ready.id,
        witnessId: ready.witnessId,
        groupId: 1,
        partNo: 1,
        partCount: 1,
        kind: "qa",
        firstLineId: line.id,
        lastLineId: line.id,
        answerLineCount: 1,
        questionText: "",
        answerText: "Yes.",
        dialogueText: "A: Yes.",
      });

      expect(await recordIngestFailure(db, jobOf(ready), "late failure")).toBe(false);
      expect(await reload(ready.id)).toMatchObject({ status: "ready", ingestError: null });
      expect([await db.$count(lines), await db.$count(exchanges)]).toEqual([1, 1]);

      const unsupported = await uploaded(NOT_A_READABLE_PDF);
      await runIngestJob(db, jobOf(unsupported), uploads);
      expect(await recordIngestFailure(db, jobOf(unsupported), "late failure")).toBe(false);
      expect((await reload(unsupported.id)).status).toBe("unsupported");
    });

    it("throws while the database is unreachable, so pg-boss keeps the job and retries it later", async () => {
      const row = await uploaded(NOT_A_READABLE_PDF);
      const downPool = new Pool({ connectionString: "postgres://deposition:deposition@127.0.0.1:1/deposition_checker_test" });
      const down = drizzle(downPool, { schema });
      await expect(recordIngestFailure(down, jobOf(row), "outage")).rejects.toThrow();
      await downPool.end();
      expect(await recordIngestFailure(db, jobOf(row), "after the outage")).toBe(true);
    });
  });

  it("failureMessage turns pg-boss's stored error into a sentence", () => {
    expect(failureMessage({ message: "ENOENT: no such file", stack: "..." })).toBe("Ingestion failed after every attempt: ENOENT: no such file");
    expect(failureMessage("timeout")).toBe("Ingestion failed after every attempt: timeout");
    expect(failureMessage(null)).toBe("Ingestion failed after every attempt: no error was recorded");
  });
});
