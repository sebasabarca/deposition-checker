// Prompt versions are frozen once they have produced stored verdicts, and v3's grounding fields are
// checked structurally against the packet.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkConsistency, PROMPTS, resolvesToContext, VerdictV3, type Packet, type PacketExchange, type Verdict } from "../../server/src/adjudicate";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("adjudicate-v4", () => {
  const verdict = { classification: "false_positive", conflictBasis: "none", falsePositiveReason: "both_can_be_true", sameEvent: "yes", inferenceSteps: [] } as unknown as Verdict;
  const different = [{ detail: "x", sessionA: "a", sessionB: "b", relation: "different" as const }];

  it("is v3 plus the detail comparison and its field, and names no case detail", () => {
    const v4 = PROMPTS["adjudicate-v4"].system;
    const withoutDetails = v4.replace(/\n\nDetail comparison, done before you classify:[\s\S]*?(?=\n\nFields:)/, "").replace(/\n- detailsCompared:[\s\S]*$/, "");
    expect(withoutDetails).toBe(PROMPTS["adjudicate-v3"].system);
    expect(v4).not.toMatch(/beast|limo|suv|vehicle|hutchinson/i);
  });

  it("won't let a false positive on one event dismiss a listed difference", () => {
    expect(checkConsistency({ ...verdict, detailsCompared: different })).toContain("unresolved_detail_difference");
    expect(checkConsistency({ ...verdict, detailsCompared: [{ ...different[0], relation: "only_one" }] })).not.toContain("unresolved_detail_difference");
    expect(checkConsistency({ ...verdict, sameEvent: "no", falsePositiveReason: "different_event", detailsCompared: different })).not.toContain("unresolved_detail_difference");
    expect(checkConsistency(verdict)).not.toContain("unresolved_detail_difference");
  });
});

describe("prompt versions", () => {
  it("never changes a prompt that has stored verdicts", () => {
    expect(sha(PROMPTS["adjudicate-v1"].system)).toBe("b4ff150c9a99f5bd95cb8ceccd2ddc6ec1c209bfd0cda3d3d9556722c6bb4bf9");
    expect(sha(PROMPTS["adjudicate-v2"].system)).toBe("11b4c5587ac01ce178605c6960946fbc327ca13d911f40b165e23bac4a28f854");
  });

  it("makes v3 v2 plus the grounding rule and its fields", () => {
    const v2 = PROMPTS["adjudicate-v2"].system;
    const v3 = PROMPTS["adjudicate-v3"].system;
    expect(v3).toContain("Evidence grounding:");
    expect(v3).toContain("must never supply a contradictory assertion of their own");
    expect(v3).toContain("- conflictSource:");
    expect(v3).toContain("- contextUsed:");
    // Removing the inserted section and the appended fields gives v2 back exactly.
    const withoutGrounding = v3.replace(/\n\nEvidence grounding:[\s\S]*?(?=\n\nFields:)/, "").replace(/\n- conflictSource:[\s\S]*$/, "");
    expect(withoutGrounding).toBe(v2);
  });
});

const line = (page: number, n: number, text = "x") => ({ id: page * 100 + n, page, line: n, text });
const side = (id: string, session: "A" | "B", page: number, before: number[], lines: number[], after: number[]): PacketExchange => ({
  id, depositionId: 1, groupId: 1, session, takenOn: null, witnessId: 7, partIds: [1], wholeExchange: true,
  before: before.map((n) => line(page, n)), lines: lines.map((n) => ({ ...line(page, n), role: "answer" as const })), after: after.map((n) => line(page, n)),
  gapBefore: false, gapAfter: false,
});
const packet: Packet = { candidateId: 1, witnessId: 7, witnessName: "W", a: side("E1", "A", 10, [1, 2], [3, 4], [5, 6]), b: side("E2", "B", 40, [], [1, 2], [3, 4]) };

