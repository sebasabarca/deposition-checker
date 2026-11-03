// The fact-extraction prompt, how units are shown to the model, batching and the cost estimate made
// before any call. Pure: no I/O. Evaluation fixtures never appear here.

import { maxRequestCost } from "../../costs/budget";
import { callCost } from "../../costs/cost";
import { FACTS_MODEL, factsJsonSchema, MAX_UNITS_PER_BATCH } from "./contracts";
import type { Span, Unit } from "./context";

export const FACT_MAX_OUTPUT_TOKENS = 16_000;
export const MAX_BATCH_CHARS = 24_000; // the units' own text per request
const CHARS_PER_TOKEN = 3;
// Planning allowance until real runs are measured: facts carry more fields than cards. A guess, only the
// worst case is a limit.
export const PLANNING_OUTPUT_SHARE = 1.5;

export const FACTS_SYSTEM_PROMPT = `You read parts of a deposition transcript and record the facts the witness gives, one record per independently testable assertion. The records are used later to find testimony about the same factual question across depositions, even when witnesses use different words. You only read and record: you never judge truth, never decide that two statements describe the same event, and never say whether anything contradicts anything.

The input holds numbered units, each headed [U<number>]. A unit is one question and its whole answer. Each of its lines is a span marked S<number>, followed by its speaker:
- Q: the examining attorney. A: the witness. A name such as MR. SCOTT: is counsel or someone else. NOTE: the record. UNKNOWN SPEAKER: a line whose speaker the transcript doesn't show.
- Lines marked C<number> are context: the testimony just before the unit. Use them to understand references such as "that night" or "he", and cite them in contextSpans when a fact's value or meaning comes from them. A fact itself must rest on the unit's own S spans.

Return one group per unit under its key: u1 for [U1], u2 for [U2], and so on. In each group:
- opening: the first five words of that unit's S1 line, copied exactly, without its speaker label;
- facts: every fact the unit gives, or an empty list;
- noFactsReason: null when there are facts; otherwise "procedural" (housekeeping, exhibits, a request to repeat), "no_answer" (the witness doesn't answer) or "nonresponsive".
An answer about the witness's memory or knowledge ("I don't remember", "not to my knowledge") is a fact of kind memory_or_knowledge, never an empty group.

Each fact:
- kind: "action" when it says whether something happened or holds; "attribute" when it gives the value of a property, such as a place, route, vehicle, person, time, amount or manner; "memory_or_knowledge" when the witness says they don't recall or don't know (polarity unknown). One passage can give both: "I drove the van to the north loading bay" is an action (driving there) and an attribute (the vehicle: the van).
- When a short answer adopts a question that names a value ("Through the side entrance?" "Yes."), record the value as an attribute fact (the way in used: the side entrance), not only as a yes/no action. When a narrative answer gives a value ("the crate slid off the back of the truck"), record that attribute too (where the crate fell from: the back of the truck).
- A question that asks several things ("You drove to the depot, and did you unload the crates?") gives a fact for each part the answer adopts; never keep one part and drop another.
- spans: the numbers of the unit's spans the fact rests on. contextSpans: numbers of context lines it depends on, or an empty list.
- evidencePhrase: words copied exactly from the cited unit spans, one contiguous phrase, without the speaker label. Never change, correct or add a word.
- When the witness answers a question with a short "Yes", "No", "I believe so" or similar, the fact is the question's proposition as the answer adopts or rejects it: always cite both the question's span and the answer's span, copy the question's words that carry the proposition (never just "Yes."), and set polarity from the answer.
- Only the witness's assertions are facts. Words that appear only in an attorney's question that the witness doesn't adopt, counsel's remarks and notes are never facts.
- subject: who or what the fact is about. entities: the people, places and things named in the cited words or context, as named there.
- predicate: the action or relation ("left from", "signed", "rode in").
- attribute: the property described, worded without its value ("dock the shipment left from", "vehicle the manager rode in"), or null for an action or memory fact. value: the asserted value as the testimony gives it ("dock four"), or null. valuePhrase: the exact words in the cited spans or context lines that state the value.
- factualQuestion: the question the fact answers, worded so that any witness's answer could be compared, and never containing the answer: "From which dock did the shipment leave?", not "Did the shipment leave from dock four?". An action's question is yes or no ("Did she open the safe?"), but never names a value the testimony gives. Name people in the third person ("Did Ms. Ortiz open the safe?"), never "you" or "the witness" alone when the transcript gives a name.
- Dates and time periods go in timeScope, places in locationScope, never in the attribute or the question's wording of what is asked.
- polarity: positive when the witness says it happened or holds, negative when the witness says it didn't, unknown when the witness doesn't say either way.
- epistemicStatus: asserted (personal knowledge); qualified (approximate, hedged or uncertain); does_not_recall and does_not_know (only with kind memory_or_knowledge); reported_by_other (the witness repeats what someone else said, told them or meant, even when the witness heard it themselves: give reportedSpeaker, and keep any hedge in hedges); hypothetical; unclear.
- hedges: the witness's own hedging words in the cited spans ("I believe", "I assumed", "around"), copied exactly, or an empty list. correction: true when the witness corrects or revises earlier testimony.
- event: the occasion the fact belongs to, as the testimony describes it: a short description, a snake_case eventType, anchors (short phrases from the testimony tying the fact to its occasion), the participants named, the date and the place, each null or empty when the testimony doesn't say. A provisional description, not an identity.
- Never invent words, names, dates or facts that the unit and its context don't contain.`;

