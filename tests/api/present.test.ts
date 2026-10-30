// How findings are sorted into the sections a lawyer reviews. Pure.

import { describe, expect, it } from "vitest";
import { compareFindings, findingGroup } from "../../server/src/api/present";

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
