import { describe, expect, it } from "vitest";
import { evidenceCheck, filterFindings, isFiltered, NO_FILTERS, prioritySections } from "../../client/src/lib/findingFilters";
import type { FindingSummary } from "../../client/src/types";

type Row = Parameters<typeof filterFindings>[0][number] & { id: number };
const row = (id: number, over: Partial<Row> = {}): Row => ({
  id, group: "contradictions", priority: "medium", evidenceStatus: "verified", reviewState: "unreviewed", subject: null, explanation: `finding ${id}`, rank: id,
  a: { ref: "12:3-12:4" }, b: { ref: "8:1-8:2" }, analysis: { id: 1, caseId: 1 }, title: "Elena Marsh", ...over,
});

describe("filterFindings", () => {
  const rows = [
    row(1, { priority: "high" }),
    row(2, { priority: "low" }),
    row(3, { group: "needs_context", priority: "needs_context" }),
    row(4, { group: "unverified", priority: "unverified", evidenceStatus: "wrong_reference" }),
    row(5, { group: "compatible", priority: "low", evidenceStatus: "approximate", analysis: { id: 2, caseId: 9 } }),
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
  it("combines filters and keeps the review order: category, then priority", () => {
    expect(ids({})).toEqual([1, 2, 3, 5, 4]);
    expect(ids({ caseId: "9" })).toEqual([5]);
    expect(ids({ group: "contradictions", priority: "low" })).toEqual([2]);
    expect(ids({ q: "12:3" })).toEqual([1, 2, 3, 5, 4]);
    expect(ids({ q: "finding 3" })).toEqual([3]);
  });
  it("knows when any filter is set", () => {
    expect(isFiltered(NO_FILTERS)).toBe(false);
    expect(isFiltered({ ...NO_FILTERS, q: "  " })).toBe(false);
    expect(isFiltered({ ...NO_FILTERS, priority: "high" })).toBe(true);
  });
});

describe("evidenceCheck", () => {
  it("never reads a failed citation as verified", () => {
    expect((["verified", "approximate", "wrong_reference", "unsupported"] as FindingSummary["evidenceStatus"][]).map(evidenceCheck)).toEqual(["verified", "approximate", "not_verified", "not_verified"]);
  });
});

describe("prioritySections", () => {
  it("splits potential contradictions by priority and keeps compatible findings out of Low", () => {
    const { sections, compatible } = prioritySections([
      row(3, { priority: "low" }),
      row(1, { priority: "high" }),
      row(2, { group: "compatible", priority: "low" }),
      row(4, { group: "needs_context", priority: "needs_context" }),
      row(5, { group: "unverified", priority: "low" }),
      row(6, { group: "needs_context", priority: "medium" }),
    ]);
    expect(Object.fromEntries(sections.map((s) => [s.id, s.findings.map((f) => f.id)]))).toEqual({ high: [1], medium: [], low: [3], needs_context: [4, 6], unverified: [5] });
    expect(compatible.map((f) => f.id)).toEqual([2]);
  });
});
