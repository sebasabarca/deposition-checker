// Code's checks of proposed facts (fact-schema-v2), on SYNTHETIC testimony. The "model output" here is
// written by hand: these tests show what verification accepts and rejects, never how well a model extracts.
import { describe, expect, it } from "vitest";
import { buildUnits, checkFact, factsJsonSchema, MAX_UNITS_PER_BATCH, openingMatches, readFacts, valueWordsIn, type Unit } from "../../server/src/claims/facts";
import { doc, part } from "./build";

// A complete fact; tests override what they're about.
const fact = (over: Record<string, unknown> = {}) => ({
  kind: "action", spans: [2], contextSpans: [], evidencePhrase: "signed the visitor log", subject: "the witness", entities: [], predicate: "signed", attribute: null, value: null, valuePhrase: null,
  factualQuestion: "Did the witness sign the visitor log?", polarity: "positive", epistemicStatus: "asserted", reportedSpeaker: null, hedges: [], correction: false, timeScope: null, locationScope: null,
  event: { description: "The witness's visit to the warehouse", eventType: "visit", anchors: ["got to the warehouse"], participants: [], date: null, location: "the warehouse" }, ...over,
});
const visit = (): Unit => buildUnits(doc([part(1, 1, 1, ["Q: What did you do that night?", "A: I got to the warehouse around nine, signed the visitor log, and spoke with the night manager before I left."])]))[0];
// The model's output: one group per unit under u1, u2, ..., each copying its unit's opening words.
const group = (opening: string, facts: unknown[], noFactsReason: string | null = null) => ({ opening, facts, noFactsReason });
const reply = (groups: Record<string, unknown>) => ({ stopReason: "end_turn", text: JSON.stringify(groups) });

describe("facts from one unit", () => {
  it("indexes several facts, actions and attributes, each with its own key", () => {
    const u = visit();
    const four = [
      fact({ kind: "attribute", evidencePhrase: "I got to the warehouse around nine", predicate: "arrived at", attribute: "time the witness arrived at the warehouse", value: "around nine", valuePhrase: "around nine", factualQuestion: "When did the witness arrive at the warehouse?", hedges: ["around"] }),
      fact(),
      fact({ evidencePhrase: "spoke with the night manager", predicate: "spoke with", factualQuestion: "Did the witness speak with the night manager?" }),
      fact({ evidencePhrase: "before I left", predicate: "left after speaking", factualQuestion: "Did the witness leave after speaking with the night manager?" }),
    ].map((f, i) => checkFact(u, f, i));
    expect(four.map((c) => [c.status, c.kind, c.sourceVerification, c.attributionStatus])).toEqual([
      ["indexed", "attribute", "verified", "verified"], ["indexed", "action", "verified", "verified"], ["indexed", "action", "verified", "verified"], ["indexed", "action", "verified", "verified"],
    ]);
    expect(four[0]).toMatchObject({ valueSupport: "verified", semanticStatus: "source_supported", dimension: "time_the_witness_arrived_at_the_warehouse", hedges: ["around"] });
    expect(new Set(four.map((c) => c.factKey)).size).toBe(4);
  });

  it("rejects unsupported claims: a phrase the cited spans don't hold, and spans that don't exist", () => {
    const u = visit();
    expect(checkFact(u, fact({ evidencePhrase: "signed the contract" }), 0)).toMatchObject({ status: "rejected", rejectionReason: "phrase_not_in_cited_spans" });
    expect(checkFact(u, fact({ spans: [9] }), 0)).toMatchObject({ status: "rejected", sourceVerification: "invalid_reference", rejectionReason: "unknown_span" });
    expect(checkFact(u, fact({ contextSpans: [1] }), 0)).toMatchObject({ status: "rejected", rejectionReason: "unknown_context_span" });
    expect(checkFact(u, { ...fact(), confidence: 0.9 }, 0)).toMatchObject({ status: "rejected", rejectionReason: expect.stringMatching(/^invalid_fields/) });
  });
});

