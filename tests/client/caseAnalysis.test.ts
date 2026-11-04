import { describe, expect, it } from "vitest";
import { casePairs } from "../../client/src/components/CaseAnalysis";

const dep = (id: number, witnessId: number, status = "ready") => ({ id, witnessId, status }) as never;
const analysis = (a: number, b: number, status = "completed") => ({ depositionA: a, depositionB: b, status }) as never;

describe("casePairs", () => {
  it("counts every pair of ready sessions across the case, and those already checked", () => {
    // Two witnesses with two sessions each, as in the sample case: 6 pairs, 4 across witnesses, 2 checked.
    const detail = { witnesses: [], depositions: [dep(1, 10), dep(2, 10), dep(3, 20), dep(4, 20)], analyses: [analysis(1, 2), analysis(4, 3)] };
    expect(casePairs(detail)).toEqual({ sessions: 4, witnesses: 2, total: 6, crossWitness: 4, done: 2 });
  });
  it("leaves out sessions still being read and analyses that didn't finish", () => {
    const detail = { witnesses: [], depositions: [dep(1, 10), dep(2, 10), dep(3, 20, "processing")], analyses: [analysis(1, 2, "failed")] };
    expect(casePairs(detail)).toEqual({ sessions: 2, witnesses: 1, total: 1, crossWitness: 0, done: 0 });
  });
});
