// Human review decisions, saved with the case. "confirmed" is shown to a lawyer as "Kept".

import type { ReviewDecision } from "../types";

export const REVIEW_LABEL: Record<ReviewDecision | "unreviewed", string> = {
  unreviewed: "Not decided",
  confirmed: "Kept",
  needs_context: "Needs more context",
  dismissed: "Dismissed",
};

export const decisionOf = (reviewState: string): ReviewDecision | "unreviewed" => (reviewState in REVIEW_LABEL ? (reviewState as ReviewDecision | "unreviewed") : "unreviewed");
