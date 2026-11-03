// The evidence-strength checklist, with expected values worked out from its published points. Pure.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evidenceStrength, EVIDENCE_STRENGTH_VERSION, type StrengthCheck } from "../../server/src/score";
import type { DirectSide, Lane } from "../../server/src/verify";

const side = (over: Partial<DirectSide> = {}): DirectSide => ({ depositionId: 1, citation: "1:01", resolved: true, quote: "exact", matchScore: 1, speaker: "witness", level: "clear", rule: "", qualifier: null, noRecall: false, reportedSpeech: false, ocr: { read: false, minConfidence: null, lowLines: [] }, lineIds: [1], pdfPages: [1], physicalLines: false, ...over });
const score = (over: { classification?: string; comparable?: string; lane?: Lane; a?: Partial<DirectSide>; b?: Partial<DirectSide> } = {}) => evidenceStrength({ classification: "direct_contradiction", comparable: "yes", lane: "contradictions", ...over, a: side(over.a), b: side(over.b) });
const points = (checks: StrengthCheck[]) => checks.map((c) => c.points);

describe("evidence strength", () => {
  it("gives a flat, verified direct contradiction every point, and High", () => {
    expect(score()).toMatchObject({ score: 100, band: "high", priority: "high" });
    expect(EVIDENCE_STRENGTH_VERSION).toBe("evidence-strength-v1");
  });

  it("takes 10 for a hedged side, and keeps High, as in Webb's home-versus-groceries pair", () => {
    const s = score({ b: { level: "qualified", qualifier: "I think" } });
    expect(points(s.checks)).toEqual([20, 20, 10, 20, 20]);
    expect(s).toMatchObject({ score: 90, priority: "high" });
  });

  it("takes 10 for an approximate quotation", () => {
    expect(points(score({ a: { quote: "approximate" } }).checks)[0]).toBe(10);
  });

  it("gives an inference half the conflict points", () => {
    expect(score({ classification: "inferential_contradiction" })).toMatchObject({ score: 90 });
  });

  it("counts secondhand testimony and no recollection as not clear", () => {
    expect(points(score({ a: { reportedSpeech: true } }).checks)[2]).toBe(10);
    expect(points(score({ a: { reportedSpeech: true }, b: { noRecall: true, level: "no_recall" } }).checks)[2]).toBe(0);
  });

  // June 6:04-07 / September 33:07-09: secondhand on one side, and the model said it depends on context.
  it("scores the limo/SUV shape 70, and leaves it in needs context", () => {
    const s = score({ classification: "uncertain_needs_context", lane: "needs_context", a: { reportedSpeech: true } });
    expect(points(s.checks)).toEqual([20, 20, 10, 20, 0]);
    expect(s).toMatchObject({ score: 70, priority: "needs_context" });
  });

  it("never lets a high score leave needs context", () => {
    expect(score({ classification: "direct_contradiction", lane: "needs_context" })).toMatchObject({ score: 100, priority: "needs_context" });
  });

  it("keeps scores as a description: a band doesn't set priority", () => {
    expect(score({ classification: "inferential_contradiction", comparable: "uncertain", a: { level: "qualified" }, b: { reportedSpeech: true } })).toMatchObject({ score: 50, band: "medium", priority: "medium" });
  });

  it.each([
    ["an invented quotation", { lane: "unverified" as Lane, a: { quote: "not_found" as const } }],
    ["a wrong reference", { lane: "unverified" as Lane, a: { quote: "elsewhere_in_session" as const } }],
    ["an attorney's words", { lane: "unverified" as Lane, a: { speaker: "attorney_only" as const } }],
    ["an unknown speaker", { lane: "needs_context" as Lane, a: { speaker: "unknown" as const } }],
    ["mixed speakers", { lane: "needs_context" as Lane, b: { speaker: "mixed" as const } }],
    ["an unresolved citation", { lane: "unverified" as Lane, b: { resolved: false } }],
  ])("doesn't score %s", (_, over) => {
    expect(score(over)).toMatchObject({ score: null, band: null, checks: [], notScored: expect.stringContaining("Not scored") });
  });

  it("gives a compatible finding no number", () => {
    expect(score({ classification: "compatible", lane: "compatible" })).toMatchObject({ score: null, priority: "low", notScored: expect.stringContaining("Not applicable") });
  });

  it("gives an unverified finding its own priority, whatever its inputs", () => {
    expect(score({ lane: "unverified", a: { quote: "not_found" } })).toMatchObject({ priority: "unverified", score: null });
    expect(score({ lane: "unverified" })).toMatchObject({ priority: "unverified", score: null });
  });

  it("counts adopted testimony as the witness's", () => {
    expect(score({ b: { speaker: "adopted" } }).score).toBe(100);
  });

  it("gives the same result for the same input", () => {
    expect(score({ a: { reportedSpeech: true } })).toEqual(score({ a: { reportedSpeech: true } }));
  });
});

describe("review priority", () => {
  it("doesn't let a perfect score make an inference High", () => {
    expect(score({ classification: "inferential_contradiction" })).toMatchObject({ score: 90, priority: "medium" });
  });

  // 11:15 / 45:02-45:03. Fable classed it inferential, so nothing here names the case.
  it("keeps the Webb parking-lot shape in contradictions, at Medium", () => {
    const s = score({ classification: "inferential_contradiction", b: { level: "qualified" } });
    expect(s).toMatchObject({ score: 80, priority: "medium" });
  });

  it("gives Medium to a direct conflict with both sides hedged, as in Webb's sleep times", () => {
    expect(score({ a: { level: "qualified" }, b: { level: "qualified" } })).toMatchObject({ score: 80, priority: "medium" });
  });

  it("gives Medium to a direct label on an uncertain subject", () => {
    expect(score({ comparable: "uncertain" }).priority).toBe("medium");
  });

  it("keeps a direct label with missing context in needs context", () => {
    expect(score({ lane: "needs_context" }).priority).toBe("needs_context");
  });

  it("doesn't take secondhand testimony as a plain assertion", () => {
    expect(score({ a: { reportedSpeech: true }, b: { reportedSpeech: true } }).priority).toBe("medium");
  });

  it("rescoring makes no model call: it imports no provider", () => {
    const script = readFileSync("scripts/rescore-direct.ts", "utf8");
    expect(script).not.toMatch(/anthropic|adjudicate|fetch\(/i);
  });
});
