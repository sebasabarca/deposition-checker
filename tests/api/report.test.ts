// The report header's witness list: short enough for its column in a large case.
import { describe, expect, it } from "vitest";
import { witnessSummary } from "../../server/src/api/report";

describe("witnessSummary", () => {
  const names = (n: number) => Array.from({ length: n }, (_, i) => `Witness ${i + 1}`);
  it("names every witness of a small case", () => {
    expect(witnessSummary([])).toBe("None");
    expect(witnessSummary(names(2))).toBe("Witness 1, Witness 2");
    expect(witnessSummary(names(4))).toBe("Witness 1, Witness 2, Witness 3, Witness 4"); // "and 1 more" would save nothing
  });
  it("names the first three of a large case and counts the rest", () => {
    expect(witnessSummary(names(20))).toBe("Witness 1, Witness 2, Witness 3 and 17 more");
  });
});
