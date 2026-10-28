// Database tests for saving ingested depositions: idempotent re-saves, rollback on failure, and
// the real Ellison PDFs end to end. See tests/db/database.ts for when they run.

import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { asc, eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../server/src/db/client";
import { cases, depositions, exchangeLines, exchanges, lines, orgs, witnesses } from "../../server/src/db/schema";
import { ingestFile, PARSER_VERSION, saveDeposition, type DepositionRead, type SaveInput } from "../../server/src/ingest";
import { buildExchangeParts } from "../../server/src/ingest/exchanges";
import { ELLISON_DOJ_V1 as LAYOUT } from "../../server/src/ingest/layout";
import type { SourceLine } from "../../server/src/ingest/pdf";
import type { Validation } from "../../server/src/ingest/validate";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

const TURN = 112.5;
const PARA = 124.5;
const RAW = "data/raw/ellison";

const src = (printedPage: number, lineNo: number, rawText: string, indentX: number | null = null): SourceLine => ({
  pdfPage: printedPage - 160,
  printedPage,
  lineNo,
  lineFromPosition: lineNo,
  indentX,
  rawText,
});

const validation = (status: Validation["status"], reasons: string[] = []): Validation => ({
  status,
  layout: LAYOUT.name,
  pageCount: 2,
  counts: { text: status === "ready" ? 2 : 0, blank: 0, needs_ocr: status === "ready" ? 0 : 2, failed: 0 },
  needsOcrPages: status === "ready" ? [] : [1, 2],
  blankPages: [],
  failedPages: [],
  reasons,
  pages: [],
});

// A small ready deposition: two exchanges across a page break, the second interrupted by an objection.
function readyRead(answer = "A. No, I didn't."): DepositionRead {
  const source = [
    src(161, 21, "Q. Did you approve the SAP deal?", TURN),
    src(161, 22, answer, TURN),
    src(162, 1, "Q. Who did?", TURN),
    src(162, 2, "MR. RILL: Objection, foundation.", PARA),
    src(162, 3, "A. Safra Catz, I believe.", TURN),
  ];
  return { parserVersion: PARSER_VERSION, validation: validation("ready"), pdf: null, exchanges: buildExchangeParts(source, LAYOUT) };
}

describe.skipIf(!TEST_DATABASE_URL)("saving depositions (Postgres)", () => {
  let pool: Pool;
  let db: Database;
  let target: { caseId: number; witnessId: number };

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await emptyTables(db);
    const [org] = await db.insert(orgs).values({ name: "Demo" }).returning();
    const [kase] = await db.insert(cases).values({ orgId: org.id, name: "U.S. v. Oracle" }).returning();
    const [witness] = await db.insert(witnesses).values({ caseId: kase.id, name: "Lawrence Ellison" }).returning();
    target = { caseId: kase.id, witnessId: witness.id };
  });

  const input = (read: DepositionRead, overrides: Partial<SaveInput> = {}): SaveInput => ({
    ...target,
    takenOn: "2004-01-20",
    fileSha256: "a".repeat(64),
    storageKey: `${"a".repeat(64)}.pdf`,
    read,
    ...overrides,
  });

  const count = async () => [await db.$count(lines), await db.$count(exchanges), await db.$count(exchangeLines)];

  // Each stored part with its lines' page:line and role, read back through the foreign keys.
  async function storedParts() {
    const rows = await db
      .select({
        part: exchanges.groupId,
        line: sql<string>`${lines.printedPage} || ':' || ${lines.lineNo}`,
        role: exchangeLines.role,
      })
      .from(exchangeLines)
      .innerJoin(exchanges, eq(exchanges.id, exchangeLines.exchangeId))
      .innerJoin(lines, eq(lines.id, exchangeLines.lineId))
      .orderBy(asc(exchanges.groupId), asc(lines.printedPage), asc(lines.lineNo));
    return rows.map((r) => `${r.part} ${r.line} ${r.role}`);
  }

  it("stores a ready deposition's lines, exchange parts and exact membership", async () => {
    const saved = await saveDeposition(db, input(readyRead()));
    expect(saved).toMatchObject({ outcome: "created", status: "ready", lines: 5, exchanges: 2, parts: 2 });
    expect(await count()).toEqual([5, 2, 5]);
    expect(await storedParts()).toEqual([
      "1 161:21 question",
      "1 161:22 answer",
      "2 162:1 question",
      "2 162:2 context",
      "2 162:3 answer",
    ]);

    const [depo] = await db.select().from(depositions);
    expect(depo).toMatchObject({ id: saved.depositionId, status: "ready", takenOn: "2004-01-20", parserVersion: PARSER_VERSION });
    const [part] = await db.select().from(exchanges).where(eq(exchanges.groupId, 2));
    expect(part.witnessId).toBe(target.witnessId);
    const [first] = await db.select().from(lines).where(eq(lines.id, part.answerFirstLineId!));
    expect([first.printedPage, first.lineNo, first.rawText]).toEqual([162, 3, "A. Safra Catz, I believe."]);
  });

  it("saving the same file again keeps the deposition's ID and replaces its rows instead of duplicating them", async () => {
    const first = await saveDeposition(db, input(readyRead()));
    const second = await saveDeposition(db, input(readyRead("A. No, I did not.")));
    expect(second).toMatchObject({ depositionId: first.depositionId, outcome: "replaced" });
    expect(await db.$count(depositions)).toBe(1);
    expect(await count()).toEqual([5, 2, 5]);
    const texts = await db.select({ text: lines.rawText }).from(lines).where(eq(lines.lineNo, 22));
    expect(texts).toEqual([{ text: "A. No, I did not." }]);
  });

  it("a failure partway through rolls back, leaving the previous ingestion untouched", async () => {
    await saveDeposition(db, input(readyRead()));
    const broken = readyRead("A. No, I did not.");
    broken.exchanges!.parts[1] = { ...broken.exchanges!.parts[1], lines: [{ index: 99, role: "answer" }] };
    broken.validation = validation("ready", ["should not be saved"]);

    await expect(saveDeposition(db, input(broken))).rejects.toThrow(/position 99/);

    expect(await count()).toEqual([5, 2, 5]);
    const texts = await db.select({ text: lines.rawText }).from(lines).where(eq(lines.lineNo, 22));
    expect(texts).toEqual([{ text: "A. No, I didn't." }]);
    const [depo] = await db.select().from(depositions);
    expect(depo.validation.reasons).toEqual([]);
  });

  const notReady = (status: "needs_review" | "unsupported", reason: string): DepositionRead => ({
    parserVersion: PARSER_VERSION,
    validation: validation(status, [reason]),
    pdf: null,
    exchanges: null,
  });

  it("a failed re-ingestion keeps a ready deposition's evidence and status, and reports the failed attempt", async () => {
    const first = await saveDeposition(db, input(readyRead()));
    for (const status of ["unsupported", "needs_review"] as const) {
      const failed = await saveDeposition(db, input(notReady(status, "the file could not be read as a PDF: out of memory")));

      expect(await count()).toEqual([5, 2, 5]);
      const [depo] = await db.select().from(depositions);
      expect(depo).toMatchObject({ id: first.depositionId, status: "ready" });
      expect(depo.validation.reasons).toEqual([]);
      expect(failed).toMatchObject({ depositionId: first.depositionId, outcome: "kept_previous", status: "ready", lines: 5, exchanges: 2, parts: 2 });
      expect(failed.attempt.status).toBe(status);
      expect(failed.attempt.reasons).toEqual(["the file could not be read as a PDF: out of memory"]);
    }
  });

  it("a deposition that wasn't ready is replaced by a later ready ingestion", async () => {
    const first = await saveDeposition(db, input(notReady("unsupported", "no page has a text layer")));
    const second = await saveDeposition(db, input(readyRead()));
    expect(second).toMatchObject({ depositionId: first.depositionId, outcome: "replaced", status: "ready", lines: 5 });
    expect(await count()).toEqual([5, 2, 5]);
  });

  it("concurrent saves of the same file all succeed, leaving one deposition and one copy of its rows", async () => {
    // Open the pool's connections first, so the eight saves really overlap.
    await Promise.all(Array.from({ length: 8 }, () => db.execute(sql`select pg_sleep(0.05)`)));
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => saveDeposition(db, input(readyRead()))));
    expect(results.filter((r) => r.status === "rejected").map((r) => String(r.reason.cause ?? r.reason))).toEqual([]);
    expect(await db.$count(depositions)).toBe(1);
    expect(await count()).toEqual([5, 2, 5]);
    const outcomes = results.map((r) => (r.status === "fulfilled" ? r.value.outcome : null)).sort();
    expect(outcomes).toEqual(["created", ...Array(7).fill("replaced")]);
  });

  it("stores a deposition that isn't ready with its reasons, but no lines or exchanges", async () => {
    const read: DepositionRead = {
      parserVersion: PARSER_VERSION,
      validation: validation("unsupported", ["no page has a text layer"]),
      pdf: null,
      exchanges: null,
    };
    const saved = await saveDeposition(db, input(read));
    expect(saved).toMatchObject({ status: "unsupported", lines: 0, exchanges: 0, parts: 0 });
    const [depo] = await db.select().from(depositions);
    expect(depo).toMatchObject({ status: "unsupported", needsOcrPages: [1, 2], pageCount: 2 });
    expect(depo.validation.reasons).toEqual(["no page has a text layer"]);
    expect(await count()).toEqual([0, 0, 0]);
  });

  it("the same file under a new parser version becomes a separate deposition", async () => {
    await saveDeposition(db, input(readyRead()));
    await saveDeposition(db, input({ ...readyRead(), parserVersion: `${PARSER_VERSION}-next` }));
    expect(await db.$count(depositions)).toBe(2);
    expect(await count()).toEqual([10, 4, 10]);
  });

  describe.skipIf(!existsSync(`${RAW}/p3173.pdf`))("real DOJ PDF", () => {
    it(
      "ingests Ellison P3173 end to end, storing the file and every line, and re-ingests it without duplicates",
      async () => {
        const uploads = await mkdtemp(path.join(tmpdir(), "uploads-"));
        try {
          const data = new Uint8Array(readFileSync(`${RAW}/p3173.pdf`));
          const first = await ingestFile(db, data, { ...target, takenOn: null }, uploads);
          expect(first).toMatchObject({ status: "ready", outcome: "created", lines: 1660, exchanges: 209 });

          const [depo] = await db.select().from(depositions);
          expect(existsSync(path.join(uploads, depo.storageKey))).toBe(true);
          expect(depo.blankPages).toEqual([64, 65, 66, 67, 68, 69, 70, 71, 72]);
          expect(await db.$count(lines)).toBe(1660);
          expect(await db.$count(exchanges)).toBe(first.parts);

          // Every witness answer line is a member of at least one part.
          const [{ missing }] = await db
            .select({ missing: sql<number>`count(*)::int` })
            .from(lines)
            .where(sql`${lines.speakerRole} = 'witness' and not exists (select 1 from ${exchangeLines} where ${exchangeLines.lineId} = ${lines.id})`);
          expect(missing).toBe(0);

          const again = await ingestFile(db, data, { ...target, takenOn: null }, uploads);
          expect(again).toMatchObject({ depositionId: first.depositionId, outcome: "replaced" });
          expect(await db.$count(lines)).toBe(1660);
        } finally {
          await rm(uploads, { recursive: true, force: true });
        }
      },
      120_000,
    );
  });
});
