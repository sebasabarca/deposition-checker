import { describe, expect, it } from "vitest";
import { causesOf, factorLabelsReworded, onlyStoredFields, same } from "../scripts/audit-findings";
import { VERIFICATION_VERSION, verificationVersionOf } from "../server/src/verify/version";

describe("verificationVersionOf", () => {
  it("reads the stored version, and unversioned for older rows", () => {
    expect(verificationVersionOf({ verificationVersion: VERIFICATION_VERSION })).toBe(VERIFICATION_VERSION);
    expect(verificationVersionOf({ source: {} })).toBe("unversioned");
    expect(verificationVersionOf(null)).toBe("unversioned");
  });
});

describe("audit comparison", () => {
  it("ignores jsonb key order and fields added after a row was stored", () => {
    expect(same({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 })).toBe(true);
    const stored = { status: "verified", proposition: undefined };
    expect(same(stored, onlyStoredFields({ status: "verified", proposition: "new field" }, stored))).toBe(true);
    expect(same(stored, onlyStoredFields({ status: "approximate", proposition: "x" }, stored))).toBe(false);
  });
});

describe("causesOf", () => {
  const LATER = "2026-10-31T01:00:00Z";
  it("names the removed Path A claims", () => {
    const d = { createdAt: LATER, diffs: ["extractionDisagreement", "factors", "score"], detail: { extractionDisagreement: { stored: true, now: false } } };
    expect(causesOf(d)).toEqual(["path_a_claims_removed"]);
  });

  it("names the Oct 29 fixes for findings stored before the baseline commit", () => {
    const d = { createdAt: "2026-10-29T22:21:00Z", diffs: ["consistency", "factors", "score", "priority"], detail: { consistency: { stored: [], now: ["x"] }, priority: { stored: "needs_context", now: "low" } } };
    expect(causesOf(d)).toEqual(["pre_baseline_consistency_check", "pre_baseline_priority_routing"]);
  });

  it("names OCR bar normalization only when the match score rose on a line with a bar", () => {
    const side = (matchScore: number, answerText: string) => ({ status: matchScore === 1 ? "verified" : "approximate", matchScore, answerText });
    const bar = { createdAt: "2026-11-01T00:10:00Z", diffs: ["source", "factors", "score"], detail: { source: { stored: { a: side(1, "x"), b: side(0.9, "And| also") }, now: { a: side(1, "x"), b: side(1, "And| also") } } } };
    expect(causesOf(bar)).toEqual(["ocr_bar_normalization"]);
    const noBar = { ...bar, detail: { source: { stored: { a: side(1, "x"), b: side(0.9, "And I also") }, now: { a: side(1, "x"), b: side(1, "And I also") } } } };
    expect(causesOf(noBar)).toEqual(["unexplained"]);
  });

  it("calls an unknown input change unexplained", () => {
    expect(causesOf({ createdAt: LATER, diffs: ["attribution", "score"], detail: { attribution: { stored: {}, now: {} } } })).toEqual(["unexplained"]);
    expect(causesOf({ createdAt: LATER, diffs: ["score"], detail: {} })).toEqual(["unexplained"]);
  });
});

describe("audit causes added in Milestone 2.5", () => {
  it("names a factor-label rewording with the same points, and nothing else", () => {
    expect(factorLabelsReworded(["A:Side A: code agrees with Claude's attribution=8/8", "C:Claude: no more context needed=5/5"], ["A:Side A: code agrees with the analysis's attribution=8/8", "C:Analysis: no more context needed=5/5"])).toBe(true);
    expect(factorLabelsReworded(["A:Side A: code agrees with Claude's attribution=8/8"], ["A:Side A: code agrees with the analysis's attribution=4/8"])).toBe(false);
  });

  it("attributes a source difference to the reading fixes only with evidence from the previous verifier", () => {
    const d = { createdAt: "2026-11-02T12:00:00Z", diffs: ["source", "factors", "score"], detail: { source: { stored: { a: { status: "approximate" } }, now: { a: { status: "verified" } } } } };
    expect(causesOf(d)).toEqual(["unexplained"]);
    expect(causesOf({ ...d, previousDiffs: ["source"] })).toEqual(["unexplained"]); // it differed before: not this version
    expect(causesOf({ ...d, previousDiffs: [] })).toEqual(["reading_fixes_verify_2026_11_04"]);
  });
});
