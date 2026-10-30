// Path A retrieval from stored claims. Claims are inserted directly: no model is involved.
// See tests/db/database.ts for when these run.

import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../server/src/db/client";
import { cases, claims, depositions, exchanges, lines, llmCalls, orgs, witnesses } from "../../server/src/db/schema";
import { PARSER_VERSION } from "../../server/src/ingest";
import { findPathA } from "../../server/src/retrieve";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

const VERSION = "claims-test";
let fileNo = 0;

describe.skipIf(!TEST_DATABASE_URL)("Path A retrieval (Postgres)", () => {
  let pool: Pool;
  let db: Database;
  let caseId: number;
  let witnessId: number;
  let callId: number;

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await emptyTables(db);
    const [org] = await db.insert(orgs).values({ name: "Demo" }).returning();
    caseId = (await db.insert(cases).values({ orgId: org.id, name: "U.S. v. Oracle" }).returning())[0].id;
    witnessId = (await db.insert(witnesses).values({ caseId, name: "Lawrence Ellison" }).returning())[0].id;
    callId = (
      await db
        .insert(llmCalls)
        .values({ stage: "claim_tagging", model: "claude-haiku-5-5", items: 1, inputTokens: 1, outputTokens: 1, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 0, attempt: 1 })
        .returning()
    )[0].id;
  });

  async function session(witness = witnessId, status: "ready" | "needs_review" = "ready") {
    const [row] = await db
      .insert(depositions)
      .values({ caseId, witnessId: witness, fileSha256: String(++fileNo).padStart(64, "0"), storageKey: "x.pdf", pageCount: 1, validation: {} as never, parserVersion: PARSER_VERSION, status })
      .returning();
    return row;
  }

  let lineNo = 0;
  async function part(deposition: { id: number; witnessId: number }, group = 1000 + lineNo, partNo = 1) {
    const [line] = await db
      .insert(lines)
      .values({ depositionId: deposition.id, pdfPage: 1, printedPage: 1, lineNo: ++lineNo, speakerRole: "witness", rawText: "A.", normText: "a" })
      .returning();
    const [row] = await db
      .insert(exchanges)
      .values({ depositionId: deposition.id, witnessId: deposition.witnessId, groupId: group, partNo, partCount: partNo, kind: "qa", firstLineId: line.id, lastLineId: line.id, answerLineCount: 1, questionText: "", answerText: "", dialogueText: "" })
      .returning({ id: exchanges.id });
    return row.id;
  }

  type ClaimFields = Partial<typeof claims.$inferInsert>;
  async function claim(deposition: { id: number; witnessId: number }, exchangeId: number, fields: ClaimFields = {}) {
    const [row] = await db
      .insert(claims)
      .values({
        exchangeId,
        citedExchange: `E${exchangeId}`,
        depositionId: deposition.id,
        witnessId: deposition.witnessId,
        extractorVersion: VERSION,
        ordinal: lineNo++,
        source: "answer",
        keyPhrase: "words",
        subject: "Oracle",
        predicate: "approve",
        polarity: "affirms",
        epistemic: "asserted",
        entities: ["peoplesoft"],
        status: "verified",
        matchScore: 1,
        llmCallId: callId,
        ...fields,
      })
      .returning();
    return row.id;
  }

  const find = (depositionId: number) => findPathA(db, { witnessId, depositionId, extractorVersion: VERSION });

  it("pairs a paraphrase by meaning: 'never authorized' against 'gave final approval' share a predicate and an entity", async () => {
    const earlier = await session();
    const later = await session();
    const a = await claim(earlier, await part(earlier), { keyPhrase: "I never authorized the PeopleSoft purchase", polarity: "denies" });
    const b = await claim(later, await part(later), { keyPhrase: "I gave final approval to buy PeopleSoft", polarity: "affirms" });
    const pairs = await find(later.id);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ rank: 1, signal: "opposite_polarity", predicate: "approve", sharedEntities: ["peoplesoft"], claimA: a, claimB: b });
  });

  it("finds a different value and a recollection change, ranking them after opposite polarity", async () => {
    const earlier = await session();
    const later = await session();
    await claim(earlier, await part(earlier), { predicate: "agree", time: "May 2003", entities: ["sap"] });
    await claim(later, await part(later), { predicate: "agree", time: "June 2003", entities: ["sap"] });
    await claim(earlier, await part(earlier), { predicate: "attend", entities: ["board meeting"] });
    await claim(later, await part(later), { predicate: "attend", epistemic: "does_not_recall", entities: ["board meeting"] });
    await claim(earlier, await part(earlier), { polarity: "denies" });
    await claim(later, await part(later), { polarity: "affirms" });
    expect((await find(later.id)).map((p) => [p.rank, p.signal])).toEqual([
      [1, "opposite_polarity"],
      [2, "different_value"],
      [3, "recollection_change"],
    ]);
  });

  it("pairs on overlapping objects when no entity is shared", async () => {
    const earlier = await session();
    const later = await session();
    await claim(earlier, await part(earlier), { predicate: "buy", object: "software", entities: [], polarity: "denies" });
    await claim(later, await part(later), { predicate: "buy", object: "the software package", entities: [], polarity: "affirms" });
    expect((await find(later.id)).map((p) => p.signal)).toEqual(["opposite_polarity"]);
  });

  it("keeps context-dependent claims out of retrieval, and finds a knowledge change", async () => {
    const earlier = await session();
    const later = await session();
    await claim(earlier, await part(earlier), { polarity: "denies" });
    await claim(later, await part(later), { contextDependent: true, contextReason: "question_too_short_to_stand_alone" });
    expect(await find(later.id)).toEqual([]);
    await claim(later, await part(later), { epistemic: "does_not_know" });
    expect((await find(later.id)).map((p) => p.signal)).toEqual(["knowledge_change"]);
  });

  it("leaves out pairs with no signal, no shared subject, another predicate, 'other', or claims that can't signal", async () => {
    const earlier = await session();
    const later = await session();
    const otherWitness = await session((await db.insert(witnesses).values({ caseId, name: "Safra Catz" }).returning())[0].id);
    const notReady = await session(witnessId, "needs_review");
    await claim(later, await part(later), { polarity: "denies" });
    // Each would pair with the claim above if not for the reason given.
    await claim(earlier, await part(earlier), { polarity: "denies" }); // same polarity, same values: no signal
    await claim(earlier, await part(earlier), { entities: ["ibm"] }); // nothing shared
    await claim(earlier, await part(earlier), { predicate: "decide" }); // another predicate
    await claim(earlier, await part(earlier), { epistemic: "hypothetical" });
    await claim(earlier, await part(earlier), { epistemic: "reported_by_other" });
    await claim(earlier, await part(earlier), { status: "rejected", rejectionReason: "phrase_not_in_testimony" });
    await claim(otherWitness, await part(otherWitness)); // another witness
    await claim(notReady, await part(notReady)); // deposition not ready
    await claim(earlier, await part(earlier), { predicate: "other", polarity: "affirms" });
    await claim(later, await part(later), { predicate: "other", polarity: "denies" }); // "other" never pairs
    expect(await find(later.id)).toEqual([]);
  });

  it("never pairs two claims of the same session", async () => {
    const later = await session();
    await claim(later, await part(later), { polarity: "denies" });
    await claim(later, await part(later), { polarity: "affirms" });
    expect(await find(later.id)).toEqual([]);
  });

  it("makes one candidate per pair of logical exchanges, keeping the strongest claim pair and its parts", async () => {
    const earlier = await session();
    const later = await session();
    const a1 = await part(earlier, 7);
    const a2 = await part(earlier, 7, 2); // a second part of the same split exchange
    const b = await part(later, 3);
    await claim(earlier, a1, { predicate: "attend", entities: ["board meeting"] });
    const strong = await claim(earlier, a2, { polarity: "denies" });
    await claim(later, b, { predicate: "attend", epistemic: "does_not_recall", entities: ["board meeting"] });
    const other = await claim(later, b, { polarity: "affirms" });
    const pairs = await find(later.id);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      signal: "opposite_polarity",
      a: { depositionId: earlier.id, groupId: 7 },
      b: { depositionId: later.id, groupId: 3 },
      exchangeA: a2,
      exchangeB: b,
      claimA: strong,
      claimB: other,
      claimPairs: 2,
    });
  });
});
