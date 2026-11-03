// Code's checks of every fact the model proposes. Pure: no I/O, no model. These are deterministic
// checks of positions, quotations and attribution, kept apart from the model's interpretation: a fact
// whose words are found verbatim may still be read wrongly, so no fact is ever called semantically
// verified. A fact is source_supported only when its value is the cited words themselves and nothing
// else needs a reader; otherwise it is needs_semantic_review, with the reasons. Only indexed facts are
// in the verified index; every other fact is kept, rejected, with its reason.
//
// Units are matched by key and checked by content: the response holds one group per input unit under its
// key (u1, u2, ...), and each group copies its unit's opening words. A missing, repeated or unexpected key,
// or an opening that isn't its unit's, never moves a fact to another unit: that unit fails instead.

import { createHash } from "node:crypto";
import { APPROXIMATE, isBareAnswer, locate, matchScore, normalize, readAnswer, readRecollection, spoken as spokenLine, VERIFIED } from "../../verify";
import { screenNoAssertion } from "../cards";
import { groundEntities } from "../verify";
import { attributeKey, FACT_EXTRACTOR_VERSION, GENERIC_DIMENSIONS, ModelFact, timeWordsIn, UnitGroup, valueLeaks, yesNoNamesValue, type AttributionStatus, type FactKind, type ProvisionalEvent, type Provenance, type SemanticStatus, type SourceVerification, type ValueSupport } from "./contracts";
import type { Span, Unit } from "./context";

export type CheckedFact = {
  factKey: string;
  unitKey: string;
  depositionId: number;
  caseId: number;
  witnessId: number;
  fact: ModelFact | null; // null when it failed the schema
  kind: FactKind | null;
  dimension: string | null; // the attribute key: a lookup hint, never canonical
  spans: Span[];
  contextSpans: Span[];
  provenance: Provenance | null;
  attributionStatus: AttributionStatus;
  sourceVerification: SourceVerification;
  valueSupport: ValueSupport;
  semanticStatus: SemanticStatus;
  reviewReasons: string[];
  status: "indexed" | "rejected";
  rejectionReason: string | null;
  warnings: string[];
  hedges: string[]; // those found in the cited spans
  event: (ProvisionalEvent & { ungroundedParticipants: string[] }) | null;
  sourceHash: string;
  raw: unknown;
};

export type UnitStatusOut = "extracted" | "empty" | "suspected_omission" | "omitted" | "failed";
export type UnitOutcome = { unitKey: string; status: UnitStatusOut; facts: number; rejected: number; duplicates: number; error: string | null };
export type FactReading = { unusable: string | null; facts: CheckedFact[]; outcomes: UnitOutcome[]; diagnostics: { unexpectedPositions: number[]; malformedGroups: number; repeatedPositions: number[]; openingMismatches: number[] } };
export type ModelReply = { stopReason: string | null; text: string | null };

// A span's spoken words: also without an archive's "Q:"/"A:" label, which the shared helper leaves.
const spoken = (text: string) => spokenLine(text.replace(/^\s*[QA]:\s*/, ""));
const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);
const WORST: Record<AttributionStatus, number> = { verified: 0, uncertain: 1, invalid: 2 };
const worst = (...xs: AttributionStatus[]) => xs.reduce((a, b) => (WORST[b] > WORST[a] ? b : a), "verified" as AttributionStatus);
const score = (phrase: string, text: string): "verified" | "approximate" | null => {
  const s = matchScore(phrase, text);
  return s >= VERIFIED ? "verified" : s >= APPROXIMATE ? "approximate" : null;
};

// Stable across retries and across the overlapping windows of one answer group: the same reading of the
// same testimony gets the same key, so it is stored once.
export const factKeyOf = (u: Unit, f: ModelFact, key: string) =>
  `fact_${hash([FACT_EXTRACTOR_VERSION, u.depositionId, u.groupId, f.kind, key, normalize(f.value ?? ""), normalize(f.evidencePhrase), f.polarity, f.epistemicStatus].join("|"))}`;