describe("values and answer-independent questions", () => {
  const dock = (): Unit => buildUnits(doc([part(2, 1, 1, ["Q: Where did the shipment leave from?", "A: It left from dock four on the second of May."])]))[0];
  const attribute = (over: Record<string, unknown> = {}) => fact({ kind: "attribute", evidencePhrase: "It left from dock four", subject: "the shipment", predicate: "left from", attribute: "dock the shipment left from", value: "dock four", valuePhrase: "dock four", factualQuestion: "From which dock did the shipment leave?", timeScope: "the second of May", ...over });

  it("requires the value's own source words, and keeps the value out of the attribute and the question", () => {
    expect(checkFact(dock(), attribute(), 0)).toMatchObject({ status: "indexed", valueSupport: "verified", semanticStatus: "source_supported" });
    expect(checkFact(dock(), attribute({ value: "dock seven", valuePhrase: "dock seven" }), 0)).toMatchObject({ status: "rejected", rejectionReason: "value_not_in_cited_spans" });
    expect(checkFact(dock(), attribute({ valuePhrase: null }), 0)).toMatchObject({ status: "rejected", rejectionReason: "attribute_without_value" });
    expect(checkFact(dock(), attribute({ attribute: "dock four departure" }), 0)).toMatchObject({ status: "rejected", rejectionReason: "attribute_contains_value: four" });
    // The value in the question is flagged for a reader, not rejected: it can be the question's own frame.
    expect(checkFact(dock(), attribute({ factualQuestion: "Did the shipment leave from dock four?" }), 0)).toMatchObject({ status: "indexed", semanticStatus: "needs_semantic_review", reviewReasons: ["question_contains_value"] });
    expect(checkFact(dock(), attribute({ factualQuestion: "What dock did the shipment leave from?" }), 0)).toMatchObject({ status: "indexed", reviewReasons: [] }); // "what" is never a value word
    expect(valueWordsIn("vehicle the manager rode in", "the delivery van")).toEqual([]);
  });

  it("keeps dates out of the attribute key, and marks a normalized value for a reader", () => {
    const c = checkFact(dock(), attribute({ attribute: "dock the shipment left from on May 2" }), 0);
    expect(c).toMatchObject({ status: "indexed", dimension: "dock_the_shipment_left_from_on", semanticStatus: "needs_semantic_review", reviewReasons: ["time_in_attribute"] });
    expect(checkFact(dock(), attribute({ value: "Dock 4" }), 0)).toMatchObject({ status: "indexed", semanticStatus: "needs_semantic_review", reviewReasons: ["value_normalized"] });
  });

  it("flags a yes/no action that names a value, which belongs in an attribute fact", () => {
    const u = buildUnits(doc([part(3, 1, 1, ["Q: Did the van go through the side entrance?", "A: Yes."])]))[0];
    const yesNo = fact({ spans: [1, 2], evidencePhrase: "go through the side entrance", subject: "the van", predicate: "went through", factualQuestion: "Did the van go through the side entrance?" });
    expect(checkFact(u, yesNo, 0)).toMatchObject({ status: "indexed", provenance: "question_adopted", semanticStatus: "needs_semantic_review", reviewReasons: ["yes_no_question_names_value"] });
    // The same testimony as an attribute: the value is the question's words, adopted by the answer.
    const asAttribute = fact({ kind: "attribute", spans: [1, 2], evidencePhrase: "go through the side entrance", subject: "the van", predicate: "went through", attribute: "way the van went in", value: "the side entrance", valuePhrase: "the side entrance", factualQuestion: "Which way did the van go in?" });
    expect(checkFact(u, asAttribute, 0)).toMatchObject({ status: "indexed", provenance: "question_adopted", attributionStatus: "verified", semanticStatus: "source_supported" });
  });

  it("lets a value come from the context lines before the unit, cited as context", () => {
    const [before, u] = buildUnits(doc([part(4, 1, 1, ["Q: Which truck did you load?", "A: The blue truck."]), part(5, 2, 3, ["Q: And where did it go?", "A: It went to the depot."])]));
    expect(u.context.map((s) => s.text)).toEqual(before.spans.map((s) => s.text));
    const truck = fact({ kind: "attribute", spans: [2], contextSpans: [2], evidencePhrase: "It went to the depot", subject: "the blue truck", predicate: "went to", attribute: "place the truck went", value: "the depot", valuePhrase: "the depot", factualQuestion: "Where did the truck go?", entities: ["blue truck"] });
    const c = checkFact(u, truck, 0);
    expect(c).toMatchObject({ status: "indexed", valueSupport: "verified" });
    expect(c.contextSpans.map((s) => s.text)).toEqual(["A: The blue truck."]);
    expect(checkFact(u, { ...truck, value: "the blue truck", valuePhrase: "The blue truck", attribute: "truck loaded", factualQuestion: "Which truck went?" }, 0)).toMatchObject({ status: "indexed", valueSupport: "verified" });
    expect(checkFact(u, { ...truck, contextSpans: [], value: "the blue truck", valuePhrase: "The blue truck", attribute: "truck loaded", factualQuestion: "Which truck went?" }, 0)).toMatchObject({ status: "rejected", rejectionReason: "value_not_in_cited_spans" });
  });
});

