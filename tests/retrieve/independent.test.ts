// Independent retrieval's pure parts, on SYNTHETIC testimony: tokens, TF-IDF, LSA, anchors, pair
// ranking and fusion. These prove the mechanics; the retrieval probe measures them on real testimony.
import { describe, expect, it } from "vitest";
import { anchorNeighbours, anchors, denseNeighbours, nameVocabulary, fuse, jacobiEigen, lsa, pairRank, queryRank, rankPairs, sparseNeighbours, stem, tfidf, tokens, type Item } from "../../server/src/retrieve/independent";

const item = (id: number, session: number, answer: string, question = "", context = ""): Item => ({ id, session, question, answer, context });

describe("tokens and weights", () => {
  it("drops function and courtroom words and joins word forms", () => {
    expect(tokens("The crates were escaping; he escaped. Q: Did the crate escape?")).toEqual(["crat", "escap", "escap", "crat", "escap"]);
    expect(stem("deliveries")).toBe("delivery");
  });

  it("finds the neighbour sharing rare words, only in other sessions", () => {
    const items = [item(0, 1, "the forklift tipped over near the loading dock"), item(1, 2, "a forklift tipped near dock seven"), item(2, 1, "the forklift tipped near the loading dock again"), item(3, 2, "lunch was at noon"), item(4, 3, "noon lunch in the cafeteria")];
    const t = tfidf(items.map((i) => tokens(i.answer)), { minDf: 1, maxDfShare: 1 });
    const nb = sparseNeighbours(items, t.vectors, 3);
    expect(nb[0][0].id).toBe(1);
    expect(nb[0].some((x) => x.id === 2)).toBe(false); // same session
    expect(sparseNeighbours(items, t.vectors, 3, () => true, new Set([0]))[1]).toEqual([]); // rows not asked for
  });
});

describe("latent semantic vectors", () => {
  it("diagonalizes a symmetric matrix", () => {
    const { values } = jacobiEigen([Float64Array.from([2, 1]), Float64Array.from([1, 2])]);
    expect(values.map((v) => Math.round(v * 1e6) / 1e6).sort()).toEqual([1, 3]);
  });

  it("brings together items that share context words but no rare word", () => {
    const docs = [
      "truck driver loaded crates at the depot", "van driver loaded boxes at the depot", "truck driver unloaded crates at the warehouse", "van driver unloaded boxes at the warehouse",
      "the cake had candles and frosting", "the pie had cream and frosting", "cake and pie for dessert",
    ];
    const items = docs.map((d, i) => item(i, i, d));
    const t = tfidf(items.map((i) => tokens(i.answer)), { minDf: 1, maxDfShare: 1 });
    const dense = lsa(t.vectors, t.vocabulary.length, { dims: 3 });
    const nb = denseNeighbours(items, dense, 6);
    expect([0, 1, 2, 3]).toContain(nb[0][0].id);
    expect([4, 5, 6]).toContain(nb[4][0].id);
  });
});

describe("anchors", () => {
  it("reads names, dates, weekdays and years without any list of names", () => {
    expect(anchors("On June 5 Mr. Ortiz drove to Fresno. It was a Sunday in 1994.").sort()).toEqual(["date:june 5", "day:sunday", "name:fresno", "name:ortiz", "year:1994"]);
    // A sentence-initial word is a name only where the corpus also capitalizes it mid-sentence.
    expect(anchors("Ortiz met Calloway.", nameVocabulary(["I saw Ortiz there."]))).toEqual(["name:ortiz", "name:calloway"]);
    expect(anchors("After that he left.", nameVocabulary(["I saw Ortiz there."]))).toEqual([]);
    expect(anchors("Yes. Okay. The truck left.")).toEqual([]);
  });

  it("ranks the item sharing rare anchors first, context counting half", () => {
    const items = [item(0, 1, "Ortiz met Calloway in Fresno"), item(1, 2, "Ortiz was in Fresno"), item(2, 3, "Ortiz again"), item(3, 4, "nothing", "", "Calloway and Ortiz in Fresno")];
    const names = nameVocabulary(items.map((i) => `${i.answer} ${i.context}`).concat(["with Ortiz and Calloway"]));
    const own = items.map((i) => anchors(i.answer, names));
    const ctx = items.map((i) => anchors(i.context, names));
    const nb = anchorNeighbours(items, own, ctx, 3);
    expect(nb[0].map((x) => x.id)).toEqual([1, 3, 2]);
  });
});

describe("pairs across a case", () => {
  it("keeps each pair once with its best score, fuses lists by rank, and finds a pair's rank", () => {
    const ranked = rankPairs([[{ id: 1, score: 0.9 }, { id: 2, score: 0.1 }], [{ id: 0, score: 0.5 }], [{ id: 0, score: 0.2 }]]);
    expect(ranked).toEqual([{ a: 0, b: 1, score: 0.9 }, { a: 0, b: 2, score: 0.2 }]);
    const fused = fuse([ranked, [{ a: 0, b: 2, score: 1 }]]);
    expect(fused[0]).toMatchObject({ a: 0, b: 2 });
    expect(pairRank(ranked, new Set([2]), new Set([0]))).toBe(2);
    expect(queryRank([{ id: 5, score: 1 }, { id: 9, score: 0.5 }], new Set([9]))).toBe(2);
  });
});
