import { describe, expect, it } from "vitest";
import { cardSignal, objectsOverlap, pairCards, pairExclusion, tierOf, type PairableCard } from "../../server/src/retrieve";

let id = 0;
const card = (over: Partial<PairableCard> = {}): PairableCard => ({ id: ++id, exchangeId: 100 + id, depositionId: 1, groupId: id, stance: "asserts", epistemic: "asserted", predicate: "approve", object: null, time: null, location: null, amount: null, entities: [], event: "The Cho contract approval", topicIds: [], ...over });

describe("cardSignal", () => {
  it("opposite stance on the same event comes first", () => {
    expect(cardSignal(card(), card({ stance: "denies" }))).toMatchObject({ signal: "opposite_stance", comparable: true });
  });

  it("a different value needs the same stance and a stated value on both sides", () => {
    expect(cardSignal(card({ time: "March" }), card({ time: "May" })).signal).toBe("different_value");
    expect(cardSignal(card({ time: "March" }), card({ time: null })).signal).not.toBe("different_value");
    expect(cardSignal(card({ time: "March" }), card({ time: " march" })).signal).not.toBe("different_value");
  });

  it("a stated fact against no memory is a recollection change, for either side", () => {
    expect(cardSignal(card({ stance: "not_answered", epistemic: "does_not_recall" }), card()).signal).toBe("recollection_change");
    expect(cardSignal(card(), card({ stance: "not_answered", epistemic: "does_not_know" })).signal).toBe("recollection_change");
  });

  it("a shared person on two different events isn't comparable, so its signal ranks low", () => {
    const s = cardSignal(card({ entities: ["Priya"], event: "The budget review", time: "March" }), card({ entities: ["Priya"], event: "The fleet audit", time: "May" }));
    expect(s).toMatchObject({ signal: "different_value", comparable: false });
    expect(tierOf(s.signal, s.comparable)).toBeGreaterThan(tierOf("shared_entities", false));
  });

  it("overlapping objects make cards comparable even when event lines differ", () => {
    expect(cardSignal(card({ object: "the software package", event: "A" }), card({ object: "software", event: "B" })).comparable).toBe(true);
  });
});

describe("pairExclusion", () => {
  it("rules out other people's words and hypotheticals on either side", () => {
    expect(pairExclusion(card({ epistemic: "hypothetical" }), card())).toBe("not_the_witness_assertion");
    expect(pairExclusion(card(), card({ epistemic: "reported_by_other" }))).toBe("not_the_witness_assertion");
  });

  it("rules out a pair with no assertion on either side, and an unanswered side", () => {
    expect(pairExclusion(card({ stance: "not_answered", epistemic: "does_not_recall" }), card({ stance: "not_answered", epistemic: "does_not_know" }))).toBe("no_assertion_on_either_side");
    expect(pairExclusion(card(), card({ stance: "not_answered" }))).toBe("side_not_answered");
  });

  it("keeps a stated fact against no memory", () => {
    expect(pairExclusion(card(), card({ stance: "not_answered", epistemic: "does_not_recall" }))).toBeNull();
  });
});

describe("pairCards", () => {
  const a = (over = {}) => card({ depositionId: 1, ...over });
  const b = (over = {}) => card({ depositionId: 2, ...over });

  it("pairs across sessions, never within one", () => {
    expect(pairCards([a({ topicIds: [1] }), a({ topicIds: [1] })])).toEqual([]);
    expect(pairCards([a({ topicIds: [1] }), b({ topicIds: [1] })])).toHaveLength(1);
  });

  it("two topics in common are one candidate recording both", () => {
    const [pair, ...rest] = pairCards([a({ topicIds: [1, 2] }), b({ topicIds: [2, 1] })]);
    expect(rest).toEqual([]);
    expect(pair.topicIds).toEqual([1, 2]);
  });

  it("several cards on two exchanges are one candidate keeping the strongest signal and every topic", () => {
    const pairs = pairCards([a({ groupId: 5, topicIds: [1] }), a({ groupId: 5, topicIds: [2] }), b({ groupId: 9, topicIds: [1] }), b({ groupId: 9, topicIds: [2], stance: "denies" })]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ signal: "opposite_stance", topicIds: [1, 2], cardPairs: 2 });
  });

  it("orients a pair the same way whichever session comes first", () => {
    const x = a({ groupId: 1, topicIds: [1] });
    const y = b({ groupId: 1, topicIds: [1] });
    expect(pairCards([y, x])[0].a.depositionId).toBe(1);
  });

  it("finds cards with no shared topic through a shared entity and predicate", () => {
    const [pair] = pairCards([a({ entities: ["Cho"] }), b({ entities: ["Cho"], stance: "denies" })]);
    expect(pair).toMatchObject({ signal: "opposite_stance", topicIds: [] });
  });

  it("finds an unassigned card the same way, and needs no map at all", () => {
    expect(pairCards([a({ entities: ["Cho"], topicIds: [] }), b({ entities: ["Cho"], topicIds: [7] })])).toHaveLength(1);
  });

  it("a shared entity with predicate other is no link, but a shared topic still is", () => {
    expect(pairCards([a({ entities: ["Cho"], predicate: "other" }), b({ entities: ["Cho"], predicate: "other" })])).toEqual([]);
    expect(pairCards([a({ entities: ["Cho"], predicate: "other", topicIds: [1] }), b({ entities: ["Cho"], predicate: "other", topicIds: [1] })])).toHaveLength(1);
  });

  it("a shared entity with a different predicate is no link", () => {
    expect(pairCards([a({ entities: ["Cho"], predicate: "approve" }), b({ entities: ["Cho"], predicate: "attend" })])).toEqual([]);
  });

  it("ranks by signal, and an excluded pair after every eligible one", () => {
    const pairs = pairCards([
      a({ groupId: 1, topicIds: [1], epistemic: "hypothetical" }), b({ groupId: 2, topicIds: [1] }),
      a({ groupId: 3, topicIds: [2], event: "x" }), b({ groupId: 4, topicIds: [2], event: "y" }),
      a({ groupId: 5, topicIds: [3] }), b({ groupId: 6, topicIds: [3], stance: "denies" }),
    ]);
    expect(pairs.filter((p) => p.topicIds.length === 1).map((p) => [p.signal, p.exclusion !== null])).toEqual([["opposite_stance", false], ["same_topic", false], ["same_topic", true], ["same_topic", true], ["same_topic", true], ["same_topic", true]].slice(0, pairs.length));
    expect(pairs[pairs.length - 1].exclusion).not.toBeNull();
    expect(pairs.map((p) => p.rank)).toEqual(pairs.map((_, i) => i + 1));
  });

  it("an exchange pair stays eligible when any of its card pairs is", () => {
    const [pair] = pairCards([a({ groupId: 1, topicIds: [1], epistemic: "hypothetical" }), a({ groupId: 1, topicIds: [1] }), b({ groupId: 2, topicIds: [1] })]);
    expect(pair.exclusion).toBeNull();
  });
});

describe("objectsOverlap", () => {
  it("needs shared meaningful words making up most of the smaller object", () => {
    expect(objectsOverlap("the software package", "software")).toBe(true);
    expect(objectsOverlap("the 10% discount", "the board")).toBe(false);
    expect(objectsOverlap(null, "software")).toBe(false);
  });
});
