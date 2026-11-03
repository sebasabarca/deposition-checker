// Stage 2 contracts: what the extraction model returns, and what a checked fact is. Pure: no I/O.
//
// The central rule: what a statement is about (the attribute and the answer-independent factual question)
// is kept apart from what the witness claims (the value and the polarity), so two descriptions of the
// same thing in different words stay comparable while their values stay as said. The attribute is
// free text the model writes; code derives a lookup key from it, which is a hint, never a canonical
// retrieval key. Extraction never decides that two facts describe the same event or contradict each
// other: events are provisional descriptions with their anchors, never IDs.

import { z } from "zod";
import { V2_MODELS } from "../../costs/models";

// Bump FACTS_PROMPT_VERSION whenever the prompt changes, and FACT_SCHEMA_VERSION whenever the output
// schema or code's checks change: facts are stored per extractor version, so a change re-extracts
// rather than mixing readings.
// facts-v2: examples no longer drawn from the evaluation passages (v1 named their values and dimensions).
// facts-v3: facts grouped by unit position (no model-written unit IDs), action, attribute and memory facts,
// value phrases with their own source spans, citable context. Baseline: the first pilot ran facts-v2.
// facts-v4: one required key per unit (u1..uN) echoing the unit's opening words, at most 8 units per request;
// compound questions, reported speech and named people in questions. Baseline pilots ran facts-v2 and facts-v3.
export const FACTS_PROMPT_VERSION = "facts-v4";
export const FACT_SCHEMA_VERSION = "fact-schema-v3";
export const FACTS_MODEL = V2_MODELS.fact_extraction;
export const FACT_EXTRACTOR_VERSION = `${FACTS_PROMPT_VERSION}+${FACT_SCHEMA_VERSION}+${FACTS_MODEL}`;

export const POLARITIES = ["positive", "negative", "unknown"] as const;
export const EPISTEMIC_STATUSES = ["asserted", "qualified", "does_not_recall", "does_not_know", "reported_by_other", "hypothetical", "unclear"] as const;
// action: whether something happened or holds (its value is the polarity). attribute: what value a property
// had (a place, vehicle, person, time, amount, manner), whatever form the testimony took. memory_or_knowledge:
// the witness's testimony about their own memory or knowledge of a fact, never a denial of it.
export const FACT_KINDS = ["action", "attribute", "memory_or_knowledge"] as const;
export const NO_FACT_REASONS = ["procedural", "no_answer", "nonresponsive"] as const;
export type Polarity = (typeof POLARITIES)[number];
export type EpistemicStatus = (typeof EPISTEMIC_STATUSES)[number];
export type FactKind = (typeof FACT_KINDS)[number];

export const ATTRIBUTION_STATUSES = ["verified", "uncertain", "invalid"] as const;
export const SOURCE_VERIFICATIONS = ["verified", "approximate", "unsupported", "invalid_reference"] as const;
export type AttributionStatus = (typeof ATTRIBUTION_STATUSES)[number];
export type SourceVerification = (typeof SOURCE_VERIFICATIONS)[number];
// Whether code's checks cover the reading: source_supported when the value is the cited words themselves;
// otherwise needs_semantic_review. Never "verified": code checks quotations, not interpretation.
export type SemanticStatus = "source_supported" | "needs_semantic_review";
export type ValueSupport = "verified" | "approximate" | "not_applicable";
// witness_statement: the phrase is the witness's own words. question_adopted: the phrase is the
// question's, adopted or rejected by the witness's short answer, which is cited with it.
export type Provenance = "witness_statement" | "question_adopted";

const Text = z.string().trim().min(1);
const Maybe = z.string().nullable();
const Position = z.number().int(); // 1-based; code checks the range against the request

// The provisional event a fact refers to, as the testimony describes it. Nulls where it doesn't say.
export const ProvisionalEvent = z.strictObject({
  description: Maybe,
  eventType: Maybe,
  anchors: z.array(Text), // short phrases from the testimony that tie the fact to its occasion
  participants: z.array(Text),
  date: Maybe,
  location: Maybe,
});
export type ProvisionalEvent = z.infer<typeof ProvisionalEvent>;

export const ModelFact = z.strictObject({
  kind: z.enum(FACT_KINDS),
  spans: z.array(Position).min(1), // the unit's own spans (S<n>) holding the assertion
  contextSpans: z.array(Position), // context lines (C<n>) the reading depends on, if any
  evidencePhrase: Text, // words copied exactly from the cited unit spans
  subject: Text,
  entities: z.array(Text), // people, places, things named in the cited words or context
  predicate: Text, // the action or relation
  attribute: Maybe, // the property described, without its value ("vehicle the person rode in"); null for an action
  value: Maybe, // the asserted value as said ("dock four"); null for an action or memory fact
  valuePhrase: Maybe, // the words of the cited spans or context that state the value
  factualQuestion: Text, // answer-independent: any witness's answer to it could be compared
  polarity: z.enum(POLARITIES),
  epistemicStatus: z.enum(EPISTEMIC_STATUSES),
  reportedSpeaker: Maybe,
  hedges: z.array(Text),
  correction: z.boolean(), // the witness corrects or revises earlier testimony here
  timeScope: Maybe,
  locationScope: Maybe,
  event: ProvisionalEvent,
});
export type ModelFact = z.infer<typeof ModelFact>;

