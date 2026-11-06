import { describe, expect, it } from "vitest";
import { decisionShown, evidenceCheck, filterFindings, isFiltered, NO_FILTERS } from "../../client/src/lib/findingFilters";
import type { WorkspaceFinding } from "../../client/src/types";

const row = (id: number, over: Partial<WorkspaceFinding> = {}): WorkspaceFinding => ({
  id, runId: 1, runName: null, caseId: 1, caseName: "Marsh", lane: "contradictions", type: "direct", priority: "medium", score: 60, evidenceStatus: "verified",
  reviewState: "unreviewed", reviewedAt: null, crossWitness: false, explanation: `finding ${id}`,
  a: { witness: "Elena Marsh", takenOn: null, range: "12:3–12:4" }, b: { witness: "Elena Marsh", takenOn: null, range: "8:1–8:2" }, ...over,
});

describe("filterFindings", () => {
  const rows = [
    row(1, { priority: "high" }),
    row(2, { priority: "low" }),
    row(3, { lane: "needs_context", priority: "needs_context" }),
    row(4, { lane: "unverified", priority: "unverified", evidenceStatus: "wrong_reference" }),
    row(5, { lane: "compatible", priority: "low", evidenceStatus: "approximate", runId: 2, caseId: 9 }),
    row(6, { lane: "quarantined", reviewState: "confirmed" }),
  ];
  const ids = (f: Partial<typeof NO_FILTERS>) => filterFindings(rows, { ...NO_FILTERS, ...f }).map((r) => r.id);

  it("filters by review priority", () => {
    expect(ids({ priority: "high" })).toEqual([1]);
    expect(ids({ priority: "low" })).toEqual([2, 5]);
    expect(ids({ priority: "needs_context" })).toEqual([3]);
  });
  it("filters by what code found when it checked the citations", () => {
    expect(ids({ evidence: "not_verified" })).toEqual([4]);
    expect(ids({ evidence: "approximate" })).toEqual([5]);
    expect(ids({ evidence: "verified" })).toEqual([1, 2, 3]);
  });
  it("combines filters and keeps the review order: category, then priority, a finding set aside last", () => {
    expect(ids({})).toEqual([1, 2, 3, 5, 4, 6]);
    expect(ids({ caseId: "9" })).toEqual([5]);
    expect(ids({ group: "contradictions", priority: "low" })).toEqual([2]);
    expect(ids({ q: "12:3" })).toEqual([1, 2, 3, 5, 4, 6]);
    expect(ids({ q: "finding 3" })).toEqual([3]);
  });
  it("never shows a finding set aside for revalidation as decided, nor matches it by decision", () => {
    expect(decisionShown(rows[5])).toBe("quarantined");
    expect(ids({ decision: "confirmed" })).toEqual([]);
  });
  it("knows when any filter is set", () => {
    expect(isFiltered(NO_FILTERS)).toBe(false);
    expect(isFiltered({ ...NO_FILTERS, q: "  " })).toBe(false);
    expect(isFiltered({ ...NO_FILTERS, priority: "high" })).toBe(true);
  });
});

describe("evidenceCheck", () => {
  it("never reads a failed citation as verified", () => {
    expect(["verified", "approximate", "wrong_reference", "unsupported"].map(evidenceCheck)).toEqual(["verified", "approximate", "not_verified", "not_verified"]);
  });
});
