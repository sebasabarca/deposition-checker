// The findings list's filters and order, as pure functions so they can be tested without a browser.

import type { WorkspaceFinding } from "../types";
import { decisionOf, type ShownDecision } from "./review";

type Lane = WorkspaceFinding["lane"];
export const GROUP_ORDER: Lane[] = ["contradictions", "needs_context", "compatible", "unverified", "quarantined"];
export const PRIORITY_ORDER = ["high", "medium", "low", "needs_context", "unverified"] as const;
const rank = (p: string) => { const i = (PRIORITY_ORDER as readonly string[]).indexOf(p); return i < 0 ? PRIORITY_ORDER.length : i; };

// What code found when it checked the citations against the stored lines, in three plain states.
export type EvidenceCheck = "verified" | "approximate" | "not_verified";
export const evidenceCheck = (s: string): EvidenceCheck => (s === "verified" ? "verified" : s === "approximate" ? "approximate" : "not_verified");

// The decision that holds now: a finding set aside for revalidation has none, whatever was decided before.
export const decisionShown = (f: Pick<WorkspaceFinding, "lane" | "reviewState">): ShownDecision => (f.lane === "quarantined" ? "quarantined" : decisionOf(f.reviewState));

export type FindingFilters = { caseId: string; group: string; priority: string; evidence: string; decision: string; q: string };
export const NO_FILTERS: FindingFilters = { caseId: "", group: "", priority: "", evidence: "", decision: "", q: "" };

// The findings that pass every filter, by lane, then priority, newest analysis first, keeping each analysis's own
// order (retrieval rank) within.
export function filterFindings<T extends Pick<WorkspaceFinding, "caseId" | "runId" | "lane" | "priority" | "evidenceStatus" | "reviewState" | "explanation" | "caseName"> & { a: { witness: string | null; range: string | null }; b: { witness: string | null; range: string | null } }>(rows: readonly T[], f: FindingFilters): T[] {
  const term = f.q.trim().toLowerCase();
  const order = new Map(rows.map((r, i) => [r, i]));
  const quarantined = (r: T) => r.lane === "quarantined";
  return rows
    .filter((r) => (!f.caseId || String(r.caseId) === f.caseId) && (!f.group || r.lane === f.group) && (!f.priority || r.priority === f.priority))
    .filter((r) => (!f.evidence || evidenceCheck(r.evidenceStatus) === f.evidence) && (!f.decision || decisionShown(r) === f.decision))
    // A quarantined finding has no current priority, citation check or decision: those filters never match it.
    .filter((r) => !quarantined(r) || (!f.priority && !f.evidence && !f.decision))
    .filter((r) => !term || [r.explanation, r.a.range, r.b.range, r.a.witness, r.b.witness, r.caseName].some((s) => s?.toLowerCase().includes(term)))
    .sort((a, b) => GROUP_ORDER.indexOf(a.lane) - GROUP_ORDER.indexOf(b.lane) || rank(a.priority) - rank(b.priority) || b.runId - a.runId || order.get(a)! - order.get(b)!);
}

export const isFiltered = (f: FindingFilters) => Object.entries(f).some(([k, v]) => (k === "q" ? v.trim() !== "" : v !== ""));
