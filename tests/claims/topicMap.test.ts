import { describe, expect, it } from "vitest";
import { formatTopicInput, readTopicMap, topicReport, TOPICS_JSON_SCHEMA, type TopicMember } from "../../server/src/claims";

const reply = (topics: unknown) => ({ stopReason: "end_turn", text: JSON.stringify({ topics }) });

describe("readTopicMap", () => {
  it("keeps primary and several secondary topics", () => {
    const r = readTopicMap([1, 2], reply([{ name: "Pricing", primary: ["C1"], secondary: ["C2"] }, { name: "Strategy", primary: ["C2"], secondary: ["C1"] }, { name: "Talks", primary: [], secondary: ["C1"] }]));
    expect(r.topics).toEqual([{ name: "Pricing", primary: [1], secondary: [2] }, { name: "Strategy", primary: [2], secondary: [1] }, { name: "Talks", primary: [], secondary: [1] }]);
    expect(r.unassigned).toEqual([]);
  });

  it("rejects unknown IDs and drops duplicates without losing the rest", () => {
    const r = readTopicMap([1], reply([{ name: "T", primary: ["C1", "C1", "C9"], secondary: ["C1"] }]));
    expect(r.topics).toEqual([{ name: "T", primary: [1], secondary: [] }]);
    expect(r.unknownCards).toEqual(["C9"]);
    expect(r.duplicates).toBe(2);
  });

  it("makes a second primary secondary, so a card has exactly one", () => {
    const r = readTopicMap([1], reply([{ name: "A", primary: ["C1"], secondary: [] }, { name: "B", primary: ["C1"], secondary: [] }]));
    expect(r.topics).toEqual([{ name: "A", primary: [1], secondary: [] }, { name: "B", primary: [], secondary: [1] }]);
  });

  it("counts a card with no primary as unassigned, keeping its secondary topics", () => {
    const r = readTopicMap([1, 2], reply([{ name: "A", primary: ["C1"], secondary: ["C2"] }]));
    expect(r.unassigned).toEqual([2]);
    expect(r.topics[0].secondary).toEqual([2]);
  });

  it("treats a model's own catch-all named Unassigned as no topic", () => {
    const r = readTopicMap([1], reply([{ name: "unassigned", primary: ["C1"], secondary: [] }]));
    expect(r.topics).toEqual([]);
    expect(r.unassigned).toEqual([1]);
  });

  it("merges repeated names and takes an existing topic's spelling", () => {
    const r = readTopicMap([1, 2], reply([{ name: "pricing ", primary: ["C1"], secondary: [] }, { name: "PRICING", primary: ["C2"], secondary: [] }]), ["Pricing"]);
    expect(r.topics).toEqual([{ name: "Pricing", primary: [1, 2], secondary: [] }]);
  });

  it.each([[null, "no response"], [{ stopReason: "refusal", text: null }, "the model refused"], [{ stopReason: "max_tokens", text: "{" }, "cut off at max_tokens"], [{ stopReason: "end_turn", text: "not json" }, "the output doesn't match the topic schema"]])("reports an unreadable response, leaving every card unassigned", (r, reason) => {
    expect(readTopicMap([1, 2], r)).toMatchObject({ unusable: reason, unassigned: [1, 2], topics: [] });
  });

  it("sends a schema with no score field and lists existing topics", () => {
    expect(JSON.stringify(TOPICS_JSON_SCHEMA)).not.toMatch(/confidence|score|probability|minLength/i);
    expect(formatTopicInput([{ id: 3, event: "The meeting" }], ["Pricing"])).toBe("Existing topics:\n- Pricing\n\nCards:\n[C3] The meeting");
  });
});

describe("topicReport", () => {
  const m = (topic: string, cardId: number, depositionId: number, isPrimary = true, isUnassigned = false): TopicMember => ({ topic, cardId, depositionId, isPrimary, isUnassigned });

  it("reports coverage and fragmentation", () => {
    const r = topicReport([m("PeopleSoft board meeting", 1, 1), m("PeopleSoft board meeting", 2, 2), m("Board meeting PeopleSoft March", 3, 1), m("Pricing", 1, 1, false), m("Unassigned", 4, 2, true, true)]);
    expect(r).toMatchObject({ topics: 3, cards: 4, assigned: 3, unassigned: 1, topicCoverage: 0.75, multiTopicCards: 1 });
    expect(r.fragmentation).toMatchObject({ singleSession: 2, singletons: 2, nearDuplicateNames: [["PeopleSoft board meeting", "Board meeting PeopleSoft March"]], largestTopicShare: 0.5 });
  });

  it("handles an empty map", () => {
    expect(topicReport([])).toMatchObject({ topics: 0, topicCoverage: null, fragmentation: { largestTopicShare: null } });
  });
});
