// System prompts of the compact packet contracts (experimental, off by default; read by compactRead.ts). Each is
// packet-v1's prompt with its reading rules, outcomes and field definitions unchanged; only the reply shape changes:
// every pair is screened, and a full packet-v1 verdict is written only for pairs that are not dismissed. Pure, and
// built from the v1 text passed in by packetPrompt.ts (no runtime import back, so no cycle). Changing a wording is a
// new contract id.

import type { CompactContractId } from "./compactRead";

const V1_RETURN = "Return exactly one verdict for every listed pair, with its pairId, and no verdict for any pair that is not listed.";
const V1_FIELDS = "Fields, for each verdict:";

const DISMISS = `Dismiss a pair only when the testimony itself shows that both passages can be true as stated (the false_positive outcome below): its disposition is then the false-positive reason (compatible_approximation, different_event, qualified_statement, uncertain_recollection, not_adopted_by_witness or both_can_be_true). Every other pair gets disposition "verdict": every potential conflict, direct or inferential, and every abstention (insufficient_evidence, needs_more_context, unable_to_assess). When in doubt, write "verdict". A dismissal is never shown to the lawyer, so a wrong dismissal hides a contradiction, while an unneeded verdict costs only a few lines.`;

const ROW: Record<CompactContractId, string> = {
  "packet-c1": "one row for every listed pair, in the listed order: its pairId and its disposition.",
  "packet-c2": `one row for every listed pair, in the listed order: its pairId; compared, at most twelve words naming the two statements you compared, written before you choose; and its disposition.`,
  "packet-c3": `one row for every listed pair, in the listed order: its pairId; quoteA and quoteB, the shortest verbatim words (at most twelve each) from each passage's exchange that your reading rests on, copied exactly (they are checked against the transcript), written before you choose; and its disposition.`,
};

export function compactSystemPrompt(contract: CompactContractId, v1: string): string {
  if (!v1.includes(V1_RETURN) || !v1.includes(V1_FIELDS)) throw new Error("packet-v1's prompt changed: rebuild the compact prompts");
  const reply = `Reply in two parts. First, screen: ${ROW[contract]} ${DISMISS} Then, verdicts: one full verdict, with the fields below, for every pair whose disposition is "verdict", and for no other pair; its outcome may be any of the six.`;
  return v1.replace(V1_RETURN, reply).replace(V1_FIELDS, "Fields, for each full verdict:");
}
