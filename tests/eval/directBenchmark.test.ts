// How the synthetic evaluation counts. Pure.
import { describe, expect, it } from "vitest";
import { scoreBenchmark, type BenchmarkFinding, type BenchmarkTarget } from "../../server/src/eval/directBenchmark";

const target = (id: string, a: number[], b: number[]): BenchmarkTarget => ({ id, label: "direct", a, b });
const finding = (lane: string, a: number[], b: number[], over: Partial<BenchmarkFinding> = {}): BenchmarkFinding => ({ lane, modelClassification: "direct_contradiction", evidenceStatus: "verified", a: { depositionId: 1, lineIds: a }, b: { depositionId: 2, lineIds: b }, ...over });
const score = (findings: BenchmarkFinding[], extra = {}) => scoreBenchmark({ sessionA: 1, targets: [target("t1", [1, 2], [8]), target("t2", [3], [9]), target("t3", [4], [10])], traps: [target("trap", [5], [11])], findings, proposals: findings.length, truth: [], codeSaysWitness: () => true, ...extra });

describe("the synthetic evaluation", () => {
  it("matches by source lines on both sides, not one", () => {
    expect(score([finding("contradictions", [2], [8])]).found).toEqual(["t1"]);
    expect(score([finding("contradictions", [2], [99])]).found).toEqual([]);
  });

  it("matches a finding cited the other way round", () => {
    expect(score([{ ...finding("contradictions", [8], [2]), a: { depositionId: 2, lineIds: [8] }, b: { depositionId: 1, lineIds: [2] } }]).found).toEqual(["t1"]);
  });

  it("doesn't count needs-context as a confirmed detection", () => {
    const s = score([finding("needs_context", [3], [9])]);
    expect(s.found).toEqual([]);
    expect(s.needsContextOnly).toEqual(["t2"]);
    expect(s.recall).toBe(0);
    expect(s.recallCountingContext).toBeCloseTo(1 / 3);
    expect(s.unresolvedNeedingContext).toBe(1);
  });

  it("counts recall, precision, false positives and traps", () => {
    const s = score([finding("contradictions", [1], [8]), finding("contradictions", [5], [11]), finding("contradictions", [50], [60], { modelClassification: "inferential_contradiction" })]);
    expect(s).toMatchObject({ recall: 1 / 3, reported: 3, falsePositives: 2, trapsFlagged: ["trap"], direct: 2, inferential: 1, missed: ["t2", "t3"] });
    expect(s.precision).toBeCloseTo(1 / 3);
  });

  it("reports citation validity and speaker accuracy from the fixture's own turns", () => {
    const s = score([finding("needs_context", [1], [8], { evidenceStatus: "approximate" }), finding("contradictions", [3], [9])], { truth: [{ lineId: 1, witness: true }, { lineId: 3, witness: false }], codeSaysWitness: (id: number) => id === 1 });
    expect(s.citationValidity).toBe(0.5);
    expect(s.speakerAccuracy).toBe(1);
  });

  it("reports nothing as perfect when nothing was reported", () => {
    expect(score([]).precision).toBeNull();
  });
});
