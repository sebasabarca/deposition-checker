// Whole-case runs as the UI states them: lanes as the server sorts findings, unread evidence never shown as
// reviewed, the spending limit a person must type, and when a new run may start.

import { describe, expect, it } from "vitest";
import { budgetProblem, canStartRun, COVERAGE, defaultLimit, laneOf, MAX_CASE_RUN_BUDGET_USD, modeEstimate, reuseAdjusted, MOVING_RUN, RESUMABLE_RUN, RUN_STATUS, isAnalysis, isEstimate, isUnusedEstimate, runScopeKey, scopeKey, scopeProblem, timeLeft, workflowStep } from "../../client/src/lib/caseRuns";
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
  it("an economy run settling its costs after a correction doesn't block a new run, can't be resumed, and keeps refreshing", () => {
    expect(canStartRun(run("reconciling"), 4)).toBeNull();
    expect(RESUMABLE_RUN).not.toContain("reconciling");
    expect(MOVING_RUN).toContain("reconciling");
    expect(RUN_STATUS.reconciling.label).toMatch(/corrected/);
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
  it("subtracts the expected reuse from the cost, never from the recommended limit, and a fresh analysis expects none", () => {
    const reuse = { checked: true, reusableRequests: 40, expectedAvoidedUsd: 20, economy: { expectedAvoidedUsd: 10 } };
    const e = { ...base, economy, reuse };
    expect(reuseAdjusted(e, "standard", false)).toEqual({ lowUsd: 39.54, highUsd: 39.54, recommendedUsd: 60.04, reusable: 40, avoidedUsd: 20 });
    expect(reuseAdjusted(e, "batch", false)).toEqual({ lowUsd: 19.77, highUsd: 28.56, recommendedUsd: 54.5, reusable: 40, avoidedUsd: 10 }); // both ends scaled by the share left to pay
    expect(reuseAdjusted({ ...e, reuse: { ...reuse, economy: { expectedAvoidedUsd: 29.77 } } }, "batch", false)).toMatchObject({ lowUsd: 0, highUsd: 0 }); // fully reused: $0 at both ends
    expect(reuseAdjusted(e, "standard", true)).toEqual({ lowUsd: 59.54, highUsd: 59.54, recommendedUsd: 60.04, reusable: 0, avoidedUsd: 0 });
    expect(reuseAdjusted({ ...e, reuse: { ...reuse, checked: false } }, "standard", false)!.reusable).toBe(0);
    expect(reuseAdjusted({ ...e, reuse: { ...reuse, expectedAvoidedUsd: 100 } }, "standard", false)!.lowUsd).toBe(0); // never below zero
    expect(reuseAdjusted(base, "standard", false)).toEqual({ ...modeEstimate(base, "standard")!, reusable: 0, avoidedUsd: 0 }); // estimates without reuse data
  });
  it("never suggests a limit past the ceiling", () => {
    expect(defaultLimit(54.5)).toBe("54.50");
    expect(defaultLimit(MAX_CASE_RUN_BUDGET_USD + 40)).toBe(MAX_CASE_RUN_BUDGET_USD.toFixed(2));
  });
});

