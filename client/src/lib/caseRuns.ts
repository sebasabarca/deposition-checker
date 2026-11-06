// Whole-case runs as the UI states them: pure, so the rules are tested without a browser.
// The lanes mirror server/src/api/present.ts (findingGroup); the coverage words follow docs/case-run-api.md:
// unread evidence is never shown as reviewed or as "no contradiction".

import type { CaseRun, CaseRunEstimate, CaseRunExecution, CaseRunFinding, CaseRunStatus, CoverageState } from "../types";
import type { Tone } from "../components/ui";

// Mirrors MAX_CASE_RUN_BUDGET_USD in server/src/api/caseRuns.ts.
export const MAX_CASE_RUN_BUDGET_USD = 250;

export const ACTIVE_RUN: CaseRunStatus[] = ["queued", "retrieving", "awaiting_confirmation", "adjudicating"];
export const RESUMABLE_RUN: CaseRunStatus[] = ["incomplete", "failed", "blocked_budget", "blocked_credentials", "cancelled", "interrupted"];
// Statuses during which the run changes on its own: the page polls these.
// Statuses that change without anyone acting, so the page refreshes: `reconciling` ends in `failed` by itself.
export const MOVING_RUN: CaseRunStatus[] = ["queued", "retrieving", "adjudicating", "reconciling"];

export const RUN_STATUS: Record<CaseRunStatus, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "active" },
  retrieving: { label: "Preparing", tone: "active" },
  awaiting_confirmation: { label: "Waiting for your confirmation", tone: "warn" },
  adjudicating: { label: "Analyzing", tone: "active" },
  completed: { label: "Finished", tone: "good" },
  incomplete: { label: "Incomplete", tone: "warn" },
  failed: { label: "Failed", tone: "bad" },
  blocked_budget: { label: "Stopped at the spending limit", tone: "warn" },
  blocked_credentials: { label: "Paid calls are off on this server", tone: "warn" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  interrupted: { label: "Interrupted", tone: "warn" },
  reconciling: { label: "Stopped: transcript corrected (settling costs)", tone: "warn" },
};

export const COVERAGE: Record<CoverageState, { label: string; tone: Tone; help: string }> = {
  complete: { label: "Complete coverage", tone: "good", help: "Every candidate pair retrieval found was read and has a verdict." },
  processed_with_unread: { label: "Read, with pairs set aside", tone: "warn", help: "Every evidence packet was read, but retrieval set some pairs aside. Those pairs are unread: not reviewed and not cleared." },
  partial: { label: "Partial: work left", tone: "warn", help: "Some pairs have not been read yet. Unread pairs are not reviewed and not cleared." },
};

export type Lane = "contradictions" | "needs_context" | "compatible" | "unverified" | "quarantined";
export const LANES: { id: Lane; label: string }[] = [
  { id: "contradictions", label: "Potential contradictions" },
  { id: "needs_context", label: "Needs context" },
  { id: "unverified", label: "Unverified" },
  { id: "compatible", label: "Compatible or dismissed" },
  { id: "quarantined", label: "Needs revalidation" },
];

// A finding whose transcript was re-read with a corrected parser is set aside for revalidation, whatever its verdict.
export function laneOf(f: Pick<CaseRunFinding, "evidenceStatus" | "unscoredReason" | "type" | "score" | "priority"> & { standing?: CaseRunFinding["standing"] }): Lane {
  if (f.standing?.state === "quarantined") return "quarantined";
  if (f.evidenceStatus === "wrong_reference" || f.evidenceStatus === "unsupported" || f.unscoredReason === "attribution_failed") return "unverified";
  if (f.type === "insufficient_evidence" || f.unscoredReason === "insufficient_evidence") return "needs_context";
  if (f.score === null || f.priority === "needs_context") return "needs_context";
  return f.type === "false_positive" ? "compatible" : "contradictions";
}

