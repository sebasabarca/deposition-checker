// The semantic consistency check on a verdict's own categorical fields.

import { describe, expect, it } from "vitest";
import { checkConsistency, readVerdict, VerdictV2, type Verdict } from "../../server/src/adjudicate";

const v = (fields: Partial<Verdict>): Verdict => ({
  classification: "direct", evidenceAId: "E1", evidenceBId: "E2", keyPhraseA: "a", keyPhraseB: "b",
  attributionA: "asserted", attributionB: "asserted", stanceA: "affirms", stanceB: "affirms", sameEvent: "yes", scopeAligned: "yes",
  conflictBasis: "explicit_negation", aboutTimingOfSameEvent: false, inferenceSteps: [], unestablishedAssumptions: [],
  falsePositiveReason: null, explanation: "", alternativeExplanation: null, needsMoreContext: false, ...fields,
});
const fp = (fields: Partial<Verdict> = {}) => v({ classification: "false_positive", conflictBasis: "none", falsePositiveReason: "both_can_be_true", ...fields });

describe("checkConsistency", () => {
  it("accepts consistent verdicts of every classification", () => {
    expect(checkConsistency(v({}))).toEqual([]);
    expect(checkConsistency(v({ classification: "inferential", conflictBasis: "requires_inference", inferenceSteps: [{ statement: "s", supportingIds: ["E1"] }] }))).toEqual([]);
    expect(checkConsistency(fp())).toEqual([]);
    expect(checkConsistency(fp({ falsePositiveReason: "different_event", sameEvent: "no" }))).toEqual([]);
    expect(checkConsistency(v({ classification: "insufficient_evidence", conflictBasis: "none" }))).toEqual([]);
  });

  it("flags a false positive that names a conflict, as Sonnet did for Cho under v1", () => {
    expect(checkConsistency(fp({ conflictBasis: "value_conflict" }))).toEqual(["false_positive_with_conflict_basis"]);
  });

  it("flags different_event without different events, as for the warehouse under v1", () => {
    expect(checkConsistency(fp({ falsePositiveReason: "different_event", sameEvent: "uncertain" }))).toEqual(["different_event_without_different_events"]);
  });

  it("flags a conflict without a basis, a reason without a false positive, and an inference without steps", () => {
    expect(checkConsistency(v({ conflictBasis: "none" }))).toEqual(["conflict_without_basis"]);
    expect(checkConsistency(v({ falsePositiveReason: "both_can_be_true" }))).toEqual(["reason_without_false_positive"]);
    expect(checkConsistency(fp({ falsePositiveReason: null }))).toEqual(["false_positive_without_reason"]);
    expect(checkConsistency(v({ classification: "inferential", conflictBasis: "requires_inference" }))).toEqual(["inferential_without_steps"]);
  });

  it("leaves direct with sameEvent no to the rubric's cap (DESIGN case 13)", () => {
    expect(checkConsistency(v({ sameEvent: "no" }))).toEqual([]);
  });

  it("checks v2's alternative support against the alternative and the classification", () => {
    expect(checkConsistency(v({ alternativeExplanation: "x", alternativeSupport: "plausible" }))).toEqual([]);
    expect(checkConsistency(v({ alternativeExplanation: null, alternativeSupport: null }))).toEqual([]);
    expect(checkConsistency(v({ alternativeExplanation: "x", alternativeSupport: null }))).toEqual(["alternative_support_mismatch"]);
    expect(checkConsistency(v({ alternativeExplanation: null, alternativeSupport: "speculative" }))).toEqual(["alternative_support_mismatch"]);
    expect(checkConsistency(v({ alternativeExplanation: "x", alternativeSupport: "established" }))).toEqual(["established_alternative"]);
    expect(checkConsistency(fp({ alternativeExplanation: "x", alternativeSupport: "established" }))).toEqual(["established_alternative"]);
  });
});

describe("adjudicate-v2 schema", () => {
  const base = { ...v({}), alternativeSupport: null };
  it("requires alternativeSupport and still rejects any number", () => {
    expect(VerdictV2.safeParse(base).success).toBe(true);
    const { alternativeSupport: _, ...without } = base;
    expect(VerdictV2.safeParse(without).success).toBe(false);
    for (const key of ["confidence", "score", "band", "probability", "certainty"]) expect(VerdictV2.safeParse({ ...base, [key]: 1 }).success).toBe(false);
  });
  it("reads a response with the schema of the prompt that asked", () => {
    expect(readVerdict("end_turn", JSON.stringify(base), "adjudicate-v2").status).toBe("valid");
    expect(readVerdict("end_turn", JSON.stringify(base), "adjudicate-v1").status).toBe("schema_invalid"); // v1 is strict: no extra key
    expect(readVerdict("end_turn", JSON.stringify(v({})), "adjudicate-v2").status).toBe("schema_invalid");
  });
});
