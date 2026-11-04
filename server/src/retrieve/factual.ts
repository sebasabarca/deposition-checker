// Numeric, temporal and polarity retrieval (path F_factual): candidates that word and meaning similarity
// miss because the two answers disagree on a value ("38 degrees" against "Fifty-one") or one asserts what
// the other denies. Pure: no I/O, no model, no dependency. Reads only an item's original question, answer
// and context (never Stage 2 facts), and knows nothing of any evaluation's passages: every rule is general.
//
// Each item yields typed value mentions (time of day, date, weekday, year, duration, length, temperature,
// money, percent, speed, weight, counts of a noun, bare numbers) from the witness's answer, plus the
// question's values when the answer only adopts it ("Yes."), and polarity claims: each answer sentence
// read as an assertion or a denial (reported speech and non-recollection are not claims; hedged sentences
// count less), a bare yes or no resolved against its question with readAnswer. "I" in an answer and "you"
// in a question stand for the witness, so one witness's "I was not there" meets another's "X was there".
// Two items in different sessions pair only when a value of a compatible dimension and unit differs (no
// shared value in that dimension) and they share subject words, or when two claims of opposite polarity
// share most of their weighted words.

import { readAnswer } from "../verify/answers";
import { stripSpeakerLabels } from "./embeddings";
import { stem, tfidf, tokens, type SparseVector } from "./independent";

export type Dimension = string; // "time", "date", "weekday", "year", "duration", "length", … "count:<noun>", "number"
export type ValueMention = { dim: Dimension; value: number; approx: boolean; meridiem: boolean; text: string };
export type Polarity = "pos" | "neg";
export type Claim = { polarity: Polarity; weight: number; terms: string[]; text: string };
export type Facts = { values: ValueMention[]; claims: Claim[] };
export type FactualItem = { session: string; witness: string; question: string; answer: string; context: string };

const UNITS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, million: 1e6 };
const NUM_WORD = `(?:${[...Object.keys(UNITS), ...Object.keys(TENS), ...Object.keys(SCALES)].join("|")})`;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = "(january|february|march|april|may|june|july|august|september|sept|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\\.?";
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const APPROX = /\b(about|around|approximately|roughly|maybe|probably|almost|nearly|or so|ish|guess|estimate)\b/;

// Unit word (singular, after the plural "s" is dropped) → [dimension, factor to the dimension's base].
const UNIT_TABLE: Record<string, [Dimension, number]> = {
  degree: ["temperature", 1], "°": ["temperature", 1],
  inch: ["length", 0.0254], foot: ["length", 0.3048], feet: ["length", 0.3048], yard: ["length", 0.9144], mile: ["length", 1609.34], meter: ["length", 1], metre: ["length", 1], kilometer: ["length", 1000],
  second: ["duration", 1 / 60], minute: ["duration", 1], min: ["duration", 1], hour: ["duration", 60], hr: ["duration", 60], day: ["duration", 1440], week: ["duration", 10080], month: ["duration", 43830], year: ["duration", 525960],
  dollar: ["money", 1], buck: ["money", 1], cent: ["money", 0.01], grand: ["money", 1000],
  percent: ["percent", 1], "%": ["percent", 1],
  mph: ["speed", 1],
  pound: ["weight", 0.4536], lb: ["weight", 0.4536], kilogram: ["weight", 1], kg: ["weight", 1], ounce: ["weight", 0.02835],
  time: ["count:time", 1],
};
// Numbers that label rather than measure: exhibits, pages, lines, addresses, routes.
const LABEL_BEFORE = /\b(exhibit|exhibits|page|pages|line|lines|paragraph|number|no|tab|section|item|rule|chapter|volume|question|count|apartment|apt|suite|room|unit|highway|route|interstate|channel|bates|tape|disc|docket|case|code|id|badge|extension|ext|floor|grade|version|release|build|form|model|bay|building|ward|gate|dock|aisle|station|bed|level|phase|step|stage|order|invoice|account|policy|claim|plate|flight|bus|truck|car|van|vehicle|and|through|to|of)\s*$/;
const LABEL_AFTER = /^\s*(street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|way|court|ct|place|terrace|freeway|north|south|east|west|release|build|version|update|model|series|edition)\b/;
const ADDRESS = /^\s*(?:[a-z]+\s+){0,2}(street|st|avenue|ave|road|rd|lane|ln|boulevard|blvd|way|court|ct|place|terrace|parkway|highway)\b/;
// Count nouns that are not things being counted.
const NOT_COUNTED = new Set(["of", "or", "and", "to", "the", "a", "in", "on", "at", "for", "with", "by", "from", "that", "this", "is", "was", "were", "are", "i", "he", "she", "we", "they", "you", "it", "but", "so", "then", "if", "as", "not", "no", "more", "less", "other", "years", "year"]);

