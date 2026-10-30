// The client's pure helpers: routes, and the wording of scores and statuses. A score must always
// say what it supports and never read as a probability or a percentage.

import { describe, expect, it } from "vitest";
import { ANALYSIS_STATUS, CLASSIFICATION, scoreLabel } from "../../client/src/lib/labels";
import { href, parseRoute } from "../../client/src/lib/router";

describe("client routes", () => {
  it("parses every route and round-trips the links it makes", () => {
    expect(parseRoute("")).toEqual({ name: "cases" });
    expect(parseRoute("#/")).toEqual({ name: "cases" });
    expect(parseRoute(href.case(7))).toEqual({ name: "case", id: 7 });
    expect(parseRoute(href.analysis(3))).toEqual({ name: "analysis", id: 3, findingId: null });
    expect(parseRoute(href.analysis(3, 41))).toEqual({ name: "analysis", id: 3, findingId: 41 });
    expect(parseRoute(href.classic())).toEqual({ name: "classic" });
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

  it("names every analysis status", () => {
    for (const s of ["queued", "parsing", "retrieving", "adjudicating", "completed", "failed", "blocked_budget", "blocked_credentials"] as const) {
      expect(ANALYSIS_STATUS[s].label.length).toBeGreaterThan(0);
    }
  });
});
