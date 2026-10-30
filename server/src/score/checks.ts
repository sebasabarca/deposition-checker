// The checks code performs itself for scoring (DESIGN.md, "Confidence scoring": context sufficiency,
// independent corroboration and the time check). Pure: no I/O. They read the verdict's key phrases
// only after Layer 1 has found them in the stored lines, so every signal is grounded in the transcript.

import { compareTimes, type TimeCheck } from "../ambiguity";
import type { AttributionCheck } from "../verify/attribution";
import { contentWords, normalize, STOPWORDS } from "../verify";

export type ContextCheck = { wholeExchanges: boolean; detail: string };

export type CorroborationCheck = {
  negationAsymmetry: boolean; // one side negated, the other not, on a shared content term
  conflictingValues: boolean; // the same unit with different numbers, dates or (incompatible) times
  sharedAnchor: boolean; // a proper noun, date, number or exhibit in both key phrases
  dateConflict: boolean; // both name a date or year and share none: a sequence conflict, or different events
  anchors: { a: string[]; b: string[] };
};

const NEGATION = /\b(no|not|never|nobody|nothing|none|neither|nor)\b|n't\b/i;
const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december";
const DATE = new RegExp(String.raw`\b(?:(?:${MONTHS})(?:\s+\d{1,2}(?:st|nd|rd|th)?)?(?:,?\s+(?:19|20)\d\d)?|(?:19|20)\d\d|\d{1,2}/\d{1,2}(?:/\d{2,4})?)\b`, "gi");
const EXHIBIT = /\bexhibit\s+\w+/gi;
const UNIT_NUMBER = /(\$\s?\d[\d,.]*\s*(?:million|billion|thousand)?|\b\d[\d,.]*\s*(?:%|percent|million|billion|thousand|dollars|years?|months?|weeks?|days?|hours?|minutes?|people|employees|customers|times))/gi;
// Words capitalized for reasons other than being a name: the start of a turn or question.
const NOT_NAMES = new Set(["yes", "no", "q", "a", "mr", "ms", "mrs", "dr", "sir", "okay", "well", "so", "and", "but", "now", "is", "are", "was", "were", "have", "has", "had", "would", "could", "can", "will", "what", "who", "when", "where", "why", "how", "which", "there", "then", "if"]);

const unitOf = (m: string) => normalize(m).replace(/[\d\s]+/g, " ").trim() || "number";

export function anchorsOf(phrase: string): string[] {
  const dates = (phrase.match(DATE) ?? []).map((d) => `date:${normalize(d)}`);
  const exhibits = (phrase.match(EXHIBIT) ?? []).map((e) => `exhibit:${normalize(e)}`);
  const numbers = (phrase.match(UNIT_NUMBER) ?? []).map((n) => `number:${normalize(n)}`);
  const names = (phrase.match(/\b[A-Z][A-Za-z0-9&'-]+/g) ?? [])
    .map((w) => normalize(w))
    .filter((w) => !STOPWORDS.has(w) && !NOT_NAMES.has(w) && !new RegExp(`^(${MONTHS})$`).test(w))
    .map((w) => `name:${w}`);
  return [...new Set([...dates, ...exhibits, ...numbers, ...names])].sort();
}

// The values with a unit in a phrase, by unit: "$5 million" -> million: ["5 million"].
function valuesByUnit(phrase: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of phrase.match(UNIT_NUMBER) ?? []) {
    const unit = unitOf(m);
    out.set(unit, (out.get(unit) ?? new Set()).add(normalize(m)));
  }
  return out;
}

const datesOf = (phrase: string) => new Set((phrase.match(DATE) ?? []).map((d) => normalize(d)));

// A side's witness stance on its key phrase: negated or not. A plain "No." to a question counts as
// negating it; a side with no witness stance (an unclear answer, an attorney's words) has none.
function negated(phrase: string, location: string | null): boolean | null {
  if (location === "answer" || location === "question_affirmed") return NEGATION.test(phrase);
  if (location === "question_denied") return !NEGATION.test(phrase);
  return null;
}

export function corroborate(phraseA: string, phraseB: string, attribution: AttributionCheck, timeCheck: TimeCheck | null): CorroborationCheck {
  const shared = contentWords(phraseA).some((w) => contentWords(phraseB).includes(w));
  const nA = negated(phraseA, attribution.a.location);
  const nB = negated(phraseB, attribution.b.location);
  const unitsA = valuesByUnit(phraseA);
  const unitsB = valuesByUnit(phraseB);
  const valueConflict = [...unitsA].some(([unit, values]) => {
    const other = unitsB.get(unit);
    return other !== undefined && ![...values].some((v) => other.has(v));
  });
  const dA = datesOf(phraseA);
  const dB = datesOf(phraseB);
  const dateConflict = dA.size > 0 && dB.size > 0 && ![...dA].some((d) => dB.has(d));
  const anchors = { a: anchorsOf(phraseA), b: anchorsOf(phraseB) };
  return {
    negationAsymmetry: shared && nA !== null && nB !== null && nA !== nB,
    conflictingValues: valueConflict || dateConflict || timeCheck?.status === "incompatible",
    sharedAnchor: anchors.a.some((x) => anchors.b.includes(x)),
    dateConflict,
    anchors,
  };
}

// Run only when Claude says the conflict is about the timing of the same event (DESIGN.md).
export function timeCheckOf(aboutTiming: boolean, phraseA: string, phraseB: string): TimeCheck | null {
  return aboutTiming ? compareTimes(phraseA, phraseB) : null;
}

// Both exchanges are whole (no logical exchange cut short) and the packet shows lines around them.
// Context lines can be missing because the source transcript itself omits the pages there (excerpted
// exhibits); that is reported as such, and still earns no points: the model saw no context.
export function contextCheck(sides: { wholeExchange: boolean; surroundingLines: number; sourceGap?: boolean }[]): ContextCheck {
  const whole = sides.every((s) => s.wholeExchange);
  const surrounded = sides.every((s) => s.surroundingLines > 0);
  const detail = !whole
    ? "an exchange was sent in part"
    : surrounded
      ? "both exchanges whole, with context lines"
      : sides.some((s) => s.surroundingLines === 0 && s.sourceGap)
        ? "no context lines on one side: the source transcript omits the pages around it"
        : "no context lines around an exchange";
  return { wholeExchanges: whole && surrounded, detail };
}