const sentencesOf = (text: string) => text.replace(/[’]/g, "'").split(/(?<=[.!?;])\s+|\s+--\s+/).map((s) => s.trim()).filter(Boolean);

// Number words to digits: "fifty-one" → "51", "two hundred and five" → "205". A lone "one" stays a word
// ("that one", "no one"); "a hundred" is 100.
export function wordsToDigits(text: string): string {
  const run = new RegExp(`\\b(?:a[\\s-]+(?=(?:hundred|thousand)\\b))?${NUM_WORD}(?:(?:[\\s-]+|[\\s-]+and[\\s-]+)${NUM_WORD})*\\b`, "g");
  return text.replace(run, (m) => {
    const words = m.split(/[\s-]+/);
    if (words.length === 1 && words[0] === "one") return m;
    // A run can hold several numbers ("forty-two and two hundred", "five six"): a word that cannot
    // continue the number being read starts the next one; "and" continues only after a scale word.
    const out: string[] = [];
    let total = 0, current = 0, last = "";
    const flush = (sep: string) => { if (last) out.push(String(total + current), sep); total = 0; current = 0; last = ""; };
    for (const w of words) {
      if (w === "and") { if (!(last in SCALES)) flush("and"); continue; }
      const small = UNITS[w] ?? TENS[w];
      if (small !== undefined && last && !(last in SCALES) && !(last in TENS && w in UNITS && UNITS[w] < 10)) flush("");
      if (w === "a") current = 1;
      else if (small !== undefined) current += small;
      else if (w === "hundred") current = (current || 1) * 100;
      else { total += (current || 1) * SCALES[w]; current = 0; }
      last = w;
    }
    flush("");
    return out.filter(Boolean).join(" ");
  });
}

const minutesOf = (h: number, m: number, mer: string | undefined) => {
  if (!mer) return h % 12 * 60 + m;
  const pm = /^p|evening|afternoon|night/.test(mer);
  return (h % 12 + (pm ? 12 : 0)) * 60 + m;
};

