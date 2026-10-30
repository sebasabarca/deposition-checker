import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ClaimFixtures, matchesExpectation } from "../../server/src/eval";
import type { claims } from "../../server/src/db/schema";

const row = (fields: Partial<typeof claims.$inferSelect>) =>
  ({ status: "verified", source: "answer", predicate: "buy", polarity: "denies", epistemic: "asserted", keyPhrase: "they're not buying any software", hedge: null, contextDependent: false, ...fields }) as typeof claims.$inferSelect;

describe("claim fixtures", () => {
  it("the fixtures file is valid and names both Ellison depositions by SHA-256", () => {
    const file = ClaimFixtures.parse(JSON.parse(readFileSync("data/eval/claim-fixtures.json", "utf8")));
    expect(Object.keys(file.documents).sort()).toEqual(["p3171", "p3173"]);
    expect(file.cases.length).toBeGreaterThan(10);
  });

  it("matches on every stated field, counts a code hedge as qualified, and never matches a rejected claim", () => {
    const want = { claim: { predicate: "buy", polarity: "denies", keyPhraseIncludes: "NOT BUYING" } };
    expect(matchesExpectation(row({}), want)).toBe(true);
    expect(matchesExpectation(row({ polarity: "affirms" }), want)).toBe(false);
    expect(matchesExpectation(row({ status: "rejected" }), want)).toBe(false);
    expect(matchesExpectation(row({ hedge: "i think" }), { claim: { qualified: true } })).toBe(true);
    expect(matchesExpectation(row({}), { claim: { qualified: true } })).toBe(false);
  });
});