// Who said the words a phrase sits on, and on what basis the fact is the witness's.
function attribute(f: ModelFact, cited: Span[], holders: Span[]): { provenance: Provenance | null; status: AttributionStatus; reason: string | null; review: string | null } {
  const speakers = new Set(holders.map((s) => s.speaker));
  if (speakers.has("colloquy") || speakers.has("parenthetical")) return { provenance: null, status: "invalid", reason: "not_witness_speech", review: null };
  if (speakers.has("attorney") && (speakers.has("witness") || speakers.has("unknown"))) return { provenance: null, status: "invalid", reason: "phrase_joins_speakers", review: null };
  if (!speakers.has("attorney")) return { provenance: "witness_statement", status: speakers.has("unknown") ? "uncertain" : "verified", reason: null, review: null };
  const answers = cited.filter((s) => s.speaker === "witness" || s.speaker === "unknown");
  if (answers.length === 0) return { provenance: null, status: "invalid", reason: "attorney_assertion", review: null };
  const question = holders.map((s) => spoken(s.text)).join(" ");
  const answer = answers.map((s) => spoken(s.text)).join(" ");
  const reading = readAnswer(question, answer);
  const unknownSpeaker = answers.some((s) => s.speaker === "unknown");
  if (reading === "uncertain") {
    if (!isBareAnswer(answer) && answer.split(/\s+/).length > 8) return { provenance: null, status: "invalid", reason: "attorney_assertion", review: null };
    return { provenance: "question_adopted", status: "uncertain", reason: null, review: "adopted_answer_not_plain_yes_or_no" };
  }
  const expected = reading === "affirms" ? "positive" : "negative";
  // "Do you recall …?" "No." is a non-recollection with polarity unknown, not a contradiction of the answer.
  if (f.polarity !== "unknown" && f.polarity !== expected) return { provenance: "question_adopted", status: "invalid", reason: `polarity_contradicts_answer: the answer ${reading} the question`, review: null };
  return { provenance: "question_adopted", status: unknownSpeaker ? "uncertain" : "verified", reason: null, review: null };
}