// Every value mention in one stretch of the witness's own words.
export function valuesOf(raw: string): ValueMention[] {
  const out: ValueMention[] = [];
  let text = stripSpeakerLabels(raw).toLowerCase().replace(/[’]/g, "'");
  const approxAt = (i: number) => APPROX.test(text.slice(Math.max(0, i - 25), i));
  const take = (re: RegExp, f: (m: RegExpExecArray) => ValueMention | null) => {
    text = text.replace(re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpExecArray;
      (m as { index?: number }).index = args[args.length - 2] as number;
      const v = f(m);
      if (v) out.push(v);
      return v ? " ".repeat(m[0].length) : m[0];
    });
  };
  const MER = "(a\\.?\\s?m\\.?|p\\.?\\s?m\\.?|in the (?:morning|afternoon|evening)|at night|o'clock)";
  // Times of day, in digits or words ("8:30 pm", "20:30", "six-thirty", "at six twenty-five", "noon").
  take(new RegExp(`\\b(\\d{1,2}):(\\d{2})\\s*${MER}?`, "g"), (m) => {
    const h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return null;
    const mer = m[3] && m[3] !== "o'clock" ? m[3] : h > 12 || h === 0 ? "24h" : undefined;
    return { dim: "time", value: mer === "24h" ? h * 60 + mi : minutesOf(h, mi, mer), approx: approxAt(m.index), meridiem: !!mer, text: m[0].trim() };
  });
  const HOUR = "(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";
  const MINUTE = "(o'clock|oh[\\s-](?:one|two|three|four|five|six|seven|eight|nine)|fifteen|thirty|forty[\\s-]five|(?:twenty|thirty|forty|fifty)(?:[\\s-](?:one|two|three|four|five|six|seven|eight|nine))?|ten|eleven|twelve|thirteen|fourteen|sixteen|seventeen|eighteen|nineteen)";
  // A word time needs a hyphen ("six-thirty"), a time preposition before it or a meridiem after it.
  take(new RegExp(`(\\b(?:at|around|about|by|until|till|before|after|since|approximately|by)\\s+)?\\b${HOUR}(-|\\s+)${MINUTE}\\b(\\s*${MER})?`, "g"), (m) => {
    if (!m[1] && m[3] !== "-" && !m[5] && m[4] !== "o'clock") return null;
    const h = UNITS[m[2]] ?? 0;
    const mi = m[4] === "o'clock" ? 0 : +wordsToDigits(m[4].replace(/^oh[\s-]/, ""));
    const mer = m[6]?.trim();
    return { dim: "time", value: minutesOf(h, mi, mer && mer !== "o'clock" ? mer : undefined), approx: approxAt(m.index), meridiem: !!mer && mer !== "o'clock", text: m[0].trim() };
  });
  take(new RegExp(`\\b(\\d{1,2}|${HOUR})\\s*${MER}`, "g"), (m) => {
    const h = /\d/.test(m[1]) ? +m[1] : UNITS[m[1]];
    if (h < 1 || h > 12) return null;
    const mer = m[3] === "o'clock" ? undefined : m[3];
    return { dim: "time", value: minutesOf(h, 0, mer), approx: approxAt(m.index), meridiem: !!mer, text: m[0].trim() };
  });
  take(/\b(noon|midnight)\b/g, (m) => ({ dim: "time", value: m[1] === "noon" ? 720 : 0, approx: approxAt(m.index), meridiem: true, text: m[0] }));
  // Dates: "June 6", "September 9, 2025", "the 6th of June", "9/9/2025".
  take(new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "g"), (m) => dateMention(m[1], +m[2], m[3], m[0], approxAt(m.index), out));
  take(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+of\\s+${MONTH}(?:,?\\s+(\\d{4}))?`, "g"), (m) => dateMention(m[2], +m[1], m[3], m[0], approxAt(m.index), out));
  take(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g, (m) => (+m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31 ? dateMention(MONTHS[+m[1] - 1], +m[2], m[3] && m[3].length === 4 ? m[3] : undefined, m[0], false, out) : null));
  take(new RegExp(`\\b(${WEEKDAYS.join("|")})\\b`, "g"), (m) => ({ dim: "weekday", value: WEEKDAYS.indexOf(m[1]), approx: false, meridiem: false, text: m[0] }));
  // Numbers with units, counts and bare numbers, after number words become digits.
  text = wordsToDigits(text);
  // Identifiers, not quantities: versions ("2.0.1"), lettered codes ("U-500", "I-95", "2B").
  text = text.replace(/\b\d+(?:\.\d+){2,}\b|\b[a-z]+-\d+\b|\b\d+[a-z]\b/g, (m) => " ".repeat(m.length));
  take(/\b(19\d\d|20\d\d)\b(?!\s*(?:dollars|bucks|feet|miles|pounds))/g, (m) => ({ dim: "year", value: +m[1], approx: approxAt(m.index), meridiem: false, text: m[0] }));
  take(/(\$\s?)?\b(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(%|°|miles per hour|[a-z]+)?/g, (m) => {
    const value = +m[2].replace(/,/g, "");
    const before = text.slice(Math.max(0, m.index - 20), m.index);
    if (!m[1] && LABEL_BEFORE.test(before)) return null;
    const unitWord = m[3] ?? "";
    if (LABEL_AFTER.test(unitWord) || ADDRESS.test(text.slice(m.index + m[0].length - unitWord.length, m.index + m[0].length + 30))) return null;
    const approx = approxAt(m.index);
    if (m[1]) return { dim: "money", value, approx, meridiem: false, text: m[0].trim() };
    if (unitWord === "miles per hour") return { dim: "speed", value, approx, meridiem: false, text: m[0].trim() };
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 8);
    if (/^(year|years)$/.test(unitWord) && /^\s*old/.test(after)) return { dim: "age", value, approx, meridiem: false, text: m[0].trim() };
    const singular = /es$/.test(unitWord) && UNIT_TABLE[unitWord.slice(0, -2)] ? unitWord.slice(0, -2) : unitWord.replace(/s$/, "");
    const unit = UNIT_TABLE[unitWord] ?? UNIT_TABLE[singular];
    if (unit) return { dim: unit[0], value: Math.round(value * unit[1] * 1e6) / 1e6, approx, meridiem: false, text: m[0].trim() };
    if (unitWord.length >= 3 && !NOT_COUNTED.has(unitWord) && /^[a-z]+$/.test(unitWord)) return { dim: `count:${stem(unitWord)}`, value, approx, meridiem: false, text: m[0].trim() };
    return { dim: "number", value, approx, meridiem: false, text: m[0].trim() };
  });
  return out;
}

function dateMention(month: string, day: number, year: string | undefined, text: string, approx: boolean, out: ValueMention[]): ValueMention | null {
  const mi = MONTHS.indexOf(month.slice(0, 3));
  if (mi < 0 || day < 1 || day > 31) return null;
  if (year) out.push({ dim: "year", value: +year, approx, meridiem: false, text });
  return { dim: "date", value: (mi + 1) * 100 + day, approx, meridiem: false, text: text.trim() };
}

const MEASURES = new Set(["temperature", "length", "duration", "money", "percent", "speed", "weight", "age", "number"]);
// Whether two dimensions are comparable: the same one, a count of the same noun, or a bare number against
// any measure or count (the question or context carries the unit: "What did it read?" "Fifty-one.").
export function compatibleDims(a: Dimension, b: Dimension): boolean {
  if (a === b) return true;
  const other = a === "number" ? b : b === "number" ? a : null;
  return other !== null && (MEASURES.has(other) || other.startsWith("count:"));
}

const sameValue = (x: ValueMention, y: ValueMention) => {
  if (x.dim === "time" && y.dim === "time") {
    const [a, b] = x.meridiem && y.meridiem ? [x.value, y.value] : [x.value % 720, y.value % 720];
    return Math.abs(a - b) <= (x.approx || y.approx ? 15 : 0);
  }
  const tol = x.approx || y.approx ? 0.15 : 0.01;
  return Math.abs(x.value - y.value) <= tol * Math.max(Math.abs(x.value), Math.abs(y.value));
};

// The strongest value disagreement between two items: 1 for the same typed dimension, 0.6 when one side
// is a bare number; null when no compatible dimension differs. A dimension in which the two share a value
// is not a disagreement (lists of several times or dates usually overlap in part).
export function valueConflict(a: readonly ValueMention[], b: readonly ValueMention[]): { strength: number; a: ValueMention; b: ValueMention } | null {
  let best: { strength: number; a: ValueMention; b: ValueMention } | null = null;
  for (const x of a) for (const y of b) {
    if (!compatibleDims(x.dim, y.dim)) continue;
    const agree = a.some((x2) => compatibleDims(x2.dim, y.dim) && b.some((y2) => compatibleDims(x2.dim, y2.dim) && (x2.dim === x.dim || y2.dim === y.dim) && sameValue(x2, y2)));
    if (agree || sameValue(x, y)) continue;
    const strength = (x.dim === y.dim ? 1 : 0.6) * (x.approx || y.approx ? 0.8 : 1);
    if (!best || strength > best.strength) best = { strength, a: x, b: y };
  }
  return best;
}

const REPORTED = /\b(said|says|told|tells|telling|asked|asks|according to|heard|claimed|claims|stated|testified|wrote|mentioned|explained)\b/;
const NON_RECALL = /\b(don't|do not|didn't|did not|can't|cannot|couldn't) (recall|remember|know)\b|\bnot (sure|certain)\b|\bno (idea|recollection|memory)\b/;
const HEDGE = /\b(think|believe|maybe|probably|guess|might|possibly|perhaps|assume|suppose)\b/;
const NEGATION = /\b(not|never|no|nobody|nothing|none|neither|nor|nowhere)\b|n't\b/;
const FIRST_PERSON = /\b(i|me|my|myself|i'm|i've|i'd)\b/;
const SECOND_PERSON = /\b(you|your|yourself|you're|you've)\b/;
// Being somewhere is said many ways; one predicate term joins "was there", "was present", "attended", "at that meeting".
const PRESENCE = /\b(there|present|attend|attended|attending|attendance|(?:was|were|been)(?: not|n't)? at|in the room|showed up)\b/;
const PRESENCE_STEMS = new Set(["present", "attend", "attendanc"]);
const KNOWLEDGE_QUESTION = /\b(do|did|does) (you|he|she|they) (know|recall|remember)\b|\b(are|were) you aware\b|\bcan you (tell|recall|remember)\b|\bany (idea|recollection|memory)\b/i;
const IRREGULAR: Record<string, string> = { saw: "see", seen: "see", drove: "drive", driven: "drive", went: "go", gone: "go", took: "take", taken: "take", knew: "know", known: "know", met: "meet", left: "leave", ran: "run", came: "come", got: "get", gotten: "get", gave: "give", given: "give", wrote: "write", written: "write", spoke: "speak", spoken: "speak", found: "find", brought: "bring", bought: "buy", sat: "sit", stood: "stand", heard: "hear", kept: "keep", paid: "pay", sent: "send", began: "begin", ate: "eat", hit: "hit", held: "hold", lost: "lose", made: "make", put: "put", threw: "throw", wore: "wear", broke: "break", broken: "break", fell: "fall", felt: "feel" };

export const nameTerms = (witness: string) => tokens(witness.split(",")[0].replace(/\b[A-Z]\.\s*/g, " "));

function claimTerms(sentence: string, self: readonly string[], person: RegExp): string[] {
  const lower = sentence.toLowerCase().replace(/[’]/g, "'");
  const presence = PRESENCE.test(lower);
  // The presence words become the one predicate term, so "attended" is not counted twice.
  const t = tokens(lower).map((w) => IRREGULAR[w] ?? w).filter((w) => !presence || !PRESENCE_STEMS.has(w));
  if (person.test(lower)) t.push(...self);
  if (presence) t.push("@present");
  return [...new Set(t)];
}

// The polarity claims in an item's answer.
export function claimsOf(question: string, answer: string, witness: string): Claim[] {
  const self = nameTerms(witness);
  const q = stripSpeakerLabels(question);
  const out: Claim[] = [];
  for (const s of sentencesOf(stripSpeakerLabels(answer))) {
    const lower = s.toLowerCase().replace(/[’]/g, "'");
    if (REPORTED.test(lower) || NON_RECALL.test(lower)) continue;
    const reading = readAnswer(q, s);
    if (reading !== "uncertain") {
      // A bare yes or no answers the question: the claim is the question's own words. "No" to "Do you know
      // (recall, remember) …?" is non-recollection and "No" to "Are you sure …?" is doubt, not denials.
      if (!q || KNOWLEDGE_QUESTION.test(q) || (reading === "denies" && /\b(are|were) you (sure|certain)\b/i.test(q))) continue;
      const terms = claimTerms(q, self, SECOND_PERSON);
      if (terms.length) out.push({ polarity: reading === "affirms" ? "pos" : "neg", weight: 1, terms, text: `${q} ${s}` });
      continue;
    }
    const terms = claimTerms(s, self, FIRST_PERSON);
    if (terms.length < 2) continue;
    out.push({ polarity: NEGATION.test(lower) ? "neg" : "pos", weight: HEDGE.test(lower) ? 0.6 : 1, terms, text: s });
  }
  return out;
}

export function factsOf(item: FactualItem): Facts {
  const q = stripSpeakerLabels(item.question);
  const a = stripSpeakerLabels(item.answer);
  // A short group with no question is a cover, caption or appearance page or a fragment, not an answer.
  if (!q && a.length < 2000) return { values: [], claims: [] };
  const values = valuesOf(a);
  // An answer that only agrees ("Yes.", "Correct.") adopts the question's values.
  if (readAnswer(q, a) === "affirms") values.push(...valuesOf(q));
  return { values, claims: claimsOf(item.question, item.answer, item.witness) };
}

// Opposition between two claims: the weighted share of the smaller claim's terms the two hold in common,
// when their polarity is opposed and they share at least two terms; 0 otherwise.
export function opposition(x: Claim, y: Claim, idf: (t: string) => number): number {
  if (x.polarity === y.polarity) return 0;
  const ys = new Set(y.terms);
  const shared = x.terms.filter((t) => ys.has(t));
  if (shared.length < 2) return 0;
  const mass = (ts: readonly string[]) => ts.reduce((s, t) => s + idf(t), 0);
  return (mass(shared) / Math.min(mass(x.terms), mass(y.terms))) * x.weight * y.weight;
}

export const MIN_SUBJECT = 0.05; // item cosine a value disagreement needs: some shared subject words
export const MIN_OPPOSITION = 0.5;

const cosine = (a: SparseVector, b: SparseVector) => {
  const [s, l] = a.size < b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [i, x] of s) dot += x * (l.get(i) ?? 0);
  return dot;
};

export type FactualIndex = { facts: Facts[]; vectors: SparseVector[]; idf: (t: string) => number };

// Facts and subject vectors (question, answer and context words, with the witness's name for "I") of every item.
export function indexItems(items: readonly FactualItem[]): FactualIndex {
  const facts = items.map(factsOf);
  const docs = items.map((i, k) => [...tokens(`${stripSpeakerLabels(i.question)} ${stripSpeakerLabels(i.answer)} ${stripSpeakerLabels(i.context)}`), ...facts[k].claims.flatMap((c) => c.terms)]);
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string) => Math.log(1 + items.length / (df.get(t) ?? 1));
  return { facts, vectors: tfidf(docs, { minDf: 2, maxDfShare: 0.2 }).vectors, idf };
}

// The score of b from a: the strongest disagreement, weighted by how much subject the two share.
export function pairScore(ix: FactualIndex, a: number, b: number): number {
  const fa = ix.facts[a], fb = ix.facts[b];
  if (!fa.values.length && !fa.claims.length) return 0;
  const subject = cosine(ix.vectors[a], ix.vectors[b]);
  let best = 0;
  if (subject >= MIN_SUBJECT && fa.values.length && fb.values.length) {
    const v = valueConflict(fa.values, fb.values);
    if (v) best = v.strength * (0.3 + subject);
  }
  for (const x of fa.claims) for (const y of fb.claims) {
    const o = opposition(x, y, ix.idf);
    if (o >= MIN_OPPOSITION) best = Math.max(best, o * (0.3 + subject));
  }
  return best;
}

// Every item's scored partners in other sessions, best first: to `depth`, or all of them for `full` rows.
export function factualNeighbours(items: readonly FactualItem[], depth: number, full: ReadonlySet<number> = new Set(), ix = indexItems(items)): { id: number; score: number }[][] {
  // Candidate partners share a dimension family or a claim term; a full scan stays affordable at this size.
  const hasFacts = ix.facts.map((f) => f.values.length > 0 || f.claims.length > 0);
  return items.map((it, a) => {
    if (!hasFacts[a]) return [];
    const out: { id: number; score: number }[] = [];
    for (let b = 0; b < items.length; b++) {
      if (!hasFacts[b] || items[b].session === it.session) continue;
      const s = pairScore(ix, a, b);
      if (s > 0) out.push({ id: b, score: Math.round(s * 1e6) / 1e6 });
    }
    out.sort((x, y) => y.score - x.score || x.id - y.id);
    return full.has(a) ? out : out.slice(0, depth);
  });
}