describe("attribution", () => {
  const units = buildUnits(doc([part(6, 1, 1, ["Q: Did you open the safe?", "A: No."])]));
  const denial = fact({ spans: [1, 2], evidencePhrase: "open the safe", predicate: "opened", factualQuestion: "Did the witness open the safe?", polarity: "negative" });

  it("reads a short answer as adopting or rejecting the question, cited with both", () => {
    expect(checkFact(units[0], denial, 0)).toMatchObject({ status: "indexed", provenance: "question_adopted", attributionStatus: "verified" });
    expect(checkFact(units[0], { ...denial, polarity: "positive" }, 0)).toMatchObject({ status: "rejected", rejectionReason: expect.stringMatching(/^polarity_contradicts_answer/) });
    expect(checkFact(units[0], { ...denial, spans: [1] }, 0)).toMatchObject({ status: "rejected", rejectionReason: "attorney_assertion" });
  });

  it("carries uncertain attribution into the fact, and never indexes an invalid one", () => {
    const unknown = buildUnits(doc([part(7, 1, 1, ["Q: What did you do?", { text: "signed the visitor log.", speaker: "unknown", role: "unknown" }])]))[0];
    expect(checkFact(unknown, fact(), 0)).toMatchObject({ status: "indexed", attributionStatus: "uncertain" });
    const invalid = buildUnits(doc([part(8, 1, 1, ["Q: What did you do?", "A: I signed the visitor log."], { status: "invalid" })]))[0];
    expect(checkFact(invalid, fact(), 0)).toMatchObject({ status: "rejected", rejectionReason: "exchange_attribution_invalid" });
  });
});

