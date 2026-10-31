// The epistemic wording and exchange labels the card prompt uses. Pure: no I/O.

import { EPISTEMIC } from "./vocabulary";

export const EPISTEMIC_MEANINGS: Record<(typeof EPISTEMIC)[number], string> = {
  asserted: "the witness states it as fact",
  qualified: "the witness hedges or limits it (I think, I believe, I'm not sure, I don't know that for a fact, probably, in a narrow sense)",
  does_not_know: "the witness says they don't know (never knew), which is not a denial",
  does_not_recall: "the witness says they don't remember or don't recall, which is not a denial",
  hypothetical: "a supposition (if, would have, assuming), not a statement of what happened",
  reported_by_other: "the witness repeats what someone else said or believes",
};

export type BatchPart = { id: number; dialogueText: string };

export const exchangeLabel = (id: number) => `E${id}`;

export function formatBatch(parts: readonly BatchPart[]): string {
  return parts.map((p) => `[${exchangeLabel(p.id)}]\n${p.dialogueText}`).join("\n\n");
}
