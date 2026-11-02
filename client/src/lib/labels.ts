// Plain-language labels for the lawyer. Internal terms (stance, packet, cap rule names) are
// translated here, in one place, so every screen says the same thing.

import type { AnalysisStatus, DepositionStatus, FindingSummary } from "../types";

export const CLASSIFICATION: Record<FindingSummary["classification"], string> = {
  direct: "Direct contradiction",
  inferential: "Inferential contradiction",
  false_positive: "Likely compatible",
  insufficient_evidence: "Insufficient evidence",
};

export const PRIORITY: Record<FindingSummary["priority"], string> = {
  high: "High priority",
  medium: "Medium priority",
  low: "Low priority",
  needs_context: "Needs context",
  unverified: "Unverified",
};

export const ANALYSIS_STATUS: Record<AnalysisStatus, { label: string; tone: "neutral" | "active" | "good" | "warn" | "bad" }> = {
  queued: { label: "Queued", tone: "neutral" },
  parsing: { label: "Waiting for depositions to be read", tone: "active" },
  retrieving: { label: "Finding candidate passages", tone: "active" },
  adjudicating: { label: "Assessing candidate pairs", tone: "active" },
  completed: { label: "Complete", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
  blocked_budget: { label: "Stopped: budget reached", tone: "warn" },
  blocked_credentials: { label: "Stopped: model not available", tone: "warn" },
  cancelled: { label: "Cancelled", tone: "warn" },
  interrupted: { label: "Stopped: interrupted", tone: "warn" },
};

export const DEPOSITION_STATUS: Record<DepositionStatus, { label: string; tone: "neutral" | "active" | "good" | "warn" | "bad" }> = {
  processing: { label: "Reading…", tone: "active" },
  ready: { label: "Ready", tone: "good" },
  needs_review: { label: "Needs review", tone: "warn" },
  unsupported: { label: "Unsupported format", tone: "bad" },
  failed: { label: "Failed to read", tone: "bad" },
};

export const ATTRIBUTION_LEVEL: Record<string, string> = {
  clear: "Clear statement by the witness",
  qualified: "Qualified (“I think”, “maybe”…)",
  uncertain: "Not a clear yes or no",
  not_adopted: "Not the witness's own statement",
  no_recall: "Witness doesn't recall",
};

export const LOCATION: Record<string, string> = {
  answer: "in the witness's answer",
  question_affirmed: "in the question, which the witness answered “yes”",
  question_denied: "in the question, which the witness answered “no”",
  question_other: "in the question; the answer isn't a plain yes or no",
  attorney_or_colloquy: "only in an attorney's words",
  witness: "in the witness's own words",
  adopted: "in the attorney's words, plainly adopted or denied by the witness",
  attorney_only: "only in an attorney's words",
  mixed: "in attorney and witness lines together",
  unknown: "on a line with no identified speaker",
  none: "on lines with no spoken testimony",
};

export const VERIFICATION: Record<string, string> = {
  exact: "Quoted phrase found exactly in this passage",
  verified: "Quoted phrase found exactly in this passage",
  approximate: "Quoted phrase found, with small wording differences",
  wrong_reference: "Quoted phrase is not in the cited passage",
  unsupported: "Quoted phrase not found in the transcript",
};

export const SAME_EVENT: Record<string, string> = { yes: "Same event", no: "Different events", uncertain: "Unclear whether the same event" };

export const DISAGREEMENT: Record<string, string> = {
  claude_overstates: "The analysis read this as more certain than the transcript supports; the transcript's reading is used.",
  claude_understates: "The analysis read this as less certain than the witness's plain answer; the transcript's reading is used.",
  claude_differs: "The analysis and the transcript check describe this differently; the transcript's reading is used.",
  stance_conflict: "The model misread the witness's yes or no; the side is treated as not the witness's statement.",
};

export const ORIGIN: Record<string, string> = { code: "Transcript check", claude: "Analysis", "code+claude": "Both" };

export const COMPONENT: Record<string, string> = {
  A: "Attribution and source quality",
  C: "Context",
  S: "Semantic support",
  K: "Independent corroboration",
  U: "Uncertainty allowance",
};

export const formatDate = (iso: string | null) =>
  iso ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "Date not stated";

export const formatUsd = (n: number) => `$${n.toFixed(n > 0 && n < 1 ? 4 : 2)}`;

// The score always says what it supports: the proposed classification, never a probability.
export function scoreLabel(f: { classification: FindingSummary["classification"]; score: number | null; band: FindingSummary["band"] }) {
  if (f.score === null) return "Not scored";
  const band = f.band ? `${f.band[0].toUpperCase()}${f.band.slice(1)}` : "";
  return f.classification === "false_positive" ? `Support for “compatible”: ${f.score}/100 · ${band}` : `Assessment support: ${f.score}/100 · ${band}`;
}

export const GROUP_LABEL: Record<FindingSummary["group"], string> = {
  contradictions: "Potential contradictions",
  needs_context: "Needs context",
  compatible: "Compatible or dismissed",
  unverified: "Unverified",
};

export const GROUP_HELP: Record<FindingSummary["group"], string> = {
  contradictions: "Source-verified statements that may conflict. Worth your review, not proof of a contradiction.",
  needs_context: "They may conflict, but the evidence is incomplete or qualified. Not a contradiction as it stands.",
  compatible: "Not established as conflicting. Shown so nothing is hidden.",
  unverified: "A citation, quotation or speaker check failed. Don't rely on these without reading the source.",
};

const MODEL_CLASSIFICATION: Record<string, string> = {
  direct_contradiction: "a direct contradiction",
  inferential_contradiction: "an inferential contradiction",
  compatible: "compatible",
  insufficient_evidence: "not enough evidence to judge",
  uncertain_needs_context: "dependent on context it didn't have",
};

// The headline follows code's lane, never the model's label alone: a finding the checks hold back
// must not read as a contradiction.
export function findingHeadline(f: Pick<FindingSummary, "group" | "classification">) {
  if (f.group === "contradictions") return f.classification === "direct" ? "Potential direct contradiction" : "Potential inferential contradiction";
  if (f.group === "unverified") return "Unverified finding";
  if (f.group === "needs_context") return "Needs context";
  return CLASSIFICATION[f.classification];
}

export const modelCalledIt = (modelName: string, classification: string) => `${modelName} called this ${MODEL_CLASSIFICATION[classification] ?? classification.replaceAll("_", " ")}.`;

export const evidenceStrength = (f: { score: number | null }) => (f.score === null ? "Evidence strength: not scored" : `Evidence strength: ${f.score}/100`);
export const EVIDENCE_STRENGTH_NOTE = "Evidence strength measures how well the cited testimony supports review under a fixed checklist. It is not a probability that the witness contradicted themselves.";

export const SPEAKER: Record<string, string> = {
  witness: "the witness's own words",
  adopted: "the attorney's words, plainly adopted or denied by the witness",
  attorney_only: "only an attorney's words, not testimony",
  mixed: "attorney and witness lines together, unclear whose words these are",
  unknown: "no identified speaker",
  none: "no spoken testimony at the cited lines",
};

export const DISCOVERY_ATTEMPT: Record<string, string> = {
  submitting: "Sending",
  submitted: "Reading both sessions",
  succeeded: "Finished",
  refused: "Refused by the model",
  invalid_output: "Answer wasn't valid",
  incomplete: "Stopped before finishing",
  provider_failed: "Provider failure",
  expired: "Expired before running",
  cancelled: "Cancelled",
  submission_unknown: "Unknown: may have started",
};

export const EVIDENCE_STATUS: Record<FindingSummary["evidenceStatus"], string> = {
  verified: "Citations verified",
  approximate: "Citations verified (approximate)",
  wrong_reference: "Citation not verified",
  unsupported: "Citation not verified",
};

export const priorityTone = (p: FindingSummary["priority"]) => (p === "high" ? "contradiction" : p === "needs_context" || p === "unverified" ? "warn" : "neutral") as "contradiction" | "warn" | "neutral";
