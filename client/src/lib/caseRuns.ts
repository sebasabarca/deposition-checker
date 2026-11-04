// Whole-case runs as the UI states them: pure, so the rules are tested without a browser.
// The lanes mirror server/src/api/present.ts (findingGroup); the coverage words follow docs/case-run-api.md:
// unread evidence is never shown as reviewed or as "no contradiction".

import type { CaseRun, CaseRunFinding, CaseRunStatus, CoverageState } from "../types";
import type { Tone } from "../components/ui";

// Mirrors MAX_CASE_RUN_BUDGET_USD in server/src/api/caseRuns.ts.
export const MAX_CASE_RUN_BUDGET_USD = 250;

export const ACTIVE_RUN: CaseRunStatus[] = ["queued", "retrieving", "awaiting_confirmation", "adjudicating"];
export const RESUMABLE_RUN: CaseRunStatus[] = ["incomplete", "failed", "blocked_budget", "blocked_credentials", "cancelled", "interrupted"];
// Statuses during which the run changes on its own: the page polls these.
export const MOVING_RUN: CaseRunStatus[] = ["queued", "retrieving", "adjudicating"];

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
};

export const COVERAGE: Record<CoverageState, { label: string; tone: Tone; help: string }> = {
  complete: { label: "Complete coverage", tone: "good", help: "Every candidate pair retrieval found was read and has a verdict." },
  processed_with_unread: { label: "Read, with pairs set aside", tone: "warn", help: "Every evidence packet was read, but retrieval set some pairs aside. Those pairs are unread: not reviewed and not cleared." },
  partial: { label: "Partial: work left", tone: "warn", help: "Some pairs have not been read yet. Unread pairs are not reviewed and not cleared." },
};

export type Lane = "contradictions" | "needs_context" | "compatible" | "unverified";
export const LANES: { id: Lane; label: string }[] = [
  { id: "contradictions", label: "Potential contradictions" },
  { id: "needs_context", label: "Needs context" },
  { id: "unverified", label: "Unverified" },
  { id: "compatible", label: "Compatible or dismissed" },
];

export function laneOf(f: Pick<CaseRunFinding, "evidenceStatus" | "unscoredReason" | "type" | "score" | "priority">): Lane {
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
