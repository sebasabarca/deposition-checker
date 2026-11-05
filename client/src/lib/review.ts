// Human review decisions, saved with the case. "confirmed" is shown to a lawyer as "Kept".

import type { FindingStanding, ReviewDecision } from "../types";
import { ApiError } from "./api";
import { formatDate } from "./labels";

export const REVIEW_LABEL: Record<ReviewDecision | "unreviewed", string> = {
  unreviewed: "Not decided",
  confirmed: "Kept",
  needs_context: "Needs more context",
  dismissed: "Dismissed",
};

export const decisionOf = (reviewState: string): ReviewDecision | "unreviewed" => (reviewState in REVIEW_LABEL ? (reviewState as ReviewDecision | "unreviewed") : "unreviewed");

// A quarantined finding's evidence changed when its transcript was re-read with a corrected parser. It is kept for
// audit with its earlier review, but it is not current: never in a review queue, a count of decisions or a report.
type Standing = { standing?: FindingStanding; group?: string };
export const isQuarantined = (f: Standing) => f.standing?.state === "quarantined" || f.group === "quarantined";

// The decision that holds now. A quarantined finding has none, whatever was decided before.
export type ShownDecision = ReviewDecision | "unreviewed" | "quarantined";
export const shownDecision = (f: Standing & { reviewState: string }): ShownDecision => (isQuarantined(f) ? "quarantined" : decisionOf(f.reviewState));
export const SHOWN_DECISION_LABEL: Record<ShownDecision, string> = { ...REVIEW_LABEL, quarantined: "Needs revalidation" };

const PRIOR: Record<ReviewDecision, string> = { confirmed: "Previously kept", needs_context: "Previously marked as needing more context", dismissed: "Previously dismissed" };
// The earlier review, always in the past tense, so it never reads as a current decision.
export function priorReviewText(p: Extract<FindingStanding, { state: "quarantined" }>["priorReview"]) {
  const d = decisionOf(p.state);
  if (d === "unreviewed") return "It had not been reviewed.";
  return `${PRIOR[d]}${p.reviewedAt ? ` on ${formatDate(p.reviewedAt)}` : ""}.`;
}

// Why the review controls are off for a finding, or null when it can be reviewed.
export const reviewLock = (f: Standing): string | null => (isQuarantined(f) ? "This finding needs revalidation, so it can't be reviewed. It is kept for audit only." : null);

// A failed save shows the server's own message. A 409 means the finding was set aside while it was open, so the controls lock.
export const reviewFailure = (e: unknown) => ({ message: e instanceof Error ? e.message : String(e), locked: e instanceof ApiError && e.status === 409 });