describe("the guided analysis workflow", () => {
  it("opens one step at a time: depositions, choice with its estimate, cost, results", () => {
    const none = { running: false, estimate: false, finishedHere: false };
    expect(workflowStep(none, null, 0)).toBe(1); // a new case starts by adding depositions
    expect(workflowStep(none, null, 3)).toBe(1); // and confirms them before choosing
    expect(workflowStep(none, "scope", 1)).toBe(1); // fewer than two ready sessions: back to adding
    expect(workflowStep(none, "scope", 3)).toBe(2);
    expect(workflowStep({ ...none, estimate: true }, null, 3)).toBe(2); // a pending estimate shows with its choice
    expect(workflowStep({ ...none, estimate: true }, "review", 3)).toBe(3);
    expect(workflowStep(none, "review", 3)).toBe(2); // no estimate to review: back to the choice
    expect(workflowStep({ ...none, running: true }, "depositions", 3)).toBe(4); // a running analysis decides
    expect(workflowStep({ ...none, finishedHere: true }, null, 3)).toBe(4); // an analysis that finished while watched stays on its results
    expect(workflowStep({ ...none, finishedHere: true }, "scope", 3)).toBe(2); // until a new analysis is started
    expect(workflowStep(none, null, 3)).toBe(1); // coming back after earlier analyses starts the steps again
  });
  it("tells estimates from analyses, and an estimate's choice from another", () => {
    const run = (status: string, confirmedAt: string | null, mode = "live") => ({ status, confirmedAt, mode }) as never;
    expect(isEstimate(run("retrieving", null))).toBe(true);
    expect(isEstimate(run("awaiting_confirmation", null))).toBe(true);
    expect(isEstimate(run("adjudicating", "2026-11-05"))).toBe(false);
    expect(isUnusedEstimate(run("cancelled", null))).toBe(true);
    expect(isUnusedEstimate(run("cancelled", "2026-11-05"))).toBe(false); // a confirmed run cancelled mid-way is an analysis
    expect(isAnalysis(run("completed", null, "mock"))).toBe(true);
    const read = { status: "incomplete", confirmedAt: null, mode: "live", packets: { adjudicated: 7 } } as never; // e.g. a replay of recorded calls
    expect(isAnalysis(read)).toBe(true);
    expect(isUnusedEstimate(read)).toBe(false);
    expect(isUnusedEstimate({ status: "cancelled", confirmedAt: null, mode: "live", packets: { adjudicated: 2 } } as never)).toBe(false);
    expect(isUnusedEstimate(run("failed", null))).toBe(true);
    expect(scopeKey([3, 1], undefined)).toBe(scopeKey([1, 3], "packet-c3")); // Focused Analysis: packet-c3
    expect(scopeKey(null, "packet-v1")).not.toBe(scopeKey(null, undefined)); // an earlier packet-v1 run isn't the Focused choice
    expect(scopeKey(null, undefined)).not.toBe(scopeKey([1, 3], undefined));
    expect(scopeKey(null, "stretch-v2")).not.toBe(scopeKey(null, undefined));
    expect(runScopeKey({ scope: { kind: "depositions", depositionIds: [3, 1] }, contract: "packet-c3" } as never)).toBe(scopeKey([1, 3], undefined));
  });
  it("accepts the whole case, or at least two ready selected depositions", () => {
    const deps = [{ id: 1, status: "ready" }, { id: 2, status: "ready" }, { id: 3, status: "processing" }];
    expect(scopeProblem("case", [], deps)).toBeNull();
    expect(scopeProblem("selected", [1, 2], deps)).toBeNull();
    expect(scopeProblem("selected", [1], deps)).toMatch(/at least two/);
    expect(scopeProblem("selected", [1, 3], deps)).toMatch(/finished reading/);
  });
});

describe("timeLeft", () => {
  const start = "2026-11-05T12:00:00Z";
  const at = (s: number) => Date.parse(start) + s * 1000;
  const run = (done: number, total = 100, execution: "standard" | "batch" = "standard") => ({ execution, startedAt: start, packets: { adjudicated: done, total } });
  it("waits for enough of the run before guessing", () => {
    expect(timeLeft(run(10), at(10))).toBeNull(); // under 20 seconds
    expect(timeLeft(run(2), at(60))).toBeNull(); // under 3% done
  });
  it("projects from the pace so far", () => {
    expect(timeLeft(run(25), at(60))).toBe("About 3 minutes left"); // 25 in a minute, 75 to go
    expect(timeLeft(run(90), at(60))).toBe("Less than a minute left");
    expect(timeLeft(run(5), at(3600))).toBe("About 19 hours left");
  });
  it("never guesses for economy or a finished run", () => {
    expect(timeLeft(run(50, 100, "batch"), at(600))).toBeNull();
    expect(timeLeft(run(100), at(600))).toBeNull();
  });
});