describe("memory, knowledge and reported speech", () => {
  const u = buildUnits(doc([part(9, 1, 1, ["Q: Did the manager call you that night?", "A: I don't recall. Pat told me he called twice."])]))[0];
  // "I don't recall" alone says nothing: it is about the question, which is cited with it.
  const recall = fact({ kind: "memory_or_knowledge", spans: [1, 2], evidencePhrase: "I don't recall", predicate: "called", factualQuestion: "Did the manager call the witness that night?", polarity: "unknown", epistemicStatus: "does_not_recall" });

  it("keeps a non-recollection apart from a denial", () => {
    expect(checkFact(u, recall, 0)).toMatchObject({ status: "indexed", kind: "memory_or_knowledge" });
    expect(checkFact(u, { ...recall, spans: [2] }, 0)).toMatchObject({ status: "rejected", rejectionReason: "bare_answer_without_question" });
    expect(checkFact(u, { ...recall, polarity: "negative" }, 0)).toMatchObject({ status: "rejected", rejectionReason: "non_recollection_given_polarity" });
    expect(checkFact(u, { ...recall, kind: "action" }, 0)).toMatchObject({ status: "rejected", rejectionReason: "memory_kind_mismatch" });
    expect(checkFact(u, { ...recall, epistemicStatus: "asserted" }, 0)).toMatchObject({ status: "rejected", rejectionReason: "memory_kind_mismatch" });
  });

  it("requires the speaker of reported speech", () => {
    const reported = fact({ evidencePhrase: "Pat told me he called twice", predicate: "called", factualQuestion: "Did the manager call the witness?", epistemicStatus: "reported_by_other" });
    expect(checkFact(u, reported, 0)).toMatchObject({ status: "rejected", rejectionReason: "reported_speaker_missing" });
    expect(checkFact(u, { ...reported, reportedSpeaker: "Pat" }, 0)).toMatchObject({ status: "indexed", semanticStatus: "source_supported" });
    expect(checkFact(u, { ...reported, reportedSpeaker: "Sam Ortiz" }, 0)).toMatchObject({ status: "indexed", reviewReasons: ["reported_speaker_not_named_in_testimony"] });
  });
});

describe("v4 rules for adopted answers, questions and reported speech", () => {
  const safe = buildUnits(doc([part(12, 1, 1, ["Q: Did Ms. Ortiz open the safe?", "A: No."])]))[0];

  it("never takes a bare yes or no as a fact without the question it answers", () => {
    const bare = fact({ spans: [2], evidencePhrase: "No.", predicate: "opened", factualQuestion: "Did Ms. Ortiz open the safe?", polarity: "negative" });
    expect(checkFact(safe, bare, 0)).toMatchObject({ status: "rejected", rejectionReason: "bare_answer_without_question" });
    expect(checkFact(safe, { ...bare, spans: [1, 2] }, 0)).toMatchObject({ status: "indexed", reviewReasons: ["proposition_from_question_not_quoted"] });
  });

  it("asks for questions about named people, not \"you\"", () => {
    const own = fact({ spans: [1, 2], evidencePhrase: "open the safe", predicate: "opened", factualQuestion: "Did you open the safe?", polarity: "negative" });
    expect(checkFact(safe, own, 0)).toMatchObject({ status: "indexed", reviewReasons: ["question_not_in_third_person"] });
  });

  it("flags words of reporting read as the witness's own assertion", () => {
    const u = buildUnits(doc([part(13, 1, 1, ["Q: Did the manager call?", "A: Pat told me he called twice."])]))[0];
    const own = fact({ evidencePhrase: "he called twice", predicate: "called", factualQuestion: "Did the manager call?" });
    expect(checkFact(u, own, 0)).toMatchObject({ status: "indexed", reviewReasons: ["possible_reported_speech"] });
    expect(checkFact(u, { ...own, epistemicStatus: "reported_by_other", reportedSpeaker: "Pat" }, 0)).toMatchObject({ status: "indexed", reviewReasons: [] });
  });
});

