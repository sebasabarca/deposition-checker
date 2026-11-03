// Re-reading a stored document under the current parser (evidence/audit.ts), on a SYNTHETIC archive
// transcript (invented speakers and testimony): the audit finds an older parse's artifact in stored rows,
// the dry run changes nothing, the re-read replaces lines and exchanges in place (same document, session
// and exchange IDs), and it refuses to remove findings unless that impact is accepted.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../server/src/db/client";
import { candidates, cases, depositions, exchanges, findings, lineSegments, lines, orgs, verdicts, witnesses } from "../../server/src/db/schema";
import { correctInPlace, parserAudit, reprocessDocument } from "../../server/src/evidence";
import { PARSER_VERSION, readDeposition, saveDeposition } from "../../server/src/ingest";
import { buildExchangeParts } from "../../server/src/ingest/exchanges";
import { speakerSegments } from "../../server/src/ingest/segments";
import { TEXT_ARCHIVE_V1 } from "../../server/src/ingest/text";
import { storeUpload } from "../../server/src/ingest/uploads";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

// SYNTHETIC archive export: numbered statements, full-name labels, one statement with two turns.
const run = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `${from + i} ${i % 2 ? "A" : "Q"}: synthetic statement ${from + i} about the harbour crane.`);
const ARCHIVE = ["ARCHIVE-DERIVED TRANSCRIPT EXPORT (SYNTHETIC)", ...run(1, 20), "21 NORA QUILL: Objection, form.", "22 Q: Did the crane move? A.Yes, it did.", ...run(23, 40)].join("\n");

