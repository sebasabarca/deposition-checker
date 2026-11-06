// The client's pure helpers: routes, and the wording of scores and statuses. A score must always
// say what it supports and never read as a probability or a percentage.

import { describe, expect, it } from "vitest";
import { CLASSIFICATION, findingHeadline, scoreLabel } from "../../client/src/lib/labels";
import { href, parseRoute } from "../../client/src/lib/router";

describe("client routes", () => {
  it("parses every route and round-trips the links it makes", () => {
    expect(parseRoute("")).toEqual({ name: "overview" });
    expect(parseRoute(href.overview())).toEqual({ name: "overview" });
    expect(parseRoute(href.cases())).toEqual({ name: "cases" });
    expect(parseRoute(href.help())).toEqual({ name: "help" });
    expect(parseRoute(href.case(7))).toEqual({ name: "case", id: 7 });
    expect(parseRoute(href.depositions())).toEqual({ name: "depositions", caseId: null });
    expect(parseRoute(href.depositions(4))).toEqual({ name: "depositions", caseId: 4 });
    expect(parseRoute(href.deposition(9))).toEqual({ name: "deposition", id: 9, page: null, q: "", mark: "" });
    expect(parseRoute(href.deposition(9, { page: 33, q: "limo car" }))).toEqual({ name: "deposition", id: 9, page: 33, q: "limo car", mark: "" });
    expect(parseRoute(href.deposition(9, { page: 6, mark: "6:04-6:08" }))).toEqual({ name: "deposition", id: 9, page: 6, q: "", mark: "6:04-6:08" });
    expect(parseRoute(href.deposition(9, { page: 0 }))).toEqual({ name: "deposition", id: 9, page: 0, q: "", mark: "" });
    expect(parseRoute(href.findings())).toEqual({ name: "findings" });
    expect(parseRoute(href.analyses())).toEqual({ name: "analyses" });
    expect(parseRoute(href.caseRun(38))).toEqual({ name: "case_run", id: 38 });
    expect(parseRoute("#/analyses/3")).toEqual({ name: "not_found" }); // an earlier two-session check's link
    expect(parseRoute("#/cases/abc")).toEqual({ name: "not_found" });
  });
});

describe("score wording", () => {
  it("labels support for the proposed classification, never a probability", () => {
    expect(scoreLabel({ classification: "direct", score: 85, band: "high" })).toBe("Assessment support: 85/100 · High");
    expect(scoreLabel({ classification: "false_positive", score: 80, band: "high" })).toBe("Support for “compatible”: 80/100 · High");
    expect(scoreLabel({ classification: "inferential", score: null, band: null })).toBe("Not scored");
    for (const c of Object.keys(CLASSIFICATION) as (keyof typeof CLASSIFICATION)[]) {
      expect(scoreLabel({ classification: c, score: 60, band: "medium" })).not.toMatch(/%|probab|likel/i);
    }
  });

});

describe("direct findings in the interface", () => {
  it("never headlines a held-back finding as a contradiction", () => {
    expect(findingHeadline({ group: "contradictions", classification: "direct" })).toBe("Potential direct contradiction");
    expect(findingHeadline({ group: "contradictions", classification: "inferential" })).toBe("Potential inferential contradiction");
    expect(findingHeadline({ group: "needs_context", classification: "direct" })).toBe("Needs context");
    expect(findingHeadline({ group: "unverified", classification: "direct" })).toBe("Unverified finding");
    expect(findingHeadline({ group: "compatible", classification: "false_positive" })).toBe("Likely compatible");
  });
});
