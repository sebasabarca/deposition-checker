// How findings are sorted into the sections a lawyer reviews. Pure.

import { describe, expect, it } from "vitest";
import { compareFindings, findingGroup } from "../../server/src/api/present";
import { candidateCoverage } from "../../server/src/api/present";

const f = (fields: Partial<Parameters<typeof findingGroup>[0]>) => ({ type: "direct", evidenceStatus: "verified", score: 80, unscoredReason: null, priority: "high", ...fields });

describe("finding sections", () => {
  it("puts only verified, scored conflicts under potential contradictions", () => {
    expect(findingGroup(f({}))).toBe("contradictions");
    expect(findingGroup(f({ type: "inferential", evidenceStatus: "approximate" }))).toBe("contradictions");
  });
  it("never presents a false positive as a contradiction", () => {
    expect(findingGroup(f({ type: "false_positive", priority: "low" }))).toBe("compatible");
  });
  it("sends unverified citations, inconsistent verdicts and context gaps to review", () => {
    expect(findingGroup(f({ evidenceStatus: "unsupported", score: null, priority: "low" }))).toBe("review");
    expect(findingGroup(f({ evidenceStatus: "wrong_reference", score: null, priority: "low" }))).toBe("review");
    expect(findingGroup(f({ score: null, unscoredReason: "inconsistent_verdict", priority: "needs_context" }))).toBe("review");
    expect(findingGroup(f({ score: null, unscoredReason: "no_witness_assertion", priority: "needs_context" }))).toBe("review");
    expect(findingGroup(f({ score: 25, priority: "needs_context" }))).toBe("review");
  });
  it("keeps insufficient evidence separate", () => {
    expect(findingGroup(f({ type: "insufficient_evidence", score: null, unscoredReason: "insufficient_evidence", priority: "needs_context" }))).toBe("insufficient");
  });
  it("orders by priority, then score", () => {
    const rows = [
      { id: 1, priority: "low", score: 99 },
      { id: 2, priority: "high", score: 70 },
      { id: 3, priority: "high", score: 90 },
      { id: 4, priority: "needs_context", score: null },
    ];
    expect(rows.sort(compareFindings).map((r) => r.id)).toEqual([3, 2, 1, 4]);
  });
});

describe("candidateCoverage", () => {
  const row = (status: string, sources: string[], n: number, over = {}) => ({ status, sources, n, deferredReason: null, exclusionReason: null, selectedBy: null, ...over });

  it("accounts for every candidate, keeping assessed and awaiting apart", () => {
    const c = candidateCoverage([
      row("adjudicated", ["topics", "fulltext"], 2, { selectedBy: "path_a" }),
      row("selected", ["fulltext"], 3, { selectedBy: "path_b" }),
      row("deferred", ["topics"], 4, { deferredReason: "budget" }),
      row("deferred", ["topics"], 1, { deferredReason: "cap" }),
      row("excluded", ["topics"], 5, { exclusionReason: "side_not_answered" }),
    ]);
    expect(c).toMatchObject({ total: 15, assessed: 2, awaitingAssessment: 3, deferred: { total: 5, reasons: { budget: 4, cap: 1 } }, excluded: { total: 5, reasons: { side_not_answered: 5 } } });
    expect(c.provenance).toEqual({ path_a: 10, path_b: 3, both: 2, other: 0 });
    expect(c.foundBy).toEqual({ pathA: 12, pathB: 5 }); // a pair both found counts in both
    expect(c.selectedBy).toEqual({ path_a: 2, path_b: 3 });
  });
});
