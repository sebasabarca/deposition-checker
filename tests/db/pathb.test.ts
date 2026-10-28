// Path B full-text retrieval against small hand-built sessions, and once on the real Ellison PDFs.
// See tests/db/database.ts for when these run.

import { existsSync, readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../server/src/db/client";
import { cases, depositions, exchanges, lines, orgs, witnesses } from "../../server/src/db/schema";
import { PARSER_VERSION, readDeposition, saveDeposition } from "../../server/src/ingest";
import { sha256 } from "../../server/src/ingest/uploads";
import { findPathB, MATCHES_PER_QUERY } from "../../server/src/retrieve";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

const RAW = "data/raw/ellison";
let fileNo = 0;

describe.skipIf(!TEST_DATABASE_URL)("Path B retrieval (Postgres)", () => {
  let pool: Pool;
  let db: Database;
  let caseId: number;
  let witnessId: number;

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
    caseId = kase.id;
    witnessId = (await db.insert(witnesses).values({ caseId, name: "Lawrence Ellison" }).returning())[0].id;
    await background();
  });

  // Unrelated testimony from another witness in the case. It is never searched (Path B pairs only
  // one witness's sessions), but like a real case it gives the words a frequency: in a case where
  // every exchange said "SAP merger", those words would carry no weight and pair nothing.
  const UNRELATED = ["harbor tugboat", "violin rosin", "granite quarry", "orchard pruning", "glacier survey", "lantern wick", "kayak paddle", "saffron harvest"];
  async function background() {
    const [other] = await db.insert(witnesses).values({ caseId, name: "Background witness" }).returning();
    const deposition = await session("ready", other.id);
    for (const words of UNRELATED) await exchange(deposition, `Tell me about the ${words}?`, `The ${words} was fine.`);
  }

  async function session(status: "ready" | "needs_review" = "ready", witness = witnessId) {
    const [row] = await db
      .insert(depositions)
      .values({
        caseId,
        witnessId: witness,
        fileSha256: String(++fileNo).padStart(64, "0"),
        storageKey: `${fileNo}.pdf`,
        pageCount: 1,
        validation: { status } as never,
        parserVersion: PARSER_VERSION,
        status,
      })
      .returning();
    return row;
  }

  // One exchange part with one source line; enough for retrieval, which reads only its text. Parts
  // of a split exchange share a group.
  let lineNo = 0;
  async function exchange(
    deposition: { id: number; witnessId: number },
    question: string,
    answer: string,
    kind: "qa" | "exhibit" = "qa",
    split?: { group: number; part: number },
  ) {
    const [line] = await db
      .insert(lines)
      .values({ depositionId: deposition.id, pdfPage: 1, printedPage: 1, lineNo: ++lineNo, speakerRole: "witness", rawText: answer, normText: answer })
      .returning();
    const [row] = await db
      .insert(exchanges)
      .values({
        depositionId: deposition.id,
        witnessId: deposition.witnessId,
        groupId: split?.group ?? 1000 + lineNo,
        partNo: split?.part ?? 1,
        partCount: split ? 2 : 1,
        kind,
        firstLineId: line.id,
        lastLineId: line.id,
        answerLineCount: 1,
        questionText: question,
        answerText: answer,
        dialogueText: `Q: ${question}\nA: ${answer}`,
      })
      .returning({ id: exchanges.id });
    return row.id;
  }

  const ids = (pairs: { exchangeA: number; exchangeB: number }[]) => pairs.map((p) => [p.exchangeA, p.exchangeB]);

  it("pairs exchanges on a shared subject across sessions, never within one, nor with another witness or a deposition that isn't ready", async () => {
    const earlier = await session();
    const later = await session();
    const a = await exchange(earlier, "Did Oracle discuss the SAP merger pricing?", "We discussed SAP merger pricing with Safra.");
    const sameSessionAsA = await exchange(earlier, "Was SAP merger pricing raised again?", "SAP merger pricing came up again.");
    const b = await exchange(later, "Tell me about the SAP merger pricing.", "Safra handled the SAP merger pricing.");
    const sameSessionAsB = await exchange(later, "Who set SAP merger pricing?", "Safra set SAP merger pricing.");
    await exchange(await session("needs_review"), "SAP merger pricing?", "SAP merger pricing, yes.");
    const otherWitness = (await db.insert(witnesses).values({ caseId, name: "Safra Catz" }).returning())[0].id; // not searched
    await exchange(await session("ready", otherWitness), "SAP merger pricing?", "SAP merger pricing, Safra.");

    const { pairs, counts } = await findPathB(db, { witnessId, depositionId: later.id, mode: "all_terms" });
    expect(ids(pairs).sort()).toEqual(
      [
        [a, b],
        [a, sameSessionAsB],
        [sameSessionAsA, b],
        [sameSessionAsA, sameSessionAsB],
      ].sort(),
    );
    expect(counts).toEqual({ exchanges: 4, procedural: 0, tooFewTerms: 0, queried: 4 });
    const ab = pairs.find((p) => p.exchangeA === a && p.exchangeB === b)!;
    expect(ab.sharedTerms).toEqual(expect.arrayContaining(["sap", "merger", "price", "safra"]));
    expect(ab.foundBy).toBe("both");
  });

  it("keeps the top matches per query, and still finds a pair that only the other direction's query reaches", async () => {
    const earlier = await session();
    const later = await session();
    // Six exchanges in the earlier session all match the later one's query; its top 5 can't hold
    // them all, but each earlier exchange's own query finds the later one.
    const targets = [];
    for (let i = 0; i < MATCHES_PER_QUERY + 1; i++) {
      targets.push(await exchange(earlier, "Tell me about the cormorant licence?", `The cormorant licence covered ${"zeppelin ".repeat(i)}freight.`));
    }
    const source = await exchange(later, "Was the cormorant licence for freight?", "Yes, cormorant freight under the licence.");

    const { pairs } = await findPathB(db, { witnessId, depositionId: later.id, mode: "all_terms" });
    expect(ids(pairs).sort()).toEqual(targets.map((t) => [t, source]).sort());
    expect(pairs.filter((p) => p.foundBy === "both")).toHaveLength(MATCHES_PER_QUERY);
    expect(pairs.filter((p) => p.foundBy === "a")).toHaveLength(1);
  });

  it("makes one candidate of two split exchanges, keeping the best part pair as its source references", async () => {
    const earlier = await session();
    const later = await session();
    const a1 = await exchange(earlier, "Was the tapir merger priced in euros?", "The tapir merger was priced in euros by the board.", "qa", { group: 1, part: 1 });
    const a2 = await exchange(earlier, "Was the tapir merger priced in euros?", "Later the board revisited the tapir merger.", "qa", { group: 1, part: 2 });
    const b1 = await exchange(later, "Tell me about the tapir merger in euros.", "The tapir merger was priced in euros by the board.", "qa", { group: 1, part: 1 });
    const b2 = await exchange(later, "Tell me about the tapir merger in euros.", "And then we moved on to other things.", "qa", { group: 1, part: 2 });

    const { pairs } = await findPathB(db, { witnessId, depositionId: later.id, mode: "all_terms" });
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ a: { depositionId: earlier.id, groupId: 1 }, b: { depositionId: later.id, groupId: 1 }, exchangeA: a1, exchangeB: b1 });
    expect([a2, b2]).not.toContain(pairs[0].exchangeA);
  });

  it("counts the top matches per query by logical exchange, so a split answer takes one slot, and finds short exchanges", async () => {
    const earlier = await session();
    const later = await session();
    // Seven earlier parts, six logical exchanges, all too short to query: only the later query can find them.
    await exchange(earlier, "Cormorant licence?", "Cormorant licence.", "qa", { group: 1, part: 1 });
    await exchange(earlier, "Cormorant licence?", "Cormorant licence.", "qa", { group: 1, part: 2 });
    for (let i = 0; i < MATCHES_PER_QUERY; i++) await exchange(earlier, "Cormorant licence?", "Cormorant licence.");
    await exchange(later, "Was the cormorant licence for freight?", "Cormorant freight under the licence.");

    const { pairs, counts } = await findPathB(db, { witnessId, depositionId: later.id, mode: "all_terms" });
    expect(counts).toMatchObject({ tooFewTerms: 7, queried: 1 });
    expect(pairs).toHaveLength(MATCHES_PER_QUERY); // five logical exchanges, not four plus a second part
    expect(new Set(pairs.map((p) => `${p.a.depositionId}:${p.a.groupId}`)).size).toBe(MATCHES_PER_QUERY);
  });

  it("applies the two-shared-terms rule before the top-5 cut, so zero-score matches can't take the slots", async () => {
    const earlier = await session();
    const later = await session();
    // Five targets that ts_rank_cd ranks highest but that share only one weighted term with the
    // query, and a sixth, ranked lower, that shares two. All six are too short to query themselves.
    const oneShared = [];
    for (let i = 0; i < MATCHES_PER_QUERY; i++) {
      oneShared.push(await exchange(earlier, "Cormorant?", "Cormorant cormorant cormorant cormorant cormorant."));
    }
    const twoShared = await exchange(earlier, "Freight?", "Zeppelin freight.");
    const source = await exchange(later, "Was the cormorant licence for freight by zeppelin?", "Cormorant freight went by zeppelin.");

    // The scenario holds: ts_rank_cd puts every one-shared-term target above the two-shared-term one.
    const ranks = await db.execute<{ id: string; rank: number }>(sql`
      select t.id, ts_rank_cd(t.tsv, to_tsquery('cormor | licenc | freight | zeppelin'), 1) as rank
      from exchanges t where t.deposition_id = ${earlier.id}`);
    const rankOf = new Map(ranks.rows.map((r) => [Number(r.id), Number(r.rank)]));
    expect(Math.min(...oneShared.map((id) => rankOf.get(id)!))).toBeGreaterThan(rankOf.get(twoShared)!);

    const { pairs } = await findPathB(db, { witnessId, depositionId: later.id, mode: "all_terms" });
    expect(pairs.map((p) => [p.exchangeA, p.exchangeB])).toEqual([[twoShared, source]]);
    expect(pairs.every((p) => p.score > 0)).toBe(true);
  });

  it("known limit: two two-term exchanges can't find each other, though a longer exchange still finds a two-term one", async () => {
    const earlier = await session();
    const later = await session();
    await exchange(earlier, "Tapir licence?", "Tapir licence.");
    const short = await exchange(later, "The tapir licence?", "Yes, the tapir licence.");
    const { pairs, counts } = await findPathB(db, { witnessId, depositionId: later.id, mode: "all_terms" });
    expect(counts).toMatchObject({ queried: 0, tooFewTerms: 2 });
    expect(pairs).toEqual([]); // the documented limit (procedural.ts): neither side runs a query

    const long = await exchange(earlier, "Was the tapir licence renewed in Texas?", "The tapir licence was renewed in Texas.");
    const found = await findPathB(db, { witnessId, depositionId: later.id, mode: "all_terms" });
    expect(found.pairs.map((p) => [p.exchangeA, p.exchangeB])).toContainEqual([long, short]);
  });

  it("has a GIN index on the full-text column", async () => {
    const result = await db.execute<{ indexdef: string }>(sql`select indexdef from pg_indexes where indexname = 'exchanges_tsv_idx'`);
    expect(result.rows[0]?.indexdef).toMatch(/USING gin \(tsv\)/);
  });

  it("counts procedural exchanges and ones with too few terms instead of querying them", async () => {
    const earlier = await session();
    const later = await session();
    await exchange(earlier, "Would you state your full name?", "Lawrence Joseph Ellison, Redwood Shores.");
    await exchange(earlier, "Marked as Exhibit 17.", "Exhibit 17 document.", "exhibit");
    await exchange(later, "Did you sign it?", "Yes.");
    await exchange(later, "Was the bassoon contract signed in Texas?", "The bassoon contract was signed in Texas.");

    const { pairs, counts } = await findPathB(db, { witnessId, depositionId: later.id, mode: "all_terms" });
    expect(counts).toEqual({ exchanges: 4, procedural: 2, tooFewTerms: 1, queried: 1 });
    expect(pairs).toEqual([]);
  });

  it("ignores courtroom words: two exchanges sharing only those are not a pair", async () => {
    const earlier = await session();
    const later = await session();
    await exchange(earlier, "Objection to form and foundation, counsel. Mark the exhibit for the record?", "Okay, sir, yes, correct, right.");
    await exchange(later, "Objection, form. Strike that from the record, counsel. Exhibit marked?", "Yes sir, okay, that's right, correct.");
    await exchange(later, "Was the tapir agreement priced in euros?", "The tapir agreement was priced in euros.");

    const { pairs } = await findPathB(db, { witnessId, depositionId: later.id, mode: "all_terms" });
    expect(pairs).toEqual([]);
  });

  it("rare_terms queries with the exchange's rarest terms, so a pair sharing only commoner words is left out", async () => {
    const earlier = await session();
    const later = await session();
    // "pricing" and "review" are in several exchanges of the case; the source's other 12 terms are
    // each rare. The pricing-review exchanges are too short to run queries of their own, so only the
    // source's query can reach them.
    const sharesCommonTerms = [];
    for (let i = 0; i < 3; i++) sharesCommonTerms.push(await exchange(earlier, "Pricing review?", "Pricing review."));
    const sharesRareTerms = await exchange(earlier, "Did the aardvark and bassoon teams meet?", "The aardvark and bassoon teams met.");
    const source = await exchange(
      later,
      "Pricing review for aardvark, bassoon, cormorant, dulcimer, egret, flamingo?",
      "Gazelle, harpsichord, ibis, jackal, kestrel, lemur.",
    );

    const all = await findPathB(db, { witnessId, depositionId: later.id, mode: "all_terms" });
    const rare = await findPathB(db, { witnessId, depositionId: later.id, mode: "rare_terms" });
    const partners = (r: typeof all) => r.pairs.map((p) => (p.exchangeA === source ? p.exchangeB : p.exchangeA)).sort();
    expect(partners(rare)).toEqual([sharesRareTerms]);
    expect(partners(all)).toEqual([...sharesCommonTerms, sharesRareTerms].sort());
  });

  it.skipIf(!existsSync(`${RAW}/p3171.pdf`) || !existsSync(`${RAW}/p3173.pdf`))(
    "on Ellison P3171 and P3173, every pair joins the two sessions and every exchange is accounted for",
    async () => {
      const saved = [];
      for (const doc of ["p3171", "p3173"]) {
        const data = new Uint8Array(readFileSync(`${RAW}/${doc}.pdf`));
        const read = await readDeposition(data);
        saved.push(await saveDeposition(db, { caseId, witnessId, takenOn: null, fileSha256: sha256(data), storageKey: `${doc}.pdf`, read }));
      }
      const sessionOf = new Map((await db.select({ id: exchanges.id, d: exchanges.depositionId }).from(exchanges)).map((e) => [e.id, e.d]));
      for (const mode of ["all_terms", "rare_terms"] as const) {
        const { pairs, counts } = await findPathB(db, { witnessId, depositionId: saved[1].depositionId, mode });
        expect(counts.exchanges).toBe(534 + 213);
        expect(counts.procedural + counts.tooFewTerms + counts.queried).toBe(counts.exchanges);
        expect(pairs.length).toBeGreaterThan(1000);
        expect(pairs.every((p) => sessionOf.get(p.exchangeA) !== sessionOf.get(p.exchangeB))).toBe(true);
        expect(pairs.map((p) => p.rank)).toEqual(pairs.map((_, i) => i + 1));
      }
    },
    120_000,
  );
});
