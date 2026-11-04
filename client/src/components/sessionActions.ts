// Pure helpers for the case page's session rows: which need the lawyer's date, where a session can be
// moved, and how many analyses a move would delete.

import type { AnalysisRow, CaseDetail, DepositionRow } from "../types";

// "missing" when no date is entered, "differs" when it disagrees with the date the transcript states.
export function dateAction(d: Pick<DepositionRow, "takenOn" | "dateFound">): "missing" | "differs" | null {
  if (!d.takenOn) return "missing";
  return d.dateFound && d.dateFound.date !== d.takenOn ? "differs" : null;
}

// The analyses that compared a session: moving it deletes them.
export const analysesOf = (analyses: Pick<AnalysisRow, "depositionA" | "depositionB">[], id: number) => analyses.filter((a) => a.depositionA === id || a.depositionB === id).length;

// The case's other witnesses with sessions (the ones shown on the page), where a session can be filed.
export const moveTargets = (witnesses: CaseDetail["witnesses"], from: number) => witnesses.filter((w) => w.id !== from && w.depositions.length > 0);
