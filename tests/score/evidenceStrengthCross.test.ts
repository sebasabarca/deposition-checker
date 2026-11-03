import { describe, expect, it } from "vitest";
import { evidenceStrengthCross } from "../../server/src/score/evidenceStrengthCross";
import type { DirectSide } from "../../server/src/verify/direct";

const side = (over: Partial<DirectSide> = {}): DirectSide => ({ depositionId: 1, citation: "1:01", resolved: true, quote: "exact", matchScore: 1, speaker: "witness", level: "clear", rule: "", qualifier: null, noRecall: false, reportedSpeech: false, ocr: { read: false, minConfidence: null, lowLines: [] }, lineIds: [1], pdfPages: [1], physicalLines: false, ...over });

describe("evidence-strength-cross-v1", () => {
  it("gives high priority only to two first-hand accounts that can't both be true", () => {
    const strong = evidenceStrengthCross({ classification: "direct_conflict", lane: "contradictions", a: side(), b: side(), basisA: "personal_observation", basisB: "personal_observation" });
    expect([strong.score, strong.priority]).toEqual([100, "high"]);
  });

  it("holds a conflict resting on what someone was told at medium, and says why", () => {
    const told = evidenceStrengthCross({ classification: "direct_conflict", lane: "contradictions", a: side(), b: side(), basisA: "told_by_someone", basisB: "personal_observation" });
    expect([told.score, told.priority, told.priorityReason]).toEqual([90, "medium", "One account is second-hand."]);
    // Code's own reported-speech check overrides a model that calls it first-hand.
    const reported = evidenceStrengthCross({ classification: "direct_conflict", lane: "contradictions", a: side({ reportedSpeech: true }), b: side(), basisA: "personal_observation", basisB: "personal_observation" });
    expect(reported.priority).toBe("medium");
  });

  it("scores nothing that isn't a verified possible conflict", () => {
    expect(evidenceStrengthCross({ classification: "compatible", lane: "compatible", a: side(), b: side(), basisA: "personal_observation", basisB: "personal_observation" }).score).toBeNull();
    expect(evidenceStrengthCross({ classification: "direct_conflict", lane: "unverified", a: side({ speaker: "attorney_only" }), b: side(), basisA: "personal_observation", basisB: "personal_observation" })).toMatchObject({ score: null, priority: "unverified" });
  });
});
