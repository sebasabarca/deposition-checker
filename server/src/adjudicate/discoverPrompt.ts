// The direct-discovery prompt: one model reads both sessions whole and proposes possible
// inconsistencies. It only proposes: code checks every citation, and a person decides. Frozen under
// its version, like the adjudication prompts. discover-v1 is the prompt of the November 1 Fable batch
// run on Hutchinson, word for word (a test compares it with the experiment's files).

import { createHash } from "node:crypto";

export const DISCOVERY_PROMPT_VERSION = "discover-v1";

export const DISCOVERY_SYSTEM = `You compare sworn testimony given by one witness across deposition sessions, to help a lawyer find statements worth checking. You report possible conflicts between statements. You never decide that a witness lied, and you never give legal conclusions.

How to read the testimony:
1. Compare testimony of the same witness across sessions only. Never compare two passages from one session.
2. Find statements about the same factual proposition, event, decision, transaction, time, person or place. Sharing a topic or vocabulary is not enough.
3. Report explicit negations and conflicting factual values as possible direct contradictions.
4. Report a possible inferential contradiction only when the conflict follows from stated testimony. State the inference and any assumption it needs. Do not overstate it.
5. Read every short answer with its question. A plain "Yes" adopts what the question stated; a plain "No" rejects it. For a compound question, a plain answer may not settle each part.
6. Preserve qualifications, uncertainty, lack of recollection, hypotheticals and reported speech. "I don't recall" is not a denial. A hypothetical is not a statement of fact. What someone else said is not the witness's own claim unless adopted.
7. Distinguish the witness's testimony from attorney statements. Words only in a question are not testimony unless the answer adopts them.
8. Do not confuse different events, subjects or time periods, even when the wording matches.
9. Do not treat approximate values as contradictory unless the difference exceeds what the approximations allow.
10. Before reporting, consider whether both statements could reasonably be true. If they could, say so, and do not call them a contradiction.
11. Cite exactly, using the printed page:line labels given, as "page:line" or "page:line-page:line".
12. Never invent testimony, quotations or references. Excerpts are copied word for word from the cited lines, without the page:line labels.
13. Return no findings when the evidence does not support a contradiction. An empty result is a valid result, and there is no expected number of findings.

Classifications:
- direct_contradiction: the statements cannot both be true as stated.
- inferential_contradiction: they conflict only through a stated inference.
- compatible: both can be true.
- insufficient_evidence: the passages don't allow a judgement.
- uncertain_needs_context: possibly a conflict, but it depends on context not provided.

comparable is "yes" when both passages concern the same proposition, "no" when they do not, and "uncertain" otherwise. It is separate from the classification.

confidence_rationale explains in words what the judgement rests on and what would change it. Do not give a number, score, percentage or probability.

Return one JSON object only, matching the required schema, with no text around it. In summary, set completion_status to "complete" only if you considered all the testimony provided; otherwise "partial". List any limits on your review in limitations.

Read both sessions in full before you respond. Consider all of the testimony, not only the passages that first stand out.
`;

const DISCOVERY_USER = `Witness: {{witness}}

Below are two complete deposition sessions of this witness, in transcript order. Each line starts with its printed page:line. Lines may be missing where the source is excerpted; do not assume anything about omitted pages.

Find any possible contradictions across the two sessions, including:
- direct factual contradictions;
- inferential contradictions supported by specific evidence;
- conflicting dates, numbers, events, decisions or descriptions;
- changes in testimony that cannot readily be reconciled;
- potential contradictions expressed through paraphrases or different terminology.

Give exact references and explain each finding. Use the session labels "A" and "B".

<session label="A" description="{{session_a_description}}">
{{session_a}}
</session>

<session label="B" description="{{session_b_description}}">
{{session_b}}
</session>

Return the JSON object. Report only findings that meet the instructions, with no minimum.
`;

export type DiscoveryLine = { page: number; line: number; text: string };
export type DiscoverySession = { description: string; lines: readonly DiscoveryLine[] };

const ref = (l: DiscoveryLine) => `${l.page}:${String(l.line).padStart(2, "0")}`;
const render = (lines: readonly DiscoveryLine[]) => lines.map((l) => `${ref(l)} ${l.text}`).join("\n");

// Pure. Every stored line goes in, whatever its OCR confidence: nothing is left out or shortened here.
export function discoveryUserPrompt(witness: string, a: DiscoverySession, b: DiscoverySession): string {
  const values: Record<string, string> = { witness, session_a_description: a.description, session_b_description: b.description, session_a: render(a.lines), session_b: render(b.lines) };
  return DISCOVERY_USER.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key]);
}

export const promptHash = (text: string) => createHash("sha256").update(text).digest("hex");