// The spending limit a person types before a paid run: a number of dollars, above zero, within the ceiling,
// and never below what the run has already spent (a resume can only raise it).
export function budgetProblem(text: string, floorUsd = 0): string | null {
  const v = Number(text);
  if (text.trim() === "" || !Number.isFinite(v)) return "Enter the spending limit in US dollars.";
  if (v <= 0) return "The spending limit must be more than $0.";
  if (v > MAX_CASE_RUN_BUDGET_USD) return `The spending limit can be at most $${MAX_CASE_RUN_BUDGET_USD} for one whole-case analysis.`;
  if (v < floorUsd) return `The limit can only be raised: it is already $${floorUsd.toFixed(2)}.`;
  return null;
}

// What the latest run means for the "start" buttons: whether a new one may start, and why not.
export function canStartRun(latest: CaseRun | null, readySessions: number): string | null {
  if (readySessions < 2) return "Add at least two sessions that have finished reading first.";
  if (latest && ACTIVE_RUN.includes(latest.status)) return "A whole-case analysis of this case is still running.";
  return null;
}

export const isTestRun = (run: Pick<CaseRun, "mode">) => run.mode === "mock";

// The two ways a paid run can read the case: the same evidence, prompt, checks and scoring; only the transport,
// the time it takes and the price differ (docs/case-run-api.md).
export const EXECUTION: Record<CaseRunExecution, { label: string; short: string; description: string }> = {
  standard: { label: "Fast Analysis", short: "Fast", description: "Get your results sooner. Ideal when you need to review potential contradictions as quickly as possible." },
  batch: { label: "Economy Analysis", short: "Economy", description: "Save on analysis costs when you're not in a hurry." },
};

// A rough time left for a fast run, from its pace so far; null until there's enough to go on (the first few
// percent, or the first 20 seconds), and for economy, whose batches run on the provider's schedule.
export function timeLeft(run: { execution: CaseRunExecution; startedAt: string | null; packets: { adjudicated: number; total: number } }, now: number): string | null {
  const { adjudicated: done, total } = run.packets;
  if (run.execution === "batch" || !run.startedAt || total === 0 || done >= total) return null;
  const elapsed = now - Date.parse(run.startedAt);
  if (elapsed < 20_000 || done < Math.max(3, total * 0.03)) return null;
  const minutes = Math.round((elapsed * (total - done)) / done / 60_000);
  if (minutes < 1) return "Less than a minute left";
  if (minutes < 60) return `About ${minutes} ${minutes === 1 ? "minute" : "minutes"} left`;
  const hours = Math.round(minutes / 60);
  return `About ${hours} ${hours === 1 ? "hour" : "hours"} left`;
}

// What the confirm step shows for a mode: the cost as a single figure (fast) or a range (economy: the provider's
// cache is best effort, so from fast mode's caching to none), and the recommended limit. null when the estimate
// predates economy mode.
export function modeEstimate(e: CaseRunEstimate, execution: CaseRunExecution): { lowUsd: number; highUsd: number; recommendedUsd: number } | null {
  if (execution === "standard") return { lowUsd: e.expectedUsd, highUsd: e.expectedUsd, recommendedUsd: e.recommendedBudgetUsd };
  if (!e.economy) return null;
  return { lowUsd: e.economy.expectedUsd, highUsd: e.economy.noCacheUsd, recommendedUsd: e.economy.recommendedBudgetUsd };
}

// The cost after expected exact-request reuse: the requests an earlier run of this case already answered word for word
// are expected to be answered again from that run, at no charge. A fresh analysis expects none. The recommended
// limit stays the whole run's, since an expected reuse can still miss (then that request is sent and charged).
export function reuseAdjusted(e: CaseRunEstimate, execution: CaseRunExecution, fresh: boolean): { lowUsd: number; highUsd: number; recommendedUsd: number; reusable: number; avoidedUsd: number } | null {
  const m = modeEstimate(e, execution);
  if (!m) return null;
  const reusable = !fresh && e.reuse?.checked ? e.reuse.reusableRequests : 0;
  if (!reusable) return { ...m, reusable: 0, avoidedUsd: 0 };
  const avoided = execution === "batch" ? e.reuse!.economy.expectedAvoidedUsd : e.reuse!.expectedAvoidedUsd;
  // The share of the projected cost still to be paid, applied to both ends of the range (the no-cache end too), so a
  // fully reused run reads $0.00 at both ends.
  const left = m.lowUsd > 0 ? Math.max(0, 1 - avoided / m.lowUsd) : 0;
  const scale = (x: number) => Math.round(x * left * 100) / 100;
  return { lowUsd: scale(m.lowUsd), highUsd: scale(m.highUsd), recommendedUsd: m.recommendedUsd, reusable, avoidedUsd: avoided };
}

