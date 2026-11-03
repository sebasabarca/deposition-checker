// The Stage 1 evidence foundation on REAL public testimony (data/eval/evidence-fixtures-v1.json), through
// the same checks as `scripts/evidence.ts eval-real` (server/src/eval/evidenceFixtures.ts), plus the fixes
// of parser revision 9 on real statements. The files are local and git-ignored, so this skips and says so
// where they are absent; the eval-real command fails instead.
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../server/src/db/client";
import { depositions, exchanges, lines } from "../../server/src/db/schema";
import { sourceContext } from "../../server/src/evidence";
import { exchangesAt, loadEvidenceFixtures, missingFixtureFiles, readEvidenceFixture, reloadFixture, runEvidenceChecks, type LoadedFixtures } from "../../server/src/eval/evidenceFixtures";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

const FIXTURE = readEvidenceFixture();
const missing = missingFixtureFiles(FIXTURE);
if (missing.length && TEST_DATABASE_URL) console.warn(`evidenceReal: SKIPPED, local fixture files missing: ${missing.join(", ")}. Run \`npx tsx scripts/evidence.ts eval-real\` for an evaluation that fails instead.`);

describe.skipIf(!TEST_DATABASE_URL || missing.length > 0)("evidence foundation (Postgres, real fixtures)", () => {
  let db: Database;
  let pool: Pool;
  let l: LoadedFixtures;
  let result: Awaited<ReturnType<typeof runEvidenceChecks>>;

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
    await emptyTables(db);
    l = await loadEvidenceFixtures(db, FIXTURE);
    result = await runEvidenceChecks(db, FIXTURE, l);
    console.info("evidenceReal:", JSON.stringify(result.counts), Object.entries(result.attribution).map(([k, a]) => `${k} ${a.counts.verified}/${a.counts.uncertain}/${a.counts.invalid}`).join("; "));
  }, 180_000);
  afterAll(async () => {
    await pool?.end();
  });

  it("passes every real-data integrity check", () => {
    expect(result.checks.filter((c) => !c.ok)).toEqual([]);
    expect(result.checks.length).toBeGreaterThan(20);
  });

  it("keeps Resnick's two archive files in one session and Simpson's two days apart", async () => {
    const rows = await db.select({ id: depositions.id, sessionId: depositions.sessionId, sessionPart: depositions.sessionPart }).from(depositions);
    const of = (k: string) => rows.find((r) => r.id === l.docId.get(k))!;
    expect(of("resnick-1996-02-11-direct").sessionId).toBe(of("resnick-1996-02-11-cross").sessionId);
    expect([of("resnick-1996-02-11-direct").sessionPart, of("resnick-1996-02-11-cross").sessionPart]).toEqual([1, 2]);
    expect(of("simpson-1996-01-23").sessionId).not.toBe(of("simpson-1996-02-27").sessionId);
  });

  it("reads Resnick's question and answer on one statement (direct, 783) as a verified answer, its text untouched", async () => {
    const [x] = await exchangesAt(db, l, "resnick-1996-02-11-direct", "0:783", "0:783");
    const line = x.lines.find((r) => r.ref === "statement 783")!;
    expect(line.text).toBe("Q: Now, do you remember the car O.J. Simpson drove up in? A.Yes, I do.");
    expect(line.segments!.map((s) => [s.speaker, s.text])).toEqual([["attorney", "Q: Now, do you remember the car O.J. Simpson drove up in?"], ["witness", "A.Yes, I do."]]);
    expect(x.answer).toContain("A.Yes, I do.");
    expect(x.answer).not.toContain("drove up in");
    expect(x.speakerStatus).toBe("verified");
  });

  it("splits a statement holding an answer and the next question into two exchanges (Simpson, January 23, 218)", async () => {
    // "O.J. SIMPSON: No. BY MR. PETROCELLI: Q: The answer is you were not?" ends one exchange and starts the next.
    const both = await exchangesAt(db, l, "simpson-1996-01-23", "1:218", "1:218");
    expect(both).toHaveLength(2);
    const ending = both.find((x) => x.answer.includes("O.J. SIMPSON: No."))!;
    const starting = both.find((x) => x.question.includes("Q: The answer is you were not?"))!;
    expect(ending.answer).not.toContain("The answer is you were not?");
    expect(ending.question).not.toContain("The answer is you were not?");
    expect(starting.answer).not.toContain("O.J. SIMPSON: No.");
    expect(starting.sourceStart.ref).toBe(ending.sourceEnd.ref); // the one source line, cited once by each
    expect(starting.lines[0].text).toBe(ending.lines.at(-1)!.text);
  });

  it("reads the archive's named attorneys as named speakers, not unknown (Simpson, January 23)", async () => {
    const baker = await db.select({ role: lines.speakerRole }).from(lines).where(eq(lines.depositionId, l.docId.get("simpson-1996-01-23")!));
    expect(baker.filter((r) => r.role === "unknown").length).toBeLessThan(10);
    expect(result.attribution["simpson-1996-01-23"].counts.uncertain).toBeLessThan(50); // 161 before revision 9
  });

  it("keeps the question with Simpson's bare answer about the gate", async () => {
    const [x] = await exchangesAt(db, l, "simpson-1996-01-23", "1:562", "1:563");
    expect(x.answer).toMatch(/^A: Yes\.$/);
    expect(x.question).toMatch(/gate/);
    expect(x.speakerStatus).toBe("verified");
  });

  it("shows the Hutchinson limo answer in its context, with its question", async () => {
    const [x] = await exchangesAt(db, l, "hutchinson-2022-06-20", "6:4", "6:8");
    expect(x.question).toMatch(/conversation like/);
    expect(x.lines.some((r) => r.ref === "6:06" && /limo/.test(r.text))).toBe(true);
    const c = (await sourceContext(db, x.id!, { caseId: l.caseId, lines: 3 }))!;
    expect(c.before.map((r) => r.ref)).toEqual(["5:03", "5:04", "5:05"]);
  });

  it("reads Hutchinson's timestamp notes as notes", async () => {
    const notes = await db.select({ role: lines.speakerRole, text: lines.rawText }).from(lines).where(eq(lines.depositionId, l.docId.get("hutchinson-2022-06-20")!));
    const stamps = notes.filter((r) => /^\[\d{1,2}:\d{2} [ap]\.m\.\]$/.test(r.text));
    expect(stamps.length).toBeGreaterThan(0);
    expect(stamps.every((r) => r.role === "parenthetical")).toBe(true);
  });

  it("gives the same IDs when a real file is read again", async () => {
    const id = l.docId.get("simpson-1996-01-23")!;
    const before = (await db.select({ k: exchanges.evidenceKey }).from(exchanges).where(eq(exchanges.depositionId, id))).map((r) => r.k).sort();
    const again = await reloadFixture(db, FIXTURE, l, "simpson-1996-01-23");
    expect(again.id).toBe(id);
    expect((await db.select({ k: exchanges.evidenceKey }).from(exchanges).where(eq(exchanges.depositionId, id))).map((r) => r.k).sort()).toEqual(before);
  });
});