describe("reading a batch by key, checked by each unit's opening words", () => {
  const units = [
    visit(),
    buildUnits(doc([part(10, 2, 3, ["Q: Do you see that?", "A: Yes."])]))[0],
    buildUnits(doc([part(11, 3, 5, ["Q: Were there other calls?", "A: No. Not to my recollection."])]))[0],
  ].map((u, i) => ({ ...u, unitKey: `fu_${i + 1}` }));
  const g1 = () => group("What did you do that night?", [fact()]);
  const g2 = () => group("Do you see that?", [], "procedural");
  const g3 = () => group("Were there other calls?", []);

  it("assigns each group to the unit its key names, whatever order the keys come in", () => {
    const inOrder = readFacts(units, reply({ u1: g1(), u2: g2(), u3: g3() }));
    const reversed = readFacts(units, reply({ u3: g3(), u2: g2(), u1: g1() }));
    expect(inOrder.outcomes.map((o) => o.status)).toEqual(["extracted", "empty", "suspected_omission"]);
    expect(reversed.outcomes).toEqual(inOrder.outcomes);
    expect(reversed.facts.map((f) => [f.unitKey, f.factKey])).toEqual(inOrder.facts.map((f) => [f.unitKey, f.factKey]));
  });

  it("never moves a fact to another unit: a group written for another unit fails its own", () => {
    // The model shifted by one: u2 holds what belongs to u1. Nothing from it is used.
    const r = readFacts(units, reply({ u1: g2(), u2: g1(), u3: g3() }));
    expect(r.outcomes.map((o) => o.status)).toEqual(["failed", "failed", "suspected_omission"]);
    expect(r.facts).toEqual([]);
    expect(r.diagnostics.openingMismatches).toEqual([1, 2]);
  });

  it("reports missing, repeated and unexpected keys without using them", () => {
    const text = `{"u1": ${JSON.stringify(g1())}, "u1": ${JSON.stringify(g1())}, "u7": ${JSON.stringify(g1())}, "u3": ${JSON.stringify(g3())}}`;
    const r = readFacts(units, { stopReason: "end_turn", text });
    expect(r.outcomes.map((o) => o.status)).toEqual(["failed", "omitted", "suspected_omission"]);
    expect(r.outcomes[0].error).toMatch(/repeats u1/);
    expect(r.facts).toEqual([]);
    expect(r.diagnostics).toMatchObject({ unexpectedPositions: [7], repeatedPositions: [1] });
  });

  it("matches the opening after normalization, and needs at least three words of it", () => {
    expect(openingMatches("what did you do", units[0])).toBe(true);
    expect(openingMatches("Q: What, did you", units[0])).toBe(true);
    expect(openingMatches("What did", units[0])).toBe(false);
    expect(openingMatches("Were there other calls", units[0])).toBe(false);
  });

  it("treats an empty answer about memory as a suspected omission, never as nothing to extract", () => {
    const r = readFacts(units, reply({ u1: g1(), u2: g2(), u3: group("Were there other calls?", [], "nonresponsive") }));
    expect(r.outcomes[2]).toMatchObject({ status: "suspected_omission", error: expect.stringContaining("memory_or_knowledge_answer") });
    expect(r.outcomes[1].status).toBe("empty");
  });

  it("fails every unit on a refusal or an unreadable reply", () => {
    for (const x of [{ stopReason: "refusal", text: null }, { stopReason: "end_turn", text: "not json" }, { stopReason: "end_turn", text: JSON.stringify([]) }]) {
      expect(readFacts(units, x).outcomes.map((o) => o.status)).toEqual(["failed", "failed", "failed"]);
    }
  });

  it("stores a repeated reading once: same unit, same spans, same key", () => {
    const seen = new Set<string>();
    expect(readFacts(units, reply({ u1: g1(), u2: g2(), u3: g3() }), seen).facts).toHaveLength(1);
    const again = readFacts(units, reply({ u1: g1(), u2: g2(), u3: g3() }), seen);
    expect(again.facts).toHaveLength(0);
    expect(again.outcomes[0]).toMatchObject({ status: "extracted", duplicates: 1 });
  });

  it("requires exactly the batch's keys in the schema, bounded, with no score or confidence", () => {
    const schema = factsJsonSchema(3) as { required: string[]; additionalProperties: boolean };
    expect(schema.required).toEqual(["u1", "u2", "u3"]);
    expect(schema.additionalProperties).toBe(false);
    expect(() => factsJsonSchema(MAX_UNITS_PER_BATCH + 1)).toThrow();
    expect(JSON.stringify(schema)).not.toMatch(/unitId|spanIds|minLength|minItems|confidence|score|probability/);
  });
});