describe.skipIf(!TEST_DATABASE_URL)("re-reading a stored document (Postgres, synthetic archive)", () => {
  let db: Database;
  let pool: Pool;
  let uploads: string;
  let caseId: number;
  let witnessId: number;
  let doc: number;

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
    uploads = mkdtempSync(path.join(tmpdir(), "reprocess-"));
  });
  afterAll(async () => {
    await pool.end();
    rmSync(uploads, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await emptyTables(db);
    const [org] = await db.insert(orgs).values({ name: "Synthetic" }).returning();
    [{ id: caseId }] = await db.insert(cases).values({ orgId: org.id, name: "Synthetic archive" }).returning();
    [{ id: witnessId }] = await db.insert(witnesses).values({ caseId, name: "Iris Calloway" }).returning();
    const data = new TextEncoder().encode(ARCHIVE);
    const { fileSha256, storageKey } = await storeUpload(data, uploads);
    const saved = await saveDeposition(db, { caseId, witnessId, takenOn: "2024-05-01", fileSha256, storageKey, read: await readDeposition(data, undefined, undefined, "Iris Calloway") });
    if (!("depositionId" in saved)) throw new Error("not saved");
    doc = saved.depositionId;
  });

  // What an older parser stored: the named speaker unknown, no segments, an older version.
  async function ageTheParse() {
    await db.update(lines).set({ speakerRole: "unknown" }).where(and(eq(lines.depositionId, doc), eq(lines.lineNo, 21)));
    await db.delete(lineSegments).where(eq(lineSegments.depositionId, doc));
    await db.update(depositions).set({ parserVersion: "pdfjs-ellison-doj-v1-r7" }).where(eq(depositions.id, doc));
  }
  const keys = async () => (await db.select({ k: exchanges.evidenceKey }).from(exchanges).where(eq(exchanges.depositionId, doc))).map((r) => r.k).sort();

  it("stores the current parse with its segments, and the audit finds nothing to fix", async () => {
    const [segmented] = await db.select().from(lines).where(and(eq(lines.depositionId, doc), eq(lines.lineNo, 22)));
    expect(segmented.rawText).toBe("Q: Did the crane move? A.Yes, it did.");
    expect((await db.select().from(lineSegments).where(eq(lineSegments.lineId, segmented.id))).map((s) => s.speakerRole)).toEqual(["attorney", "witness"]);
    const [named] = await db.select().from(lines).where(and(eq(lines.depositionId, doc), eq(lines.lineNo, 21)));
    expect(named.speakerRole).toBe("colloquy");
    const [audit] = await parserAudit(db, { caseId });
    expect(audit).toMatchObject({ current: true, action: "current", artifacts: { namedSpeakerUnknown: 0, unsegmentedTurns: 0 } });
  });

  it("finds an older parse's artifacts in stored rows, and the dry run changes nothing", async () => {
    await ageTheParse();
    const [audit] = await parserAudit(db, { caseId });
    expect(audit).toMatchObject({ current: false, artifacts: { namedSpeakerUnknown: 1, unsegmentedTurns: 1 }, action: "re-read needed; no findings affected" });
    const before = await keys();
    const r = await reprocessDocument(db, doc, { uploadsDir: uploads });
    expect(r.outcome).toBe("dry_run");
    if (!("changes" in r)) throw new Error("no report");
    expect(r.changes.speakerChanged).toHaveLength(1);
    expect(r.changes.segmented).toHaveLength(1);
    expect(r.changes.textChanged).toEqual([]);
    expect((await db.select().from(depositions).where(eq(depositions.id, doc)))[0].parserVersion).toBe("pdfjs-ellison-doj-v1-r7");
    expect(await keys()).toEqual(before);
  });

  it("re-reads in place: same document, session and exchange IDs, artifacts gone", async () => {
    await ageTheParse();
    const [{ sessionId }] = await db.select({ sessionId: depositions.sessionId }).from(depositions).where(eq(depositions.id, doc));
    const before = await keys();
    const r = await reprocessDocument(db, doc, { execute: true, uploadsDir: uploads });
    expect(r.outcome).toBe("reprocessed");
    const [after] = await db.select().from(depositions).where(eq(depositions.id, doc));
    expect(after).toMatchObject({ parserVersion: PARSER_VERSION, sessionId });
    expect(await db.$count(depositions)).toBe(1);
    expect(await keys()).toEqual(before);
    const [audit] = await parserAudit(db, { caseId });
    expect(audit.artifacts).toMatchObject({ namedSpeakerUnknown: 0, unsegmentedTurns: 0 });
  });

  it("refuses to remove findings unless the impact is accepted", async () => {
    await ageTheParse();
    // A finding on this document's exchanges: what a re-read would remove.
    const others = await db.select().from(exchanges).where(and(eq(exchanges.depositionId, doc), eq(exchanges.kind, "qa")));
    const [x, y] = [others[0], others[1]];
    const [c] = await db.insert(candidates).values({ candidateSet: "t", witnessId, depositionA: doc, groupA: x.groupId, depositionB: doc, groupB: y.groupId, exchangeA: x.id, exchangeB: y.id, sources: ["direct"], rrfScore: 0, mergedRank: 1, evidence: [] }).returning();
    const [v] = await db.insert(verdicts).values({ candidateId: c.id, model: "fixture", promptVersion: "x", effort: "low", status: "valid", parsed: {}, packet: {}, origin: "fixture" }).returning();
    await db.insert(findings).values({ caseId, candidateId: c.id, verdictId: v.id, type: "direct", evidenceStatus: "verified", attributionA: "clear", attributionB: "clear", factors: [], caps: [], checks: {}, rubricVersion: "x", priority: "high" });
    const refused = await reprocessDocument(db, doc, { execute: true, uploadsDir: uploads });
    expect(refused).toMatchObject({ outcome: "refused", impact: { findings: 1 } });
    expect((await db.select().from(depositions).where(eq(depositions.id, doc)))[0].parserVersion).toBe("pdfjs-ellison-doj-v1-r7");
    expect(await db.$count(findings)).toBe(1);
  });

  // A finding on two exchanges, the way an analysis stores one.
  async function findingOn(x: typeof exchanges.$inferSelect, y: typeof exchanges.$inferSelect, reviewState = "unreviewed") {
    const [c] = await db.insert(candidates).values({ candidateSet: "t", witnessId, depositionA: x.depositionId, groupA: x.groupId, depositionB: y.depositionId, groupB: y.groupId, exchangeA: x.id, exchangeB: y.id, sources: ["direct"], rrfScore: 0, mergedRank: 1, evidence: [] }).returning();
    const [v] = await db.insert(verdicts).values({ candidateId: c.id, model: "fixture", promptVersion: "x", effort: "low", status: "valid", parsed: {}, packet: {}, origin: "fixture" }).returning();
    const [f] = await db.insert(findings).values({ caseId, candidateId: c.id, verdictId: v.id, type: "direct", evidenceStatus: "verified", attributionA: "clear", attributionB: "clear", factors: [], caps: [], checks: {}, rubricVersion: "x", priority: "high", reviewState }).returning();
    return f;
  }
  const exchangeRows = async (d: number) => (await db.select().from(exchanges).where(eq(exchanges.depositionId, d))).sort((a, b) => a.groupId - b.groupId || a.partNo - b.partNo);
  const lineRows = async (d: number) => (await db.select().from(lines).where(eq(lines.depositionId, d))).sort((a, b) => a.lineNo - b.lineNo);

  it("corrects speaker attribution in place: every line, exchange and finding (a reviewed one too) keeps its ID", async () => {
    await ageTheParse();
    const qa = (await exchangeRows(doc)).filter((e) => e.kind === "qa");
    const reviewed = await findingOn(qa[0], qa[5], "confirmed");
    const linesBefore = await lineRows(doc);
    const idsBefore = (await exchangeRows(doc)).map((e) => e.id);
    const backupDir = mkdtempSync(path.join(tmpdir(), "backup-"));
    const dry = await correctInPlace(db, doc, { uploadsDir: uploads, backupDir });
    expect(dry).toMatchObject({ outcome: "dry_run", lines: { textChanged: 0, speakerChanged: 1 }, findings: { total: 1, carriesOver: 1 } });
    expect((await lineRows(doc)).find((l) => l.lineNo === 21)!.speakerRole).toBe("unknown"); // the dry run changed nothing
    const r = await correctInPlace(db, doc, { uploadsDir: uploads, backupDir, execute: true });
    expect(r.outcome).toBe("corrected");
    const linesAfter = await lineRows(doc);
    expect(linesAfter.map((l) => [l.id, l.rawText])).toEqual(linesBefore.map((l) => [l.id, l.rawText]));
    expect(linesAfter.find((l) => l.lineNo === 21)!.speakerRole).toBe("colloquy");
    expect((await exchangeRows(doc)).map((e) => e.id)).toEqual(idsBefore);
    expect(await db.select().from(findings)).toMatchObject([{ id: reviewed.id, reviewState: "confirmed" }]);
    expect(await db.$count(lineSegments, eq(lineSegments.depositionId, doc))).toBe(2);
    expect((await db.select().from(depositions).where(eq(depositions.id, doc)))[0].parserVersion).toBe(PARSER_VERSION);
    // The backup holds what was overwritten: line 21's old speaker.
    if (r.outcome !== "corrected") throw new Error("not corrected");
    expect(existsSync(r.backup)).toBe(true);
    const backup = JSON.parse(readFileSync(r.backup, "utf8"));
    expect(backup.lines).toEqual([{ id: linesBefore.find((l) => l.lineNo === 21)!.id, speakerRole: "unknown" }]);
    rmSync(backupDir, { recursive: true, force: true });
  });

  describe("an answer and the next question on one statement, stored by revision 9", () => {
    // SYNTHETIC: statement 22 ends one exchange and starts the next.
    const TEXT = ["ARCHIVE-DERIVED TRANSCRIPT EXPORT (SYNTHETIC, SECOND FILE)", ...run(1, 21), "22 A: Yes, it did. Q. And then?", "23 A: It stopped at the pier.", ...run(24, 40)].join("\n");
    let second: number;
    // What revision 9 stored: the statement's segments, but exchanges built line by line, so the question
    // inside 22 stayed in the exchange of 21's question, and 23's answer was read as answering 21.
    beforeEach(async () => {
      const data = new TextEncoder().encode(TEXT);
      const { fileSha256, storageKey } = await storeUpload(data, uploads);
      const read = await readDeposition(data, undefined, undefined, "Iris Calloway");
      const plain = read.exchanges!.lines.map(({ segments: _s, index: _i, turn: _t, role: _r, speakerName: _n, ...l }) => l);
      const old = buildExchangeParts(plain, TEXT_ARCHIVE_V1, "calloway");
      for (const l of old.lines) {
        const segs = speakerSegments(l.rawText, "calloway");
        if (segs.length) l.segments = segs;
      }
      const saved = await saveDeposition(db, { caseId, witnessId, takenOn: "2024-05-02", fileSha256, storageKey, read: { ...read, parserVersion: "pdfjs-ellison-doj-v1-r9", exchanges: old } });
      if (!("depositionId" in saved)) throw new Error("not saved");
      second = saved.depositionId;
    });
    const holding = async (lineNo: number) => {
      const [l] = (await lineRows(second)).filter((x) => x.lineNo === lineNo);
      return (await exchangeRows(second)).filter((e) => e.firstLineId === l.id || e.lastLineId === l.id);
    };

    it("splits the statement's turns into two exchanges, keeping source lines and untouched exchange IDs", async () => {
      const qa = (await exchangeRows(second)).filter((e) => e.kind === "qa");
      const kept = await findingOn(qa[0], qa[1], "dismissed"); // far from statement 22
      const before = await exchangeRows(second);
      const linesBefore = await lineRows(second);
      const [l21] = (await lineRows(second)).filter((x) => x.lineNo === 21);
      expect((await holding(23)).map((e) => e.firstLineId)).toEqual([l21.id]); // revision 9's defect
      const r = await correctInPlace(db, second, { uploadsDir: uploads, backupDir: uploads, execute: true });
      expect(r).toMatchObject({ outcome: "corrected", exchanges: { replacedUnreferenced: 1, added: 2, referencedWouldChange: 0 } });
      expect((await lineRows(second)).map((l) => [l.id, l.rawText, l.speakerRole])).toEqual(linesBefore.map((l) => [l.id, l.rawText, l.speakerRole]));
      const after = await exchangeRows(second);
      const untouched = before.filter((e) => after.some((a) => a.id === e.id));
      expect(untouched).toHaveLength(before.length - 1);
      for (const e of untouched) expect(after.find((a) => a.id === e.id)!.evidenceKey).toBe(e.evidenceKey);
      const [ends, starts] = await holding(22);
      expect(ends.firstLineId).toBe(l21.id);
      expect(ends.answerText).toBe("A: Yes, it did.");
      expect(starts).toMatchObject({ questionText: "And then?", answerText: "A: It stopped at the pier.", flags: [], speakerStatus: "verified" });
      expect(await db.select().from(findings)).toMatchObject([{ id: kept.id, reviewState: "dismissed" }]);
      const audit = (await parserAudit(db, { caseId })).find((d) => d.documentId === second)!;
      expect(audit.current).toBe(true);
    });

    it("refuses, changing nothing, when a finding's exchange would change its lines, and maps it to the corrected exchanges", async () => {
      const [answerOnly] = await holding(23);
      const qa = (await exchangeRows(second)).filter((e) => e.kind === "qa");
      await findingOn(qa[0], answerOnly, "confirmed");
      const before = await exchangeRows(second);
      const r = await correctInPlace(db, second, { uploadsDir: uploads, backupDir: uploads, execute: true });
      expect(r.outcome).toBe("needs_versioned_migration");
      if (r.outcome !== "needs_versioned_migration") return;
      // Statements 21-23 now form two exchanges, 21-22 and 22-23, each holding part of the old one.
      expect(r.mapping).toEqual([expect.objectContaining({ exchangeRowId: answerOnly.id, lines: 3, to: [expect.objectContaining({ relation: "holds part of it", sharedLines: 2 }), expect.objectContaining({ relation: "holds part of it", sharedLines: 2 })] })]);
      expect(r.findings.requiresReview).toEqual([expect.objectContaining({ reviewState: "confirmed", verdict: "requires_review: its exchange's lines change" })]);
      expect(await exchangeRows(second)).toEqual(before);
      expect((await db.select().from(depositions).where(eq(depositions.id, second)))[0].parserVersion).toBe("pdfjs-ellison-doj-v1-r9");
      expect(await db.$count(findings)).toBe(1);
    });
  });

  it("keeps the evidence as it is when the stored file is gone", async () => {
    await db.update(depositions).set({ storageKey: "fixtures/none" }).where(eq(depositions.id, doc));
    expect(await reprocessDocument(db, doc, { execute: true, uploadsDir: uploads })).toMatchObject({ outcome: "stored_file_missing" });
  });
});
