// Path A in memory (retrieve/fullTextMemory.ts) against Postgres's own ranking (eval/retrievalProbe.ts fullText), on
// SYNTHETIC items with repeated, hyphenated, possessive and numeric words and many tied ranks: the lists must be identical.
// See tests/db/database.ts for when these run.

import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fullText, type ProbeItem } from "../../server/src/eval/retrievalProbe";
import { float4AsPrinted, fullTextMemory } from "../../server/src/retrieve/fullTextMemory";
import { openTestDatabase, TEST_DATABASE_URL } from "./database";

const SYLLABLES = ["ka", "lo", "mir", "tan", "ves", "dor", "pel", "sun", "rag", "fen", "bru", "tol", "nek", "jas", "quo"];
const SPECIAL = ["forklift", "dock", "self-defense", "Ortiz's", "truck", "1996", "freezer", "gauge", "crates", "escaped", "Bronco", "glove", "limo", "SUV", "driveway", "gate", "o'clock", "midnight", "Brentwood", "Rockingham"];
// Rare and common words alike, so each item has query lexemes under the 20% document-frequency ceiling.
const WORDS = [...SPECIAL, ...SYLLABLES.flatMap((a) => SYLLABLES.map((b) => `${a}${b}`))];

describe.skipIf(!TEST_DATABASE_URL)("Path A in memory", () => {
  let pool: Pool;
  beforeAll(async () => { ({ pool } = await openTestDatabase()); });
  afterAll(async () => { await pool?.end(); });

  it("prints a float4 as Postgres does", () => {
    expect(float4AsPrinted(0.1)).toBe(0.1);
    expect(float4AsPrinted(1 / 3)).toBe(0.33333334);
  });

  it("returns fullText's neighbours, scores and tie order", async () => {
    let seed = 5;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const items = Array.from({ length: 160 }, (_, id) => {
      const text = Array.from({ length: 3 + Math.floor(random() * 25) }, () => WORDS[Math.floor(random() * WORDS.length)]).join(" ");
      return { id, session: Math.floor(random() * 4), question: "", answer: text, context: "", text } as unknown as ProbeItem;
    });
    const expected = await fullText(pool, items, 15);
    expect(expected.some((l) => l.length === 15)).toBe(true);
    expect(await fullTextMemory(pool, items, 15)).toEqual(expected);
  });
});