// One proposed fact against the unit it was returned for.
export function checkFact(unit: Unit, raw: unknown, ordinal: number): CheckedFact {
  const base = { unitKey: unit.unitKey, depositionId: unit.depositionId, caseId: unit.caseId, witnessId: unit.witnessId, sourceHash: unit.sourceHash, raw };
  const reject = (reason: string, sourceVerification: SourceVerification, more: Partial<CheckedFact> = {}): CheckedFact => ({
    ...base, factKey: `fact_rejected_${hash(`${FACT_EXTRACTOR_VERSION}|${base.unitKey}|${ordinal}|${JSON.stringify(raw)}`)}`, fact: null, kind: null, dimension: null, spans: [], contextSpans: [], provenance: null, attributionStatus: "invalid",
    sourceVerification, valueSupport: "not_applicable", semanticStatus: "needs_semantic_review", reviewReasons: [], status: "rejected", rejectionReason: reason, warnings: [], hedges: [], event: null, ...more,
  });
  const parsed = ModelFact.safeParse(raw);
  if (!parsed.success) return reject(`invalid_fields: ${parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ")}`.slice(0, 500), "unsupported");
  const f = parsed.data;
  if (f.spans.some((n) => n < 1 || n > unit.spans.length)) return reject("unknown_span", "invalid_reference", { fact: f, kind: f.kind });
  if (f.contextSpans.some((n) => n < 1 || n > unit.context.length)) return reject("unknown_context_span", "invalid_reference", { fact: f, kind: f.kind });
  const cited = [...new Set(f.spans)].sort((a, b) => a - b).map((n) => unit.spans[n - 1]);
  const context = [...new Set(f.contextSpans)].sort((a, b) => a - b).map((n) => unit.context[n - 1]);
  const dimension = attributeKey(f);
  const partial = { fact: f, kind: f.kind, dimension, spans: cited, contextSpans: context };
  const review: string[] = [];

  // The assertion: in the unit's own cited spans.
  const citedText = cited.map((s) => spoken(s.text)).join(" ");
  const assertion = score(f.evidencePhrase, citedText);
  if (!assertion) return reject("phrase_not_in_cited_spans", "unsupported", partial);
  if (assertion === "approximate") review.push("evidence_phrase_approximate");
  const at = locate(f.evidencePhrase, cited.map((s, i) => ({ id: i, text: spoken(s.text) })));
  const holders = (at.length ? at : cited.map((_, i) => i)).map((i) => cited[i]);
  // A bare "Yes." or "I believe so." says nothing alone: its proposition is the question's, which must be cited.
  const bare = isBareAnswer(f.evidencePhrase) || /^(?:i (?:believe|think|guess) so|i'?m not sure|not that i recall)\.?$/i.test(f.evidencePhrase.trim());
  if (bare && !cited.some((s) => s.speaker === "attorney")) return reject("bare_answer_without_question", assertion, partial);
  if (bare) review.push("proposition_from_question_not_quoted");

  // Attribution: whose words, and how reliably the transcript says so (Stage 1's status of the exchange).
  const who = attribute(f, cited, holders);
  const stage1 = cited.map((s): AttributionStatus => s.exchangeStatus ?? "uncertain");
  const attributionStatus = worst(who.status, ...stage1);
  if (who.reason) return reject(who.reason, assertion, { ...partial, provenance: who.provenance });
  if (stage1.includes("invalid")) return reject("exchange_attribution_invalid", assertion, { ...partial, provenance: who.provenance });
  if (who.review) review.push(who.review);

  // Memory and knowledge are their own kind of testimony, never a denial.
  const memoryStatus = f.epistemicStatus === "does_not_recall" || f.epistemicStatus === "does_not_know";
  if (memoryStatus !== (f.kind === "memory_or_knowledge")) return reject("memory_kind_mismatch", assertion, partial);
  if (memoryStatus && f.polarity !== "unknown") return reject("non_recollection_given_polarity", assertion, partial);
  if (f.epistemicStatus === "reported_by_other" && !f.reportedSpeaker?.trim()) return reject("reported_speaker_missing", assertion, partial);

  // The value: every material part needs source support.
  let valueSupport: ValueSupport = "not_applicable";
  if (f.kind === "attribute") {
    if (!f.attribute?.trim() || !f.value?.trim() || !f.valuePhrase?.trim()) return reject("attribute_without_value", assertion, partial);
    const support = score(f.valuePhrase, [...cited, ...context].map((s) => spoken(s.text)).join(" "));
    if (!support) return reject("value_not_in_cited_spans", assertion, partial);
    valueSupport = support;
    if (support === "approximate") review.push("value_phrase_approximate");
    // A value that isn't the cited words themselves is the model's normalization: a reader must check it.
    if (!normalize(f.valuePhrase).includes(normalize(f.value))) review.push("value_normalized");
    const leaks = valueLeaks(f.attribute, f.factualQuestion, f.value).attribute;
    if (leaks.length) return reject(`attribute_contains_value: ${leaks.join(", ")}`, assertion, partial);
    if (timeWordsIn(f.attribute).length) review.push("time_in_attribute");
    if (GENERIC_DIMENSIONS.has(dimension)) review.push("generic_attribute");
  } else if (f.value) review.push("value_on_non_attribute_fact");
  // The value in the question is a reading to check (it may be the question's frame), not a rejection.
  if (valueLeaks(f.attribute, f.factualQuestion, f.value).question.length) review.push("question_contains_value");
  if (f.kind === "action" && yesNoNamesValue(f.factualQuestion)) review.push("yes_no_question_names_value");
  if (/\byou(?:r)?\b/i.test(f.factualQuestion)) review.push("question_not_in_third_person");
  // Words of reporting in the cited words, read as the witness's own assertion: whose statement is it?
  if (f.epistemicStatus !== "reported_by_other" && /\b(?:said|says|told|tells|telling|according to|retold|relayed|mentioned)\b/i.test(citedText)) review.push("possible_reported_speech");
  if (!dimension) return reject("empty_attribute_key", assertion, partial);

  const warnings: string[] = [];
  const said = normalize(citedText);
  const hedges = f.hedges.filter((h) => said.includes(normalize(h)));
  if (hedges.length < f.hedges.length) warnings.push("ungrounded_hedge");
  const unitText = [...unit.context, ...unit.spans].map((s) => s.text).join(" ");
  const participants = groundEntities(f.event.participants, unitText);
  if (participants.ungrounded.length) warnings.push("ungrounded_participant");
  if (groundEntities(f.entities, unitText).ungrounded.length) warnings.push("ungrounded_entity");
  if (f.reportedSpeaker && groundEntities([f.reportedSpeaker], unitText).ungrounded.length) review.push("reported_speaker_not_named_in_testimony");
  if (!f.event.description && !f.event.date && !f.event.location) warnings.push("event_context_missing");

  return {
    ...base, ...partial, factKey: factKeyOf(unit, f, dimension), provenance: who.provenance, attributionStatus, sourceVerification: assertion, valueSupport,
    semanticStatus: review.length ? "needs_semantic_review" : "source_supported", reviewReasons: review,
    status: "indexed", rejectionReason: null, warnings, hedges, event: { ...f.event, participants: participants.entities, ungroundedParticipants: participants.ungrounded },
  };
}

// Whether a group's copied opening words are its unit's: the first words of S1 (speaker label aside),
// compared after normalization, at least three of them or all S1 has. Pure.
export function openingMatches(opening: string, unit: Unit): boolean {
  const want = normalize(spoken(unit.spans[0]?.text ?? "")).split(" ").filter(Boolean);
  const got = normalize(spoken(opening)).split(" ").filter(Boolean);
  const n = Math.min(3, want.length);
  return n > 0 && got.length >= n && got.slice(0, n).join(" ") === want.slice(0, n).join(" ");
}

// Why an empty group looks wrong, from the unit's own words: an answer about memory or knowledge, or
// an answer with substance. It only doubts the extraction; nothing is decided about the testimony.
const MEMORY = /\b(?:recollection|recall|remember|recollect|don't know|do not know|not to my knowledge)\b/i;
export function emptySignals(unit: Unit): string[] {
  const text = (role: string) => unit.spans.filter((s) => s.role === role).map((s) => spoken(s.text)).join(" ");
  const answer = text("answer");
  const signals = screenNoAssertion(text("question"), answer);
  if (MEMORY.test(answer) || readRecollection(answer)) signals.push("memory_or_knowledge_answer");
  return [...new Set(signals)];
}

// Reads one batch's response. One bad fact never costs the good ones; a response that can't be read fails
// every unit in the batch, which stays retryable and is never read as "no facts". `seen` carries the keys
// already stored, so a fact found again (a retry, an overlapping window) is counted, not duplicated.
export function readFacts(units: readonly Unit[], reply: ModelReply | null, seen: Set<string> = new Set()): FactReading {
  const none = { unexpectedPositions: [], malformedGroups: 0, repeatedPositions: [], openingMismatches: [] };
  const failAll = (reason: string): FactReading => ({ unusable: reason, facts: [], diagnostics: none, outcomes: units.map((u) => ({ unitKey: u.unitKey, status: "failed", facts: 0, rejected: 0, duplicates: 0, error: reason })) });
  if (reply === null) return failAll("no response");
  if (reply.stopReason === "refusal") return failAll("the model refused");
  if (reply.stopReason === "max_tokens") return failAll("cut off at max_tokens");
  if (reply.text === null) return failAll(`no structured output (stop reason ${reply.stopReason})`);
  let json: unknown;
  try {
    json = JSON.parse(reply.text);
  } catch {
    return failAll("the output is not JSON");
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) return failAll("the output is not an object of unit groups");
  const groups = json as Record<string, unknown>;
  const position = (k: string) => (/^u\d+$/.test(k) ? Number(k.slice(1)) : NaN);
  // JSON.parse keeps only the last of a repeated key, so repeats are counted in the text itself.
  const keysInText = [...reply.text.matchAll(/"(u\d+)"\s*:\s*\{/g)].map((m) => m[1]);
  const repeated = new Set(keysInText.filter((k, i) => keysInText.indexOf(k) !== i));
  const diagnostics = { unexpectedPositions: Object.keys(groups).map(position).filter((p) => !(p >= 1 && p <= units.length)), malformedGroups: 0, repeatedPositions: [...repeated].map(position), openingMismatches: [] as number[] };
  const facts: CheckedFact[] = [];
  const outcomes = units.map((u, i): UnitOutcome => {
    const key = `u${i + 1}`;
    const fail = (status: "failed" | "omitted", error: string): UnitOutcome => ({ unitKey: u.unitKey, status, facts: 0, rejected: 0, duplicates: 0, error });
    if (!(key in groups)) return fail("omitted", "no group for this unit");
    if (repeated.has(key)) return fail("failed", `the response repeats ${key}; neither copy is used`);
    const parsed = UnitGroup.safeParse(groups[key]);
    if (!parsed.success) {
      diagnostics.malformedGroups++;
      return fail("failed", "the group for this unit is malformed");
    }
    const group = parsed.data;
    if (!openingMatches(group.opening, u)) {
      diagnostics.openingMismatches.push(i + 1);
      return fail("failed", `the group's opening "${group.opening.slice(0, 60)}" isn't this unit's; its facts are not used`);
    }
    const checked = group.facts.map((raw, k) => checkFact(u, raw, k));
    let duplicates = 0;
    const kept = checked.filter((c) => {
      if (seen.has(c.factKey)) return (duplicates++, false);
      seen.add(c.factKey);
      return true;
    });
    facts.push(...kept);
    const indexed = kept.filter((c) => c.status === "indexed").length;
    const counts = { facts: indexed, rejected: kept.length - indexed, duplicates };
    if (indexed > 0 || duplicates > 0) return { unitKey: u.unitKey, status: "extracted", ...counts, error: group.noFactsReason ? `noFactsReason "${group.noFactsReason}" given with facts` : null };
    if (kept.length > 0) return { unitKey: u.unitKey, status: "failed", ...counts, error: `every fact was rejected: ${[...new Set(kept.map((f) => f.rejectionReason!.split(":")[0]))].join(", ")}` };
    const signals = emptySignals(u);
    return signals.length ? { unitKey: u.unitKey, status: "suspected_omission", ...counts, error: `no facts (${group.noFactsReason ?? "no reason given"}) for an answer with: ${signals.join(", ")}` } : { unitKey: u.unitKey, status: "empty", ...counts, error: null };
  });
  return { unusable: null, facts, outcomes, diagnostics };
}