describe("resolvesToContext", () => {
  it("accepts a shown context line or a range that covers one", () => {
    for (const ref of ["10:01", "10:2", "40:03", "10:01-10:02", "10:02-10:05", "10:04-05"]) expect(resolvesToContext(ref, packet), ref).toBe(true);
  });
  it("rejects a cited exchange's own line, a line not shown, a range across sides, and free text", () => {
    for (const ref of ["10:03", "10:03-10:04", "10:09", "39:01", "10:06-40:03", "the line before", ""]) expect(resolvesToContext(ref, packet), ref).toBe(false);
  });
});

const v3 = (fields: Partial<Verdict>): Verdict => ({
  classification: "direct", evidenceAId: "E1", evidenceBId: "E2", keyPhraseA: "a", keyPhraseB: "b",
  attributionA: "asserted", attributionB: "asserted", stanceA: "affirms", stanceB: "affirms", sameEvent: "yes", scopeAligned: "yes",
  conflictBasis: "explicit_negation", aboutTimingOfSameEvent: false, inferenceSteps: [], unestablishedAssumptions: [],
  falsePositiveReason: null, explanation: "", alternativeExplanation: null, needsMoreContext: false,
  alternativeSupport: null, conflictSource: "cited_exchanges", contextUsed: [], ...fields,
});

describe("v3 grounding checks", () => {
  it("accepts a grounded conflict that used context only to clarify", () => {
    expect(checkConsistency(v3({ contextUsed: [{ lines: "10:01-10:02", purpose: "resolve_reference" }] }), packet)).toEqual([]);
    expect(checkConsistency(v3({ classification: "false_positive", conflictBasis: "none", falsePositiveReason: "both_can_be_true", conflictSource: "none" }), packet)).toEqual([]);
  });

  it("flags a conflict that, by the verdict's own account, comes from the context", () => {
    expect(checkConsistency(v3({ conflictSource: "context" }), packet)).toEqual(["conflict_not_grounded"]);
  });

  it("flags a verdict with no conflict that claims one from the cited exchanges", () => {
    expect(checkConsistency(v3({ classification: "false_positive", conflictBasis: "none", falsePositiveReason: "both_can_be_true" }), packet)).toEqual(["conflict_source_without_conflict"]);
  });

  it("flags a context reference that wasn't shown as context", () => {
    expect(checkConsistency(v3({ contextUsed: [{ lines: "10:03", purpose: "same_event" }] }), packet)).toEqual(["context_reference_not_in_packet"]);
    expect(checkConsistency(v3({ contextUsed: [{ lines: "12:01", purpose: "same_event" }] }), packet)).toEqual(["context_reference_not_in_packet"]);
  });

  it("flags inference steps that don't cite both exchanges, for every prompt version", () => {
    const steps = (ids: string[]) => ({ classification: "inferential" as const, conflictBasis: "requires_inference" as const, inferenceSteps: [{ statement: "s", supportingIds: ids }] });
    expect(checkConsistency(v3(steps(["E1", "E2"])), packet)).toEqual([]);
    expect(checkConsistency(v3(steps(["E1"])), packet)).toEqual(["inference_not_grounded_in_both"]);
    expect(checkConsistency(v3(steps(["E1", "E2", "E9"])), packet)).toEqual(["inference_step_unverified_evidence"]);
    expect(checkConsistency(v3(steps([])), packet)).toEqual(["inference_step_unverified_evidence", "inference_not_grounded_in_both"]);
    const { alternativeSupport: _a, conflictSource: _c, contextUsed: _u, ...v1 } = v3(steps(["E2"]));
    expect(checkConsistency(v1, packet)).toEqual(["inference_not_grounded_in_both"]);
  });

  it("requires the v3 fields in the schema, and still rejects any number", () => {
    const ok = v3({});
    expect(VerdictV3.safeParse(ok).success).toBe(true);
    const { conflictSource: _, ...missing } = ok;
    expect(VerdictV3.safeParse(missing).success).toBe(false);
    expect(VerdictV3.safeParse({ ...ok, contextUsed: [{ lines: "10:01", purpose: "contradicting_assertion" }] }).success).toBe(false);
    for (const key of ["confidence", "score", "band", "probability", "certainty"]) expect(VerdictV3.safeParse({ ...ok, [key]: 1 }).success).toBe(false);
  });
});
