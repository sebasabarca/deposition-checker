// Plain-language labels for the lawyer. Internal terms (stance, packet, cap rule names) are
// translated here, in one place, so every screen says the same thing.

import type { DepositionStatus, FindingSummary } from "../types";

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

export const DEPOSITION_STATUS: Record<DepositionStatus, { label: string; tone: "neutral" | "active" | "good" | "warn" | "bad" }> = {
  processing: { label: "Reading…", tone: "active" },
  ready: { label: "Ready", tone: "good" },
  needs_review: { label: "Needs review", tone: "warn" },
  unsupported: { label: "Unsupported format", tone: "bad" },
  failed: { label: "Failed to read", tone: "bad" },
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
  quarantined: "Needs revalidation",
};

// The headline follows code's lane, never the model's label alone: a finding the checks hold back
// must not read as a contradiction.
export function findingHeadline(f: Pick<FindingSummary, "group" | "classification"> & { cross?: unknown }) {
  if (f.group === "quarantined") return "Needs revalidation";
  if (f.group === "contradictions" && f.cross) return "Potential conflict between witnesses";
  if (f.group === "contradictions") return f.classification === "direct" ? "Potential direct contradiction" : "Potential inferential contradiction";
  if (f.group === "unverified") return "Unverified finding";
  if (f.group === "needs_context") return "Needs context";
  return CLASSIFICATION[f.classification];
}

export const SPEAKER: Record<string, string> = {
  witness: "the witness's own words",
  adopted: "the attorney's words, plainly adopted or denied by the witness",
  attorney_only: "only an attorney's words, not testimony",
  mixed: "attorney and witness lines together, unclear whose words these are",
  unknown: "no identified speaker",
  none: "no spoken testimony at the cited lines",
};

export const EVIDENCE_STATUS: Record<FindingSummary["evidenceStatus"], string> = {
  verified: "Citations verified",
  approximate: "Citations verified (approximate)",
  wrong_reference: "Citation not verified",
  unsupported: "Citation not verified",
};

// Why a paid analysis can't start for this account.
export const NO_ACCESS = "Paid checks aren't enabled for this account yet. Veridict is in early access; contact us to turn them on.";
