import { describe, expect, it } from "vitest";
import { countsToward, provenanceOf } from "../../server/src/retrieve/provenance";

describe("candidate provenance", () => {
  it.each([[["topics"], "path_a"], [["claims"], "path_a"], [["fulltext"], "path_b"], [["topics", "fulltext"], "both"], [["claims", "fulltext"], "both"], [["fixture"], "other"]])("reads %j as %s", (sources, expected) => {
    expect(provenanceOf(sources)).toBe(expected);
  });
  it("counts a pair found by both toward both paths", () => {
    expect(countsToward(["topics", "fulltext"], "path_a")).toBe(true);
    expect(countsToward(["topics", "fulltext"], "path_b")).toBe(true);
    expect(countsToward(["topics"], "path_b")).toBe(false);
  });
});
