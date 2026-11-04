// Whole-case runs as the UI states them: lanes as the server sorts findings, unread evidence never shown as
// reviewed, the spending limit a person must type, and when a new run may start.

import { describe, expect, it } from "vitest";
import { budgetProblem, canStartRun, COVERAGE, defaultLimit, laneOf, MAX_CASE_RUN_BUDGET_USD, modeEstimate } from "../../client/src/lib/caseRuns";
import { MAX_CASE_RUN_BUDGET_USD as SERVER_MAX } from "../../server/src/api/caseRuns";
import { findingGroup } from "../../server/src/api/present";
import type { CaseRun, CaseRunEstimate } from "../../client/src/types";

const finding = (over: Partial<Parameters<typeof laneOf>[0]>) => ({ evidenceStatus: "verified", unscoredReason: null, type: "direct", score: 80, priority: "high", ...over });

describe("case-run lanes", () => {
  it("sort findings exactly as the server does", () => {
    const cases = [
      finding({}),
      finding({ type: "inferential", priority: "medium" }),
      finding({ type: "false_positive", score: 70, priority: "low" }),
      finding({ type: "insufficient_evidence", score: null }),
      finding({ score: null, unscoredReason: "consistency" }),
      finding({ priority: "needs_context" }),
      finding({ evidenceStatus: "wrong_reference", score: null }),
      finding({ evidenceStatus: "unsupported" }),
      finding({ unscoredReason: "attribution_failed", score: null }),
    ];
    for (const f of cases) expect(laneOf(f)).toBe(findingGroup(f as Parameters<typeof findingGroup>[0]));
    expect(cases.map(laneOf)).toEqual(["contradictions", "contradictions", "compatible", "needs_context", "needs_context", "needs_context", "unverified", "unverified", "unverified"]);
  });
});

describe("coverage wording", () => {
  it("never calls unread pairs reviewed or cleared", () => {
    expect(COVERAGE.processed_with_unread.help).toMatch(/unread: not reviewed and not cleared/);
    expect(COVERAGE.partial.help).toMatch(/not reviewed and not cleared/);
    expect(COVERAGE.complete.tone).toBe("good");
    expect(COVERAGE.partial.tone).not.toBe("good");
  });
});

describe("the spending limit", () => {
  it("matches the server's ceiling", () => expect(MAX_CASE_RUN_BUDGET_USD).toBe(SERVER_MAX));
  it("must be a positive number of dollars within the ceiling", () => {
    expect(budgetProblem("60.04")).toBeNull();
    expect(budgetProblem("")).toMatch(/Enter/);
    expect(budgetProblem("abc")).toMatch(/Enter/);
    expect(budgetProblem("0")).toMatch(/more than \$0/);
    expect(budgetProblem("-5")).toMatch(/more than \$0/);
    expect(budgetProblem(String(MAX_CASE_RUN_BUDGET_USD + 1))).toMatch(/at most/);
  });
  it("can only be raised on resume", () => {
    expect(budgetProblem("10", 20)).toMatch(/only be raised/);
    expect(budgetProblem("40", 20)).toBeNull();
  });
});

describe("starting a whole-case run", () => {
  const run = (status: CaseRun["status"]) => ({ status }) as CaseRun;
  it("needs two read sessions and no run in progress", () => {
    expect(canStartRun(null, 1)).toMatch(/two sessions/);
    expect(canStartRun(null, 2)).toBeNull();
    for (const s of ["queued", "retrieving", "awaiting_confirmation", "adjudicating"] as const) expect(canStartRun(run(s), 4)).toMatch(/still running/);
    for (const s of ["completed", "incomplete", "blocked_budget", "cancelled", "failed"] as const) expect(canStartRun(run(s), 4)).toBeNull();
  });
});

describe("choosing fast or economy", () => {
  const base = { packets: 3771, listedPairs: 13384, splitPackets: 66, oversizePackets: 0, expectedUsd: 59.54, noCacheUsd: 85.99, largestPacketWorstCaseUsd: 0.5, recommendedBudgetUsd: 60.04, note: "" } satisfies CaseRunEstimate;
  const economy = { expectedUsd: 29.77, noCacheUsd: 43, worstCaseUsd: 400, worstCasePerBatchUsd: 11.5, recommendedBudgetUsd: 54.5, batchSize: 100, discount: 0.5 };
  it("shows fast as one figure and economy as the range from cached to uncached, each with its own limit", () => {
    expect(modeEstimate(base, "standard")).toEqual({ lowUsd: 59.54, highUsd: 59.54, recommendedUsd: 60.04 });
    expect(modeEstimate({ ...base, economy }, "batch")).toEqual({ lowUsd: 29.77, highUsd: 43, recommendedUsd: 54.5 });
  });
  it("offers no economy figure for an estimate prepared before economy mode existed", () => expect(modeEstimate(base, "batch")).toBeNull());
  it("never suggests a limit past the ceiling", () => {
    expect(defaultLimit(54.5)).toBe("54.50");
    expect(defaultLimit(MAX_CASE_RUN_BUDGET_USD + 40)).toBe(MAX_CASE_RUN_BUDGET_USD.toFixed(2));
  });
});
