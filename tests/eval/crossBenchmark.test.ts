import { describe, expect, it } from "vitest";
import { scoreCross, type ScoredFinding, type ScoredPair } from "../../server/src/eval/crossBenchmark";

const pairs: ScoredPair[] = [
  { id: "clean", expected: "conflict", a: [1, 2], b: [11] },
  { id: "contextual", expected: "conflict_needs_context", a: [3], b: [12] },
  { id: "control", expected: "no_conflict", a: [4], b: [13] },
];
const f = (index: number, lane: string, a: number[], b: number[]): ScoredFinding => ({ index, lane, classification: "direct_conflict", evidenceStatus: "verified", a, b });

describe("cross-witness scoring", () => {
  it("counts discovery in either lane, but strict recall only for a confirmed conflict in the contradictions lane", () => {
    const s = scoreCross(pairs, [f(0, "needs_context", [2], [11]), f(1, "contradictions", [12], [3])]);
    expect([s.discoveryRecall.rate, s.discoveryRecall.missed]).toEqual([1, []]);
    expect([s.strictRecall.rate, s.strictRecall.onlyAsNeedsContext]).toEqual([0, ["clean"]]);
    expect(s.strictRecall.caution).toMatch(/Only 1 labelled example: each one moves this rate by 100 points/);
    // A needs-context target in the contradictions lane is shown, never counted as a proven contradiction.
    expect(s.contextTargetsReportedAsContradictions).toEqual(["contextual"]);
  });

  it("shows exploratory cases without scoring them, and says when a measure has nothing to count", () => {
    const withExploratory: ScoredPair[] = [{ id: "ctx", expected: "conflict_needs_context", a: [3], b: [12] }, { id: "explore", expected: "exploratory", a: [7], b: [17] }];
    const s = scoreCross(withExploratory, [f(0, "contradictions", [7], [17])]);
    expect(s.exploratory).toEqual([{ id: "explore", reportedAs: "contradictions" }]);
    expect(s.pipeline.unlabelledForReview).toEqual([]); // matched an exploratory case, so not "unlabelled"
    expect([s.discoveryRecall.labelled, s.discoveryRecall.rate]).toEqual([1, 0]);
    expect([s.strictRecall.rate, s.strictRecall.caution]).toEqual([null, "Not measurable: the set has no labels of this kind."]);
  });

  it("counts a reported negative control against the model, and leaves unlabelled findings for review", () => {
    const s = scoreCross(pairs, [f(0, "contradictions", [4], [13]), f(1, "contradictions", [5], [14]), f(2, "compatible", [4], [13])]);
    expect([s.falsePositives.rate, s.falsePositives.reported]).toEqual([1, ["control"]]);
    expect(s.pipeline.unlabelledForReview).toEqual([1]);
    expect(s.discoveryRecall.missed).toEqual(["clean", "contextual"]);
  });
});
