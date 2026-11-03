// The Stage 1 evidence foundation on SYNTHETIC transcripts (invented witnesses and testimony, written
// for these tests; real fixtures are in evidenceReal.test.ts): sessions spanning files, stable IDs across
// re-ingestion, the original-testimony index, retrieval, context, attribution and coverage.
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../server/src/db/client";
import { cases, depositionSessions, depositions, exchanges, lines, orgs, witnesses } from "../../server/src/db/schema";
import { answerGroup, createSession, evidenceCoverage, getEvidence, indexEvidence, nextSessionPart, searchEvidence, sourceContext } from "../../server/src/evidence";
import { readDeposition, saveDeposition } from "../../server/src/ingest";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

const bytes = (s: string) => new TextEncoder().encode(s);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const page = (n: number, rows: string[]) => [`Page ${n}`, ...rows.map((r, i) => `${String(i + 1).padStart(2)}   ${r}`)].join("\n");

// SYNTHETIC. Witness A's first session: a short answer, an answer that runs onto the next page, an
// interjection by an unidentified speaker, and an objection.
const A1 = [
  page(1, ["Q.  Where were you on the morning of March 3?", "A.  At the loading dock on Pier 9.", "Q.  Did you see the blue truck arrive?", "A.  Yes.", "Q.  What happened when it arrived?", "A.  The driver got out and spoke to the foreman for a while, and then", "MR. LEE:  Objection, form.", "Q.  You may answer.", "A.  He drove off toward the warehouse gate before"]),
  page(2, ["the shift change at seven.", "Q.  Who else was there?", "A.  Two of the night crew.", "VOICE:  It was three.", "Q.  How many did you count?", "A.  Two."]),
].join("\n");
// SYNTHETIC. Witness A's second session, in two files: the second file starts mid-answer.
const A2_PART1 = page(1, ["Q.  Let's return to the truck. What colour was it?", "A.  Blue, a dark blue, with a white stripe along", "Q.  And the stripe ran where?"]);
const A2_PART2 = page(2, ["A.  Along the side, from the cab to the tailgate.", "Q.  Did you see the driver's face?", "A.  Not clearly."]);
// SYNTHETIC. A different session of witness A on the same date as session 2: must never be merged with it.
const A3 = page(1, ["Q.  This is a separate sitting. Did you see the blue truck again?", "A.  No."]);
// SYNTHETIC. Witness B, a text with no page or line numbers.
// SYNTHETIC. One answer of 61 lines over three pages: long enough to be split into overlapping parts.
const LONG = [
  page(1, ["Q.  Describe the whole night shift, from start to finish.", "A.  Line 1 of the long account.", ...Array.from({ length: 23 }, (_, i) => `line ${i + 2} of the long account.`)]),
  page(2, Array.from({ length: 25 }, (_, i) => `line ${i + 25} of the long account.`)),
  page(3, [...Array.from({ length: 12 }, (_, i) => `line ${i + 50} of the long account.`), "Q.  Anything else?", "A.  No."]),
].join("\n");
const B1 = ["Q. Where was the blue truck parked?", "A. By the warehouse gate, near the fence.", "Q. Did anyone get out?", "A. I don't recall."].join("\n");

