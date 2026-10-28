import { describe, expect, it } from "vitest";
import { idf, MIN_SHARED_TERMS, pairScore, queryTerms, RARE_TERMS_PER_QUERY, type TermFrequency } from "../../server/src/retrieve";

// 100 logical exchanges; "oracl" is in all of them, "product" in half, the rest in one or two.
const weights: TermFrequency = {
  exchanges: 100,
  frequency: new Map([
    ["oracl", 100],
    ["product", 50],
    ["outsourc", 2],
    ["buy", 10],
    ["servic", 10],
    ["softwar", 20],
    ["scale", 5],
  ]),
};

describe("idf", () => {
  it("weighs a word every exchange uses at 0 and rarer words more", () => {
    expect(idf("oracl", weights)).toBe(0);
    expect(idf("product", weights)).toBeCloseTo(Math.log(2));
    expect(idf("outsourc", weights)).toBeGreaterThan(idf("softwar", weights));
    expect(idf("never-seen", weights)).toBeCloseTo(Math.log(100)); // treated as used once
  });
});

describe("pairScore", () => {
  const short = ["outsourc", "buy", "softwar"];
  const long = ["outsourc", "buy", "softwar", "servic", "product", "oracl", "scale"];

  it("is symmetric", () => {
    for (const [a, b] of [
      [short, long],
      [long, ["scale", "product", "buy"]],
      [["oracl", "product"], ["product", "oracl", "outsourc"]],
    ]) {
      expect(pairScore(a, b, weights)).toEqual(pairScore(b, a, weights));
    }
  });

  it("scores 1 when the smaller exchange's distinctive vocabulary is all in the other, however long it is", () => {
    expect(pairScore(short, long, weights).score).toBe(1);
  });

  it("gives words every exchange uses no weight, so they can't make a pair", () => {
    expect(pairScore(["oracl", "product", "outsourc"], ["oracl", "product", "scale"], weights).score).toBe(0); // only "product" carries weight
  });

  it(`scores 0 for fewer than ${MIN_SHARED_TERMS} shared terms with any weight`, () => {
    expect(pairScore(["outsourc", "scale"], ["outsourc", "buy"], weights)).toEqual({ score: 0, sharedTerms: ["outsourc"] });
  });

  it("reports only the shared terms that contribute to the score, leaving out words every exchange uses", () => {
    const { score, sharedTerms } = pairScore(["oracl", "outsourc", "buy"], ["oracl", "outsourc", "buy", "scale"], weights);
    expect(sharedTerms).toEqual(["outsourc", "buy"]); // "oracl" weighs 0
    expect(score).toBe(1);
  });

  it("lists the shared terms most distinctive first", () => {
    expect(pairScore(short, long, weights).sharedTerms).toEqual(["outsourc", "buy", "softwar"]);
  });
});

describe("queryTerms", () => {
  const terms = ["oracl", "product", "outsourc", "buy", "servic", "softwar", "scale"];

  it("all_terms uses every content term", () => {
    expect(queryTerms(terms, "all_terms", weights)).toEqual(terms);
  });

  it(`rare_terms keeps the ${RARE_TERMS_PER_QUERY} rarest, in a stable order`, () => {
    const many = Array.from({ length: 20 }, (_, i) => `t${String(i).padStart(2, "0")}`);
    const frequency = new Map(many.map((t, i) => [t, 20 - i])); // t19 rarest
    const chosen = queryTerms(many, "rare_terms", { exchanges: 100, frequency });
    expect(chosen).toEqual(many.slice(8).reverse());
    expect(queryTerms(terms, "rare_terms", weights)).toEqual(["outsourc", "scale", "buy", "servic", "softwar", "product", "oracl"]);
  });
});
