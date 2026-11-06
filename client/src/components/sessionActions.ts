// Pure helpers for the case page's session rows: which need the lawyer's date, where a session can be
// moved.

import type { CaseDetail, DepositionRow } from "../types";

// "missing" when no date is entered, "differs" when it disagrees with the date the transcript states and the
// person hasn't kept it (a date they saved or kept is confirmed, and not raised again).
export function dateAction(d: Pick<DepositionRow, "takenOn" | "dateFound" | "dateConfirmed">): "missing" | "differs" | null {
  if (!d.takenOn) return "missing";
  return d.dateFound && d.dateFound.date !== d.takenOn && d.dateConfirmed !== d.takenOn ? "differs" : null;
}

// The case's other witnesses with sessions (the ones shown on the page), where a session can be filed.
export const moveTargets = (witnesses: CaseDetail["witnesses"], from: number) => witnesses.filter((w) => w.id !== from && w.depositions.length > 0);