// One group per input unit, under a required key per position: u1 for [U1], u2 for [U2], ... The request's
// schema lists exactly the batch's keys, so the decoder can't skip, add or renumber a group; each group
// also copies its unit's opening words, which code compares with the unit, so a group written for one
// unit can never be stored on another. MAX_UNITS_PER_BATCH bounds the schema.
export const MAX_UNITS_PER_BATCH = 8;
export const UnitGroup = z.strictObject({ opening: z.string(), facts: z.array(z.unknown()), noFactsReason: z.enum(NO_FACT_REASONS).nullable() });
export type UnitGroup = z.infer<typeof UnitGroup>;
export const unitKeyLabel = (position: number) => `u${position}`;
const strip = (schema: unknown) => JSON.parse(JSON.stringify(schema, (key, value) => (key === "minLength" || key === "minItems" || key === "maximum" || key === "minimum" || key === "$schema" ? undefined : value))) as Record<string, unknown>;
const GROUP_SCHEMA = strip(z.toJSONSchema(z.strictObject({ opening: z.string(), facts: z.array(ModelFact), noFactsReason: z.enum(NO_FACT_REASONS).nullable() })));
// The structured-output schema for a batch of n units. Structured outputs reject length constraints;
// ModelFact still enforces them on every fact read.
export function factsJsonSchema(n: number): Record<string, unknown> {
  if (n < 1 || n > MAX_UNITS_PER_BATCH) throw new Error(`a batch holds 1 to ${MAX_UNITS_PER_BATCH} units, not ${n}`);
  const keys = Array.from({ length: n }, (_, i) => unitKeyLabel(i + 1));
  return { type: "object", properties: Object.fromEntries(keys.map((k) => [k, GROUP_SCHEMA])), required: keys, additionalProperties: false };
}
export const FACTS_JSON_SCHEMA = factsJsonSchema(1); // the one-unit schema, for the default client

const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";
const TIME_WORD = new RegExp(`^(?:\\d+(?:st|nd|rd|th)?|${MONTHS}|morning|afternoon|evening|night|today|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$`);

// A lookup key from the attribute (or, for an action or memory fact, its predicate): lowercase snake_case
// with dates and times removed, which belong in timeScope. A hint for grouping, never a canonical key.
export function attributeKey(f: { kind: FactKind; attribute: string | null; predicate: string }) {
  const source = f.kind === "attribute" && f.attribute ? f.attribute : f.predicate;
  return source.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !TIME_WORD.test(w)).join("_");
}
export const timeWordsIn = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && TIME_WORD.test(w));

// Kept for the Stage 2 v1 checks and their tests.
export const normalizeDimension = (d: string) => d.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

// Too broad to bring comparable facts together: flagged for review, not rejected.
export const GENERIC_DIMENSIONS = new Set(["location", "place", "time", "date", "person", "people", "thing", "event", "action", "fact", "statement", "other", "detail", "information", "status", "value", "type"]);

// Function words and question words: never a value's distinguishing word ("what happened in …").
const WORDS_TO_IGNORE = new Set(["the", "a", "an", "of", "and", "or", "to", "in", "on", "at", "by", "for", "from", "with", "was", "were", "is", "are", "his", "her", "their", "its", "that", "this", "what", "which", "where", "when", "who", "whom", "whose", "how", "why", "did", "does", "had", "has", "have", "about", "after", "before", "there"]);
export const contentTokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !WORDS_TO_IGNORE.has(w));

// The value's distinguishing words that appear in the attribute or the factual question: the answer leaking
// into what should be answer-independent. A word the attribute and the question both use is the category
// asked about ("dock" in "From which dock did the shipment leave?" for "dock four"), not a leak.
export function valueLeaks(attribute: string | null, question: string, value: string | null): { attribute: string[]; question: string[] } {
  if (!value) return { attribute: [], question: [] };
  const a = new Set(contentTokens(attribute ?? ""));
  const q = new Set(contentTokens(question));
  const distinguishing = [...new Set(contentTokens(value))].filter((w) => !(a.has(w) && q.has(w)));
  return { attribute: distinguishing.filter((w) => a.has(w)), question: distinguishing.filter((w) => q.has(w)) };
}
export const valueWordsIn = (text: string, value: string | null) => valueLeaks(text, "", value).attribute;

// Kept for the v1 rule: the value's words in a dimension, unless the question uses them too.
export function valueWordsInDimension(dimension: string, object: string | null, question: string): string[] {
  if (!object) return [];
  const asked = new Set(contentTokens(question));
  const dim = new Set(normalizeDimension(dimension).split("_"));
  return [...new Set(contentTokens(object))].filter((w) => !asked.has(w) && dim.has(w));
}

// A yes/no question that names a particular place, opening, vehicle or other value ("Did the dog run out of
// the gate?") hides an attribute inside an action. Deterministic and approximate: it only flags for review.
const NAMED_VALUE = /\b(?:out of|through|into|inside|outside|in|at|on|onto|to|toward|towards|from|by|with|via|near|behind|under|over|across|along|past|beside|up|down)\s+(?:the|a|an|his|her|their|my|your|that|this)\s+[a-z][a-z-]+/i;
export const isYesNoQuestion = (q: string) => /^(?:did|was|were|is|are|does|do|has|had|have|could|would|will|can)\b/i.test(q.trim());
export const yesNoNamesValue = (q: string) => isYesNoQuestion(q) && NAMED_VALUE.test(q);
