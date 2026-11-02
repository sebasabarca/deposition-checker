// The client's pure helpers: routes, and the wording of scores and statuses. A score must always
// say what it supports and never read as a probability or a percentage.

import { describe, expect, it } from "vitest";
import { ANALYSIS_STATUS, CLASSIFICATION, findingHeadline, scoreLabel } from "../../client/src/lib/labels";
import { reviewOf } from "../../client/src/lib/review";
import { href, parseRoute } from "../../client/src/lib/router";

describe("client routes", () => {
  it("parses every route and round-trips the links it makes", () => {
    expect(parseRoute("")).toEqual({ name: "dashboard" });
    expect(parseRoute("#/")).toEqual({ name: "dashboard" });
    expect(parseRoute(href.cases())).toEqual({ name: "cases" });
    expect(parseRoute(href.depositions())).toEqual({ name: "depositions" });
    expect(parseRoute(href.analyses())).toEqual({ name: "analyses" });
    expect(parseRoute(href.findings())).toEqual({ name: "findings" });
    expect(parseRoute(href.review())).toEqual({ name: "review" });
    expect(parseRoute(href.help())).toEqual({ name: "help" });
    expect(parseRoute(href.case(7))).toEqual({ name: "case", id: 7 });
    expect(parseRoute(href.analysis(3))).toEqual({ name: "analysis", id: 3, findingId: null });
    expect(parseRoute(href.analysis(3, 41))).toEqual({ name: "analysis", id: 3, findingId: 41 });
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

describe("direct findings in the interface", () => {
  it("never headlines a held-back finding as a contradiction", () => {
    expect(findingHeadline({ group: "contradictions", classification: "direct" })).toBe("Potential direct contradiction");
    expect(findingHeadline({ group: "contradictions", classification: "inferential" })).toBe("Potential inferential contradiction");
    expect(findingHeadline({ group: "needs_context", classification: "direct" })).toBe("Needs context");
    expect(findingHeadline({ group: "unverified", classification: "direct" })).toBe("Unverified finding");
    expect(findingHeadline({ group: "compatible", classification: "false_positive" })).toBe("Likely compatible");
  });

  it("carries a decision to the same evidence in a later analysis", () => {
    const decided = { "e:key": { decision: "dismissed" as const, note: "", decidedAt: "2026-11-01" } };
    expect(reviewOf(99, "unreviewed", decided, "key")).toBe("dismissed");
    expect(reviewOf(99, "unreviewed", decided, "other")).toBe("unreviewed");
    expect(reviewOf(99, "unreviewed", decided)).toBe("unreviewed");
  });
});
