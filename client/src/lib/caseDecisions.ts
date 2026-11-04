// The reviewer's decisions and notes on a stored whole-case analysis's findings. Those findings have no
// database rows (they are a hand-authored example, data/demoCaseAnalysis.ts), so the decisions are kept in
// this browser's local storage, by case and finding.
// shortcut: browser-only, not shared or on the server; move to a reviewed-findings table when whole-case
// runs (case_runs) store their findings.

import { useCallback, useState } from "react";
import type { ReviewDecision } from "../types";

export type CaseDecision = { decision: ReviewDecision; note: string; at: string };
export type CaseDecisions = Record<string, CaseDecision>;

export const storageKey = (caseId: number) => `veridict:case-analysis:${caseId}:decisions`;

// A stored value, kept only where it has the expected shape.
export function parseDecisions(raw: string | null): CaseDecisions {
  try {
    const value = JSON.parse(raw ?? "{}") as Record<string, Partial<CaseDecision>>;
    return Object.fromEntries(Object.entries(value).filter(([, d]) => (d.decision === "confirmed" || d.decision === "needs_context" || d.decision === "dismissed") && typeof d.note === "string" && typeof d.at === "string")) as CaseDecisions;
  } catch {
    return {};
  }
}

// Sets a finding's decision and note, or clears it (decision null).
export function withDecision(all: CaseDecisions, findingId: string, decision: ReviewDecision | null, note: string, at: string): CaseDecisions {
  const next = { ...all };
  if (decision === null) delete next[findingId];
  else next[findingId] = { decision, note, at };
  return next;
}

export function useCaseDecisions(caseId: number) {
  const [all, setAll] = useState<CaseDecisions>(() => {
    try { return parseDecisions(window.localStorage.getItem(storageKey(caseId))); } catch { return {}; }
  });
  const decide = useCallback((findingId: string, decision: ReviewDecision | null, note: string) => {
    setAll((prev) => {
      const next = withDecision(prev, findingId, decision, note, new Date().toISOString());
      try { window.localStorage.setItem(storageKey(caseId), JSON.stringify(next)); } catch { /* private window: kept for this visit only */ }
      return next;
    });
  }, [caseId]);
  return { decisions: all, decide };
}
