// The findings list's filters and order, as pure functions so they can be tested without a browser.

import type { FindingSummary } from "../types";
import { decisionOf } from "./review";

export const GROUP_ORDER: FindingSummary["group"][] = ["contradictions", "needs_context", "compatible", "unverified"];
export const PRIORITY_ORDER: FindingSummary["priority"][] = ["high", "medium", "low", "needs_context", "unverified"];
const RANK = Object.fromEntries(PRIORITY_ORDER.map((p, i) => [p, i])) as Record<FindingSummary["priority"], number>;

// What code found when it checked the citations against the stored lines, in three plain states.
export type EvidenceCheck = "verified" | "approximate" | "not_verified";
export const evidenceCheck = (s: FindingSummary["evidenceStatus"]): EvidenceCheck => (s === "verified" ? "verified" : s === "approximate" ? "approximate" : "not_verified");

export type FindingFilters = { caseId: string; group: string; priority: string; evidence: string; decision: string; q: string };
export const NO_FILTERS: FindingFilters = { caseId: "", group: "", priority: "", evidence: "", decision: "", q: "" };

type Row = Pick<FindingSummary, "group" | "priority" | "evidenceStatus" | "reviewState" | "subject" | "explanation" | "rank"> & {
  a: { ref: string | null }; b: { ref: string | null };
  analysis: { id: number; caseId: number }; title: string;
};

export function filterFindings<T extends Row>(rows: readonly T[], f: FindingFilters): T[] {
  const term = f.q.trim().toLowerCase();
  return rows
    .filter((r) => (!f.caseId || String(r.analysis.caseId) === f.caseId) && (!f.group || r.group === f.group) && (!f.priority || r.priority === f.priority))
    .filter((r) => (!f.evidence || evidenceCheck(r.evidenceStatus) === f.evidence) && (!f.decision || decisionOf(r.reviewState) === f.decision))
    .filter((r) => !term || [r.subject, r.explanation, r.a.ref, r.b.ref, r.title].some((s) => s?.toLowerCase().includes(term)))
    .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || RANK[a.priority] - RANK[b.priority] || b.analysis.id - a.analysis.id || a.rank - b.rank);
}

// A case's findings by review priority. Potential contradictions split by their scored priority; findings
// that need context or failed a citation check have no score and form their own sections; compatible or
// dismissed findings are counted apart, never mixed into "Low".
export type PrioritySection = "high" | "medium" | "low" | "needs_context" | "unverified";
export const SECTION_ORDER: PrioritySection[] = ["high", "medium", "low", "needs_context", "unverified"];
export function prioritySections<T extends Pick<FindingSummary, "group" | "priority" | "rank">>(findings: readonly T[]) {
  const sections = new Map<PrioritySection, T[]>(SECTION_ORDER.map((s) => [s, []]));
  const compatible: T[] = [];
  for (const f of findings) {
    if (f.group === "compatible") compatible.push(f);
    else if (f.group === "contradictions" && (f.priority === "high" || f.priority === "medium" || f.priority === "low")) sections.get(f.priority)!.push(f);
    else sections.get(f.group === "unverified" ? "unverified" : "needs_context")!.push(f);
  }
  for (const list of sections.values()) list.sort((a, b) => a.rank - b.rank);
  return { sections: SECTION_ORDER.map((id) => ({ id, findings: sections.get(id)! })), compatible };
}

export const isFiltered =(f: FindingFilters) => Object.entries(f).some(([k, v]) => (k === "q" ? v.trim() !== "" : v !== ""));
