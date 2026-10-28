// Database tests for the ingestion schema: each rule the tables enforce is tried against a real
// Postgres. See tests/db/database.ts for when they run.

import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../server/src/db/client";
import { cases, depositions, exchangeLines, exchanges, lines, orgs, witnesses } from "../../server/src/db/schema";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL, violation } from "./database";

const SHA = "a".repeat(64);

describe.skipIf(!TEST_DATABASE_URL)("ingestion schema (Postgres)", () => {
  let pool: Pool;
  let db: Database;

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(() => emptyTables(db));

  async function seed() {
    const [org] = await db.insert(orgs).values({ name: "Demo" }).returning();
    const [kase] = await db.insert(cases).values({ orgId: org.id, name: "U.S. v. Oracle" }).returning();
    const [witness] = await db.insert(witnesses).values({ caseId: kase.id, name: "Lawrence Ellison" }).returning();
    return { org, kase, witness };
  }

  const deposition = (caseId: number, witnessId: number, overrides: Partial<typeof depositions.$inferInsert> = {}) => ({
    caseId,
    witnessId,
    fileSha256: SHA,
    storageKey: "data/uploads/p3173.pdf",
    pageCount: 108,
    validation: { status: "ready", pages: [] } as never,
    parserVersion: "pdfjs-ellison-doj-v1-r1",
    status: "ready" as const,
    ...overrides,
  });

  const line = (depositionId: number, printedPage: number, lineNo: number, rawText = `line ${lineNo}`) => ({
    depositionId,
    pdfPage: 1,
    printedPage,
    lineNo,
    speakerRole: "witness" as const,
    rawText,
    normText: rawText.toLowerCase(),
  });

  async function depositionWithLines(count: number) {
    const { kase, witness } = await seed();
    const [depo] = await db.insert(depositions).values(deposition(kase.id, witness.id)).returning();
    const rows = await db
      .insert(lines)
      .values(Array.from({ length: count }, (_, i) => line(depo.id, 161, i + 1)))
      .returning();
    return { depo, rows, kase, witness };
  }

  type DepositionRow = typeof depositions.$inferSelect;
  const part = (depo: DepositionRow, first: number, last: number, overrides: Partial<typeof exchanges.$inferInsert> = {}) => ({
    depositionId: depo.id,
    witnessId: depo.witnessId,
    groupId: 1,
    partNo: 1,
    partCount: 1,
    kind: "qa" as const,
    firstLineId: first,
    lastLineId: last,
    answerLineCount: 1,
    questionText: "",
    answerText: "",
    dialogueText: "",
    ...overrides,
  });

  it("creates the seven ingestion tables and llm_calls", async () => {
    const result = await db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
    );
    expect(result.rows.map((r) => r.table_name)).toEqual([
      "cases",
      "depositions",
      "exchange_lines",
      "exchanges",
      "lines",
      "llm_calls",
      "orgs",
      "witnesses",
    ]);
  });

  it("stores a deposition's arrays and validation report as written", async () => {
    const { kase, witness } = await seed();
    const [depo] = await db
      .insert(depositions)
      .values(deposition(kase.id, witness.id, { blankPages: [64, 65], validation: { status: "ready", reasons: [] } as never }))
      .returning();
    expect(depo.blankPages).toEqual([64, 65]);
    expect(depo.needsOcrPages).toEqual([]);
    expect(depo.validation).toEqual({ status: "ready", reasons: [] });
    expect(depo.sourceFormat).toBe("pdf");
  });

  describe("duplicate protection", () => {
    it("rejects the same file and parser version twice in one case", async () => {
      const { kase, witness } = await seed();
      await db.insert(depositions).values(deposition(kase.id, witness.id));
      expect(await violation(db.insert(depositions).values(deposition(kase.id, witness.id)))).toBe("depositions_file_unique");
    });

    it("accepts the same file under a new parser version", async () => {
      const { kase, witness } = await seed();
      await db.insert(depositions).values(deposition(kase.id, witness.id));
      await db.insert(depositions).values(deposition(kase.id, witness.id, { parserVersion: "pdfjs-ellison-doj-v1-r2" }));
      expect(await db.$count(depositions)).toBe(2);
    });

    it("rejects a second copy of the same page:line in a deposition", async () => {
      const { depo } = await depositionWithLines(1);
      expect(await violation(db.insert(lines).values(line(depo.id, 161, 1)))).toBe("lines_page_line_unique");
    });

    it("rejects a second copy of the same exchange part", async () => {
      const { depo, rows } = await depositionWithLines(2);
      await db.insert(exchanges).values(part(depo, rows[0].id, rows[1].id));
      expect(await violation(db.insert(exchanges).values(part(depo, rows[0].id, rows[1].id)))).toBe("exchanges_part_unique");
    });
  });

  describe("integrity rules", () => {
    it("rejects a deposition whose witness belongs to another case", async () => {
      const { org, witness } = await seed();
      const [otherCase] = await db.insert(cases).values({ orgId: org.id, name: "Another case" }).returning();
      expect(await violation(db.insert(depositions).values(deposition(otherCase.id, witness.id)))).toBe("depositions_witness_case_fk");
    });

    it("rejects a malformed file hash and an unknown status", async () => {
      const { kase, witness } = await seed();
      expect(await violation(db.insert(depositions).values(deposition(kase.id, witness.id, { fileSha256: "not-a-hash" })))).toBe(
        "depositions_file_sha256_check",
      );
      expect(await violation(db.insert(depositions).values(deposition(kase.id, witness.id, { status: "done" as never })))).toBe(
        "22P02", // invalid enum value
      );
    });

    it("rejects impossible exchange parts", async () => {
      const { depo, rows } = await depositionWithLines(2);
      const [a, b] = [rows[0].id, rows[1].id];
      expect(await violation(db.insert(exchanges).values(part(depo, a, b, { partNo: 3, partCount: 2 })))).toBe("exchanges_part_no_check");
      expect(await violation(db.insert(exchanges).values(part(depo, a, b, { questionFirstLineId: a })))).toBe(
        "exchanges_question_range_check",
      );
      expect(await violation(db.insert(exchanges).values(part(depo, a, b, { answerLastLineId: b })))).toBe(
        "exchanges_answer_range_check",
      );
      expect(await violation(db.insert(exchanges).values(part(depo, a, b, { answerLineCount: 41 })))).toBe(
        "exchanges_answer_line_count_check",
      );
    });

    it("rejects an exchange that points at a line that doesn't exist", async () => {
      const { depo, rows } = await depositionWithLines(1);
      expect(await violation(db.insert(exchanges).values(part(depo, rows[0].id, 999_999)))).toBe("exchanges_last_line_fk");
    });

    it("rejects an exchange that points at a line from another deposition", async () => {
      const own = await depositionWithLines(2);
      const other = await depositionWithLines(1); // a different case and witness
      const [a, b, foreign] = [own.rows[0].id, own.rows[1].id, other.rows[0].id];
      expect(await violation(db.insert(exchanges).values(part(own.depo, foreign, b)))).toBe("exchanges_first_line_fk");
      expect(await violation(db.insert(exchanges).values(part(own.depo, a, foreign)))).toBe("exchanges_last_line_fk");
      const q = { questionFirstLineId: a, questionLastLineId: a };
      const ans = { answerFirstLineId: b, answerLastLineId: b };
      for (const [overrides, constraint] of [
        [{ ...q, questionFirstLineId: foreign }, "exchanges_question_first_line_fk"],
        [{ ...q, questionLastLineId: foreign }, "exchanges_question_last_line_fk"],
        [{ ...ans, answerFirstLineId: foreign }, "exchanges_answer_first_line_fk"],
        [{ ...ans, answerLastLineId: foreign }, "exchanges_answer_last_line_fk"],
      ] as const) {
        expect(await violation(db.insert(exchanges).values(part(own.depo, a, b, overrides)))).toBe(constraint);
      }
      await db.insert(exchanges).values(part(own.depo, a, b, { ...q, ...ans })); // the same exchange with its own lines is accepted
    });

    it("rejects an exchange whose witness isn't its deposition's witness", async () => {
      const { depo, rows, kase } = await depositionWithLines(1);
      const [other] = await db.insert(witnesses).values({ caseId: kase.id, name: "Safra Catz" }).returning();
      expect(await violation(db.insert(exchanges).values(part(depo, rows[0].id, rows[0].id, { witnessId: other.id })))).toBe(
        "exchanges_deposition_witness_fk",
      );
    });
  });

  describe("exchange membership", () => {
    it("lets overlapping parts share a line without copying it, but lists it once per part", async () => {
      const { depo, rows } = await depositionWithLines(3);
      const [first, second] = await db
        .insert(exchanges)
        .values([
          part(depo, rows[0].id, rows[1].id, { partCount: 2 }),
          part(depo, rows[1].id, rows[2].id, { partNo: 2, partCount: 2 }),
        ])
        .returning();
      await db.insert(exchangeLines).values([
        { exchangeId: first.id, lineId: rows[0].id, depositionId: depo.id, role: "question" },
        { exchangeId: first.id, lineId: rows[1].id, depositionId: depo.id, role: "answer" },
        { exchangeId: second.id, lineId: rows[1].id, depositionId: depo.id, role: "answer" }, // the shared overlap line
        { exchangeId: second.id, lineId: rows[2].id, depositionId: depo.id, role: "answer" },
      ]);
      expect(await db.$count(lines)).toBe(3);
      expect(await db.$count(exchangeLines)).toBe(4);
      expect(await violation(db.insert(exchangeLines).values({ exchangeId: first.id, lineId: rows[1].id, depositionId: depo.id, role: "answer" }))).toBe(
        "exchange_lines_pk",
      );
    });

    it("rejects a membership row whose exchange and line come from different depositions", async () => {
      const own = await depositionWithLines(1);
      const other = await depositionWithLines(1);
      const [ex] = await db.insert(exchanges).values(part(own.depo, own.rows[0].id, own.rows[0].id)).returning();
      const member = { exchangeId: ex.id, lineId: other.rows[0].id, role: "answer" as const };
      // Labelled with the exchange's deposition, the line doesn't match; labelled with the line's, the exchange doesn't.
      expect(await violation(db.insert(exchangeLines).values({ ...member, depositionId: own.depo.id }))).toBe("exchange_lines_line_fk");
      expect(await violation(db.insert(exchangeLines).values({ ...member, depositionId: other.depo.id }))).toBe(
        "exchange_lines_exchange_fk",
      );
    });

    it("deleting a deposition removes its lines, exchanges and memberships, but not the case or witness", async () => {
      const { depo, rows } = await depositionWithLines(2);
      const [ex] = await db.insert(exchanges).values(part(depo, rows[0].id, rows[1].id)).returning();
      await db.insert(exchangeLines).values(rows.map((r) => ({ exchangeId: ex.id, lineId: r.id, depositionId: depo.id, role: "answer" as const })));

      await db.delete(depositions).where(sql`${depositions.id} = ${depo.id}`);

      expect([await db.$count(lines), await db.$count(exchanges), await db.$count(exchangeLines)]).toEqual([0, 0, 0]);
      expect([await db.$count(cases), await db.$count(witnesses)]).toEqual([1, 1]);
    });
  });
});