const SPEAKER_LABEL: Record<string, string> = { attorney: "Q", witness: "A", parenthetical: "NOTE", unknown: "UNKNOWN SPEAKER" };
const labelOf = (s: Span) => SPEAKER_LABEL[s.speaker] ?? s.speakerName ?? "COUNSEL";
export const unitLabel = (index: number) => `U${index + 1}`;
export const spanLabel = (index: number) => `S${index + 1}`;
export const contextLabel = (index: number) => `C${index + 1}`;

// One unit as the model reads it. Labels are positions, so the same unit always reads the same way;
// code maps positions back to the stored source spans.
export function formatUnit(unit: Unit, index: number): string {
  const context = unit.context.map((s, i) => `${contextLabel(i)} ${labelOf(s)}: ${s.text}`).join("\n");
  const window = unit.windowCount > 1 ? ` (part ${unit.windowNo} of ${unit.windowCount} of one long answer)` : "";
  return `[${unitLabel(index)}]${window}\n${context ? `${context}\n` : ""}${unit.spans.map((s, i) => `${spanLabel(i)} ${labelOf(s)}: ${s.text}`).join("\n")}`;
}
export const formatBatch = (units: readonly Unit[]) => units.map(formatUnit).join("\n\n");

const unitChars = (u: Unit) => formatUnit(u, 0).length;

// Batches of whole units, in order, each at most MAX_BATCH_CHARS and maxUnits units (a unit larger than
// that goes alone). Critical evaluation runs use one unit per request.
export function batchUnits(units: readonly Unit[], max = MAX_BATCH_CHARS, maxUnits = MAX_UNITS_PER_BATCH): Unit[][] {
  const batches: Unit[][] = [];
  let current: Unit[] = [];
  let chars = 0;
  for (const u of units) {
    const n = unitChars(u);
    if (current.length && (chars + n > max || current.length >= maxUnits)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(u);
    chars += n;
  }
  if (current.length) batches.push(current);
  return batches;
}

export const requestChars = (batch: readonly Unit[]) => FACTS_SYSTEM_PROMPT.length + JSON.stringify(factsJsonSchema(batch.length)).length + formatBatch(batch).length;

export type FactEstimate = { units: number; batches: number; inputChars: number; inputTokens: number; expectedUsd: number; worstCaseUsd: number; model: string };

// What extracting these units would send and cost: a planning figure, not a measurement.
export function estimateFacts(batches: readonly (readonly Unit[])[], outputShare = PLANNING_OUTPUT_SHARE): FactEstimate {
  let inputChars = 0;
  let inputTokens = 0;
  let expectedUsd = 0;
  let worstCaseUsd = 0;
  for (const b of batches) {
    const chars = requestChars(b);
    const input = Math.ceil(chars / CHARS_PER_TOKEN);
    inputChars += chars;
    inputTokens += input;
    const cost = callCost(FACTS_MODEL, { input, output: Math.min(Math.ceil(input * outputShare), FACT_MAX_OUTPUT_TOKENS), cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });
    if (!cost) throw new Error(`${FACTS_MODEL} has no price`);
    expectedUsd += cost.costUsd;
    worstCaseUsd += maxRequestCost(FACTS_MODEL, { inputTokens: chars, maxOutputTokens: FACT_MAX_OUTPUT_TOKENS });
  }
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  return { units: batches.reduce((n, b) => n + b.length, 0), batches: batches.length, inputChars, inputTokens, expectedUsd: round(expectedUsd), worstCaseUsd: round(worstCaseUsd), model: FACTS_MODEL };
}