// The recommended limit can't pass the ceiling a person is allowed to confirm.
export const defaultLimit = (recommendedUsd: number) => Math.min(recommendedUsd, MAX_CASE_RUN_BUDGET_USD).toFixed(2);

// The guided analysis on the case page, one step open at a time: add depositions (1), choose what to analyze, with
// its estimate prepared automatically (2), review the cost and start (3), then the analysis and its results (4).
export type AnalysisScope = "case" | "selected";
export type WorkflowStep = 1 | 2 | 3 | 4;
export type WorkflowChoice = "depositions" | "scope" | "review" | null;
type RunLike = Pick<CaseRun, "status" | "mode" | "confirmedAt"> & { packets?: Pick<CaseRun["packets"], "adjudicated"> };
const readAny = (r: RunLike) => (r.packets?.adjudicated ?? 0) > 0;

// A live run not yet confirmed and still open is an estimate: prepared, waiting, never spent.
export const isEstimate = (r: RunLike) => r.mode === "live" && r.confirmedAt === null && ["queued", "retrieving", "awaiting_confirmation"].includes(r.status);
// An estimate replaced, cancelled or failed before anyone confirmed it and before anything was read: nothing was spent,
// so it isn't listed as an analysis.
export const isUnusedEstimate = (r: RunLike) => r.mode === "live" && r.confirmedAt === null && (r.status === "cancelled" || r.status === "failed") && !readAny(r);
// An analysis that ran (or is running): confirmed with a spending limit, an earlier test-model run, or any run that
// read evidence.
export const isAnalysis = (r: RunLike) => r.confirmedAt !== null || r.mode === "mock" || readAny(r);

// results: the case has an analysis (finished, stopped or incomplete), so the page opens on it at step 4, with the way
// to its review, until the person chooses to start a new one (an estimate waiting is shown then). Earlier analyses are listed under the steps (PreviousAnalyses).
export function workflowStep(s: { running: boolean; estimate: boolean; results: boolean }, choice: WorkflowChoice, readySessions: number): WorkflowStep {
  if (s.running) return 4;
  if (choice === "depositions" || readySessions < 2) return 1;
  if (choice === "scope") return 2;
  if (choice === "review") return s.estimate ? 3 : 2;
  if (s.results) return 4; // the latest analysis first, even with an estimate waiting
  if (s.estimate) return 2; // back on the page with an estimate pending: show it with its choice
  return 1;
}

// What an estimate was prepared for, so a change of choice can be told from the estimate already shown.
export const scopeKey = (depositionIds: readonly number[] | null, contract: string | undefined) => JSON.stringify([depositionIds ? [...depositionIds].sort((a, b) => a - b) : null, contract ?? "packet-c3"]);
export const runScopeKey = (r: Pick<CaseRun, "scope" | "contract">) => scopeKey(r.scope && r.scope.kind === "depositions" ? r.scope.depositionIds : null, r.contract);

// Why the chosen depositions can't be analyzed yet, or null. The server checks the same, and also that they span
// at least two sessions (testimony is compared across sessions).
export function scopeProblem(scope: AnalysisScope, selected: readonly number[], depositions: readonly { id: number; status: string }[]): string | null {
  if (scope === "case") return null;
  const chosen = depositions.filter((d) => selected.includes(d.id));
  if (chosen.some((d) => d.status !== "ready")) return "Some selected depositions haven't finished reading. Unselect them, or wait until they're ready.";
  if (chosen.length < 2) return "Select at least two depositions: testimony is compared across sessions.";
  return null;
}