describe.skipIf(!TEST_DATABASE_URL)("evidence foundation (Postgres, synthetic transcripts)", () => {
  let db: Database;
  let pool: Pool;
  let caseId: number;
  let otherCaseId: number;
  let witnessA: number;
  let witnessB: number;

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await emptyTables(db);
    const [org] = await db.insert(orgs).values({ name: "Synthetic" }).returning();
    [{ id: caseId }, { id: otherCaseId }] = await db.insert(cases).values([{ orgId: org.id, name: "Synthetic case" }, { orgId: org.id, name: "Another synthetic case" }]).returning();
    [{ id: witnessA }, { id: witnessB }] = await db.insert(witnesses).values([{ caseId, name: "Dana Rourke" }, { caseId, name: "Ellis Vance" }]).returning();
  });

  async function store(text: string, witnessId: number, takenOn: string, opts: { session?: { id: number; part: number }; kase?: number } = {}) {
    const name = witnessId === witnessA ? "Dana Rourke" : "Ellis Vance";
    const read = await readDeposition(bytes(text), undefined, undefined, name);
    const saved = await saveDeposition(db, { caseId: opts.kase ?? caseId, witnessId, takenOn, fileSha256: sha(text), storageKey: `synthetic/${sha(text)}`, read, session: opts.session });
    if (!("depositionId" in saved)) throw new Error("not saved");
    return saved.depositionId;
  }
  async function storeAll() {
    const a1 = await store(A1, witnessA, "2024-01-10");
    const a2p1 = await store(A2_PART1, witnessA, "2024-02-14");
    const [s] = await db.select({ sessionId: depositions.sessionId }).from(depositions).where(eq(depositions.id, a2p1));
    const a2p2 = await store(A2_PART2, witnessA, "2024-02-14", { session: { id: s.sessionId, part: await nextSessionPart(db, s.sessionId) } });
    const a3 = await store(A3, witnessA, "2024-02-14");
    const b1 = await store(B1, witnessB, "2024-01-20");
    return { a1, a2p1, a2p2, a3, b1 };
  }
  const allKeys = async () => (await db.select({ key: exchanges.evidenceKey, hash: exchanges.textHash }).from(exchanges)).map((r) => `${r.key}:${r.hash}`).sort();
  const find = async (q: string, f: Partial<Parameters<typeof searchEvidence>[2]> = {}) => searchEvidence(db, q, { caseId, ...f });

  describe("cases, witnesses, sessions and documents", () => {
    it("keeps several witnesses, several sessions of one witness, and several files of one session apart", async () => {
      const ids = await storeAll();
      const rows = await db.select().from(depositions);
      const sessionOf = (id: number) => rows.find((r) => r.id === id)!;
      expect(sessionOf(ids.a2p1).sessionId).toBe(sessionOf(ids.a2p2).sessionId);
      expect([sessionOf(ids.a2p1).sessionPart, sessionOf(ids.a2p2).sessionPart]).toEqual([1, 2]);
      // Same witness, same date, but stored without naming the session: a session of its own.
      expect(sessionOf(ids.a3).sessionId).not.toBe(sessionOf(ids.a2p1).sessionId);
      expect(new Set(rows.map((r) => r.sessionId)).size).toBe(4);
      const sessions = await db.select().from(depositionSessions);
      expect(sessions.filter((s) => s.witnessId === witnessA)).toHaveLength(3);
      expect(sessions.filter((s) => s.witnessId === witnessB)).toHaveLength(1);
    });

    it("refuses a file in another witness's session, or in a part already taken", async () => {
      const a = await store(A2_PART1, witnessA, "2024-02-14");
      const [s] = await db.select({ sessionId: depositions.sessionId }).from(depositions).where(eq(depositions.id, a));
      await expect(store(B1, witnessB, "2024-02-14", { session: { id: s.sessionId, part: 2 } })).rejects.toThrow();
      await expect(store(A2_PART2, witnessA, "2024-02-14", { session: { id: s.sessionId, part: 1 } })).rejects.toThrow();
    });

    it("removes a session with its last file, and keeps an empty one created on purpose", async () => {
      const kept = await createSession(db, { caseId, witnessId: witnessA, label: "Day 2" });
      const a = await store(A3, witnessA, "2024-02-14");
      const [s] = await db.select({ sessionId: depositions.sessionId }).from(depositions).where(eq(depositions.id, a));
      await db.delete(exchanges).where(eq(exchanges.depositionId, a));
      await db.delete(lines).where(eq(lines.depositionId, a));
      await db.delete(depositions).where(eq(depositions.id, a));
      const left = (await db.select().from(depositionSessions)).map((x) => x.id);
      expect(left).toContain(kept);
      expect(left).not.toContain(s.sessionId);
    });
  });

  describe("source integrity", () => {
    it("keeps every line's original text, and every exchange points at its own stored lines", async () => {
      const a1 = await store(A1, witnessA, "2024-01-10");
      const stored = await db.select().from(lines).where(eq(lines.depositionId, a1));
      const source = A1.split("\n").filter((r) => !r.startsWith("Page ")).map((r) => r.slice(5));
      expect(stored.map((l) => l.rawText).sort()).toEqual(source.sort());
      for (const e of await db.select().from(exchanges).where(eq(exchanges.depositionId, a1))) {
        const x = (await getEvidence(db, e.evidenceKey!, caseId))!;
        expect(x.documentId).toBe(a1);
        for (const r of x.lines) {
          const row = stored.find((l) => l.id === r.lineRowId)!;
          expect(row.rawText).toBe(r.text);
          expect(r.ref).toBe(`${row.printedPage}:${String(row.lineNo).padStart(2, "0")}`);
        }
        expect(x.integrity).toEqual({ textHashMatches: true, speakerStatusMatches: true });
      }
    });

    it("keeps an answer that runs onto the next page whole, with its question, and a short answer with its question", async () => {
      await store(A1, witnessA, "2024-01-10");
      const [shift] = (await find("shift change")).results;
      expect(shift.exchange.sourceEnd.ref).toBe("2:01");
      expect(shift.exchange.answer).toContain("the shift change at seven.");
      expect(shift.exchange.question).toContain("You may answer.");
      const [yes] = (await find("blue truck arrive")).results;
      expect(yes.exchange.answer).toBe("A.  Yes.");
      expect(yes.exchange.question).toContain("Did you see the blue truck arrive?");
    });

    it("cites a text without page or line numbers by its lines, never as page:line", async () => {
      await store(B1, witnessB, "2024-01-20");
      const [r] = (await find("fence")).results;
      expect(r.exchange.sourceStart).toMatchObject({ scheme: "file_line", citable: false, ref: "line 1" });
      expect(r.exchange.lines.every((l) => /^line \d+$/.test(l.ref))).toBe(true);
    });

    it("shows the lines around an exchange, and the next exchange across the session's next file", async () => {
      const { a2p1, a2p2 } = await storeAll();
      const [first] = (await find("colour", { documentId: a2p1 })).results;
      const c0 = (await sourceContext(db, first.exchange.id!, { caseId, lines: 2 }))!;
      expect(c0.before).toEqual([]);
      expect(c0.after.length).toBeGreaterThan(0);
      // Part 1 ends on a question; the answer to it opens part 2.
      expect(c0.next).toMatchObject({ documentId: a2p1, crossesDocument: false });
      const c = (await sourceContext(db, c0.next!.id!, { caseId }))!;
      expect(c.after).toEqual([]);
      expect(c.next).toMatchObject({ documentId: a2p2, crossesDocument: true });
      const resumed = (await getEvidence(db, c.next!.id!, caseId))!;
      // Its question is in the previous file: flagged, and reachable through the context, never stitched in.
      expect(resumed.flags).toContain("no_question");
      expect(resumed.question).toBe("");
      const back = (await sourceContext(db, resumed.id!, { caseId }))!;
      expect(back.previous).toMatchObject({ documentId: a2p1, crossesDocument: true });
    });
  });

  describe("stable identity", () => {
    it("gives the same IDs and hashes when a file is read again, without duplicating anything", async () => {
      const a1 = await store(A1, witnessA, "2024-01-10");
      const before = await allKeys();
      const [{ sessionId }] = await db.select({ sessionId: depositions.sessionId }).from(depositions).where(eq(depositions.id, a1));
      const again = await store(A1, witnessA, "2024-01-10");
      expect(again).toBe(a1);
      expect(await allKeys()).toEqual(before);
      expect((await db.select({ sessionId: depositions.sessionId }).from(depositions).where(eq(depositions.id, a1)))[0].sessionId).toBe(sessionId);
      expect(await db.$count(exchanges)).toBe(before.length);
    });

    it("gives the same IDs to the same file in a fresh database", async () => {
      await storeAll();
      const first = await allKeys();
      await emptyTables(db);
      const [org] = await db.insert(orgs).values({ name: "Synthetic" }).returning();
      [{ id: caseId }] = await db.insert(cases).values([{ orgId: org.id, name: "Synthetic case" }]).returning();
      [{ id: witnessA }, { id: witnessB }] = await db.insert(witnesses).values([{ caseId, name: "Dana Rourke" }, { caseId, name: "Ellis Vance" }]).returning();
      await storeAll();
      expect(await allKeys()).toEqual(first);
    });

    it("indexes exchanges stored before the evidence fields, idempotently, with the same values ingestion gives", async () => {
      await storeAll();
      const ingested = await allKeys();
      await db.update(exchanges).set({ evidenceKey: null, textHash: null, speakerStatus: null });
      expect((await evidenceCoverage(db, caseId)).totals.notIndexed).toBe(ingested.length);
      expect(await indexEvidence(db, { caseId })).toMatchObject({ examined: ingested.length, written: ingested.length, failed: [] });
      expect(await allKeys()).toEqual(ingested);
      expect(await indexEvidence(db, { caseId })).toMatchObject({ examined: 0, written: 0 });
      expect(await indexEvidence(db, { caseId, refresh: true })).toMatchObject({ examined: ingested.length, written: 0, unchanged: ingested.length });
    });

    it("notices when stored lines changed after indexing", async () => {
      await store(A1, witnessA, "2024-01-10");
      const [r] = (await find("Pier")).results;
      await db.update(lines).set({ rawText: "A.  At the loading dock on Pier 8." }).where(eq(lines.id, r.exchange.lines.find((l) => l.lineRole === "answer")!.lineRowId));
      expect((await getEvidence(db, r.exchange.id!, caseId))!.integrity.textHashMatches).toBe(false);
    });
  });

  describe("the original-testimony index", () => {
    it("indexes every exchange, with no model-made text", async () => {
      await storeAll();
      const all = await db.select().from(exchanges);
      expect(all.length).toBeGreaterThan(0);
      expect(all.every((e) => e.evidenceKey && e.textHash && e.speakerStatus)).toBe(true);
      expect((await evidenceCoverage(db, caseId)).totals).toMatchObject({ notIndexed: 0, witnessLinesInNoExchange: 0, exchanges: all.length });
      // Every Q/A exchange is findable by a word from its own answer.
      for (const e of all.filter((x) => x.kind === "qa" && x.answerText.trim())) {
        const word = e.answerText.split(/\W+/).filter((w) => w.length > 4).sort((x, y) => y.length - x.length)[0];
        if (!word) continue;
        const r = await find(word, { documentId: e.depositionId, limit: 200 });
        expect(r.results.some((x) => x.exchange.part.groupId === e.groupId), `${word} in deposition ${e.depositionId}`).toBe(true);
      }
    });

    it("finds testimony by its original words, with stable IDs and source references", async () => {
      await storeAll();
      const r = await find("warehouse gate");
      expect(r.results.length).toBeGreaterThan(0);
      for (const { exchange } of r.results) {
        expect(exchange.id).toMatch(/^ex_/);
        expect((await getEvidence(db, exchange.id!, caseId))!.rowId).toBe(exchange.rowId);
      }
    });

    it("filters by witness, session and document, and never returns another case's testimony", async () => {
      const { a2p1, a2p2 } = await storeAll();
      await store(A1, witnessA, "2024-01-10", { kase: otherCaseId }).catch(() => undefined); // witness A is not in that case: refused
      const otherWitness = (await db.insert(witnesses).values({ caseId: otherCaseId, name: "Dana Rourke" }).returning())[0].id;
      const read = await readDeposition(bytes(A1), undefined, undefined, "Dana Rourke");
      await saveDeposition(db, { caseId: otherCaseId, witnessId: otherWitness, takenOn: "2024-01-10", fileSha256: sha(A1), storageKey: "synthetic/x", read });
      const truck = await find("truck");
      expect(truck.results.every((x) => x.exchange.caseId === caseId)).toBe(true);
      expect((await find("truck", { witnessId: witnessB })).results.every((x) => x.exchange.witnessId === witnessB)).toBe(true);
      expect((await find("truck", { witnessId: witnessB })).results.length).toBeGreaterThan(0);
      const [{ sessionId }] = await db.select({ sessionId: depositions.sessionId }).from(depositions).where(eq(depositions.id, a2p1));
      const inSession = await find("truck OR stripe OR driver", { sessionId });
      expect(new Set(inSession.results.map((x) => x.exchange.documentId))).toEqual(new Set([a2p1, a2p2]));
      expect((await find("truck", { documentId: a2p2 })).results.every((x) => x.exchange.documentId === a2p2)).toBe(true);
      // The same file in two cases has the same IDs, so a lookup without a case is refused, not guessed.
      const [first] = truck.results;
      await expect(getEvidence(db, first.exchange.id!)).rejects.toThrow(/give the case/);
    });

    it("finds new testimony as soon as its file is stored", async () => {
      await store(A1, witnessA, "2024-01-10");
      expect((await find("tailgate")).matched).toBe(0);
      await store(A2_PART2, witnessA, "2024-02-14");
      expect((await find("tailgate")).matched).toBe(1);
    });
  });

  describe("speaker attribution", () => {
    it("tells the witness's answers from attorney lines, and keeps unidentified speech uncertain", async () => {
      await store(A1, witnessA, "2024-01-10");
      const [pier] = (await find("Pier")).results;
      expect(pier.exchange.speakerStatus).toBe("verified");
      expect(pier.exchange.lines.map((l) => [l.lineRole, l.speaker])).toEqual([["question", "attorney"], ["answer", "witness"]]);
      const [count] = (await find("night crew")).results;
      expect(count.exchange.speakerStatus).toBe("uncertain");
      expect(count.exchange.speakerReasons.join(" ")).toMatch(/no identified speaker/);
      const objection = (await db.select().from(exchanges)).filter((e) => e.kind === "objection");
      expect(objection.every((e) => e.speakerStatus === "invalid")).toBe(true);
    });

    it("never promotes an uncertain or invalid answer: indexing recomputes it from the lines", async () => {
      await store(A1, witnessA, "2024-01-10");
      const [count] = (await find("night crew")).results;
      await db.update(exchanges).set({ speakerStatus: "verified" }).where(eq(exchanges.id, count.exchange.rowId));
      expect((await getEvidence(db, count.exchange.id!, caseId))!.integrity.speakerStatusMatches).toBe(false);
      await indexEvidence(db, { caseId, refresh: true });
      expect((await getEvidence(db, count.exchange.id!, caseId))!.speakerStatus).toBe("uncertain");
    });
  });

  describe("coverage", () => {
    it("reports each file's scheme, counts and session, and a file that couldn't be read", async () => {
      const { b1 } = await storeAll();
      const unread = await saveDeposition(db, { caseId, witnessId: witnessB, takenOn: null, fileSha256: sha("empty"), storageKey: "synthetic/empty", read: await readDeposition(bytes("   \n")) });
      const c = await evidenceCoverage(db, caseId);
      expect(c.totals.documents).toBe(6);
      expect(c.totals.notRead).toBe(1);
      expect(c.documents.find((d) => d.documentId === b1)).toMatchObject({ scheme: "file_line", status: "ready" });
      expect(c.documents.find((d) => "depositionId" in unread && d.documentId === unread.depositionId)!.notes[0]).toMatch(/not read/);
      expect(c.sessions.find((s) => s.files === 2)).toMatchObject({ dates: ["2024-02-14"], notes: [] });
      await db.update(depositions).set({ takenOn: "2024-02-15" }).where(and(eq(depositions.caseId, caseId), eq(depositions.sessionPart, 2)));
      expect((await evidenceCoverage(db, caseId)).sessions.find((s) => s.files === 2)!.notes).toEqual(["its files have different dates"]);
    });
  });

  describe("long answers split into parts", () => {
    it("keeps every line reachable, shares the overlap explicitly, and rebuilds the answer once", async () => {
      const doc = await store(LONG, witnessA, "2024-03-01");
      const parts = await db.select().from(exchanges).where(and(eq(exchanges.depositionId, doc), eq(exchanges.partCount, 2)));
      expect(parts).toHaveLength(2);
      const [one, two] = await Promise.all(parts.sort((x, y) => x.partNo - y.partNo).map((p) => getEvidence(db, p.evidenceKey!, caseId)));
      // Each part keeps the question, so a later part still reads as an answer to it.
      expect(two!.question).toContain("Describe the whole night shift");
      expect(one!.part.sharedWithNext).toBe(two!.part.sharedWithPrevious);
      expect(two!.part.sharedWithPrevious).toBe(6); // the question and five answer lines
      const whole = (await answerGroup(db, two!.id!, caseId))!;
      const stored = (await db.select().from(lines).where(eq(lines.depositionId, doc))).filter((l) => !/Anything else|^A\.  No\.$/.test(l.rawText));
      expect(whole.lines.map((l) => l.lineRowId).sort()).toEqual(stored.map((l) => l.id).sort()); // no line dropped, none twice
      const answerLines = whole.answer.split("\n");
      expect(answerLines).toHaveLength(61);
      expect(new Set(answerLines).size).toBe(61);
      expect(whole.parts.map((p) => p.partNo)).toEqual([1, 2]);
    });
  });
});
