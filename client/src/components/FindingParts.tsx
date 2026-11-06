// Small parts every finding list uses: the person's three decisions, a decision's dot, a short citation, and the
// notice for a finding set aside for revalidation.

import { CircleCheck, CircleHelp, History, X } from "lucide-react";
import { displayRef } from "../lib/insights";
import { formatDate } from "../lib/labels";
import { priorReviewText, type ShownDecision } from "../lib/review";
import type { FindingStanding, ReviewDecision } from "../types";
import { Alert } from "./ui";

export const OPTIONS: { d: ReviewDecision; label: string; icon: typeof X; on: string }[] = [
  { d: "confirmed", label: "Keep", icon: CircleCheck, on: "bg-ok text-white ring-ok" },
  { d: "needs_context", label: "Needs context", icon: CircleHelp, on: "bg-context text-white ring-context" },
  { d: "dismissed", label: "Dismiss", icon: X, on: "bg-muted text-white ring-muted" },
];

export const DECISION_DOT: Record<ShownDecision, string> = {
  unreviewed: "bg-sheet ring-1 ring-inset ring-control",
  confirmed: "bg-ok",
  needs_context: "bg-context",
  dismissed: "bg-faint",
  quarantined: "border border-dashed border-muted bg-sheet",
};

// The deposition's own references, as stored; unnumbered text reads "Line N".
export const shortRef = (ref: string | null) => displayRef(ref) ?? "no reference";

// A finding that needs revalidation: its transcript was re-read with a corrected parser after it was made. Says so in
// words, with the server's reason and the earlier review in the past tense, never as a current decision.
export function StandingNotice({ standing, compact }: { standing?: FindingStanding; compact?: boolean }) {
  if (standing?.state !== "quarantined") return null;
  const prior = priorReviewText(standing.priorReview);
  const note = standing.priorReview.note;
  if (compact) {
    return (
      <span className="mt-0.5 block text-xs text-muted">
        <History aria-hidden className="mr-1 inline size-3 align-[-1px]" />
        Needs revalidation: the transcript was re-read with a corrected parser. Kept for audit, not a current finding. {prior}
      </span>
    );
  }
  return (
    <Alert tone="info" title="Needs revalidation: kept for audit, not a current finding">
      <p>The transcript was re-read with a corrected parser{standing.parser ? ` (${standing.parser})` : ""} on {formatDate(standing.since)}, after this finding was made. Reason: {standing.reason}.</p>
      <p className="mt-1">This finding is kept for audit only and can't be reviewed. {prior}</p>
      {note && <p className="mt-1 whitespace-pre-wrap">Note at the time: {note}</p>}
    </Alert>
  );
}
