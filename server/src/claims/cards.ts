// Statement cards: the model's reading of what each exchange asserts, checked by code (DESIGN.md,
// "Path A"). Pure, no I/O. A card is a retrieval representation, never evidence. These checks are
// deterministic: IDs, shape, grounding in the stored lines. Whether a card reads the testimony
// correctly is semantic, and is left to adjudication against the lines themselves.

import { createHash } from "node:crypto";
import { z } from "zod";
import { contentWords, isBareAnswer, matchScore, normalize, readAnswer, readRecollection, spoken, VERIFIED } from "../verify";
import { CARD_EPISTEMIC, CARD_STANCES } from "./vocabulary";
import { groundEntities, locate, type PartLine } from "./verify";
import { exchangeLabel } from "./prompt";

const Text = z.string().trim().min(1);
export const ExtractedCard = z.strictObject({
  exchangeId: Text,
  sourcePhrase: Text, // verbatim words the card rests on
  statement: Text, // the assertion rewritten to stand alone
  event: Text, // one line, for the topic map
  subject: Text,
  entities: z.array(Text),
  predicate: Text,
  object: z.string().nullable(),
  time: z.string().nullable(),
  location: z.string().nullable(),
  amount: z.string().nullable(),
  stance: z.enum(CARD_STANCES),
  epistemic: z.enum(CARD_EPISTEMIC),
});
export type ExtractedCard = z.infer<typeof ExtractedCard>;
// noAssertion is how the model says an exchange has nothing to card; silence is an omission.
const CardsOutput = z.strictObject({ cards: z.array(ExtractedCard), noAssertion: z.array(Text) });
const { $schema: _unused, ...cardsJsonSchema } = z.toJSONSchema(CardsOutput);
// Structured outputs reject string length constraints, and messages.create doesn't strip them. The
// lengths are still enforced here: ExtractedCard reads every card.
export const CARDS_JSON_SCHEMA = JSON.parse(JSON.stringify(cardsJsonSchema, (key, value) => (key === "minLength" ? undefined : value))) as Record<string, unknown>;

export type ChunkExchange = { id: number; depositionId: number; witnessId: number; kind: string; lines: readonly PartLine[] };
export type Chunk = { depositionId: number; witnessId: number; exchanges: readonly ChunkExchange[] };
export type ModelReply = { stopReason: string | null; text: string | null };

export type CoverageStatus = "carded" | "no_assertion" | "suspected_omission" | "omitted" | "failed" | "not_processed";
export type Coverage = { exchangeId: number; status: CoverageStatus; cards: number; error: string | null; signals?: readonly string[] };
export type CheckedCard = {
  cardKey: string; // stable across re-runs: the same input gives the same key
  citedExchange: string;
  exchangeId: number | null;
  ordinal: number;
  status: "usable" | "rejected";
  rejectionReason: string | null;
  card: ExtractedCard | null; // null when it failed the schema
  entities: string[];
  ungroundedEntities: string[];
  firstLineId: number | null;
  lastLineId: number | null;
  raw: unknown;
};
// A negative statement breaks the positive-form rule. With stance "denies" it is a double negative,
// which would flip the direction retrieval reads, so it is rejected; otherwise it is only counted.
const NEGATED = /\b(?:no|not|never|none|nothing|nobody|neither|nor|cannot)\b|n['’]t\b/i;
export const isNegated = (statement: string) => NEGATED.test(statement);

// Why a model's noAssertion looks wrong, from the exchange's own text. noAssertion is an extraction
// result, not a finding about the testimony: this screen only decides whether to doubt it. Length
// alone isn't enough, so it reads three things: the answer's size, factual language in it, and whether
// a short answer adopts, rejects or can't recall a factual proposition in the question. A short
// answer to pure housekeeping ("Do you see that?") stays unsuspected.
const MIN_ANSWER_WORDS = 8;
const MIN_QUESTION_WORDS = 4;
const FACTUAL = /[$%]|\d|\bpercent\b|\b(?:we|our|they|their|he|she|his|her)\b|\b[a-z]+[,]?\s+[A-Z][a-z]+/;
const HOUSEKEEPING = /\b(?:do you (?:see|have) (?:that|it|this)|see that|tell me when|read through|turn to|take a look|look at|for the record|are you (?:finished|ready)|have you finished|marked as|repeat|rephrase|understand (?:the|my) question)\b/gi;
const FILLER = /^(?:\(.*\)\s*)?(?:okay|ok|all right|sure|uh-huh|right)[.,]?(?: i won't guess\.?)?$/i;
const NAME_OR_FIGURE = /[a-z,"] [A-Z][a-z]+|\d/; // a name mid-sentence, or a number
// Whether a question still states a fact once its housekeeping words are gone: "Do you see that?" has
// nothing left, while "that e-mail sent from Mr. Phillips, do you see that?" does. A missed doubt
// loses a card, and a needless one costs a few tokens, so this leans toward doubting.
const statesAFact = (question: string) => {
  const rest = question.replace(HOUSEKEEPING, " ");
  return contentWords(rest).length >= MIN_QUESTION_WORDS || NAME_OR_FIGURE.test(rest);
};

export function screenNoAssertion(question: string, answer: string): string[] {
  const signals: string[] = [];
  const said = answer.trim();
  if (!said) return signals;
  const words = contentWords(said).length;
  if (words >= MIN_ANSWER_WORDS) signals.push("long_answer");
  if (words >= 3 && FACTUAL.test(said)) signals.push("factual_language");
  if (!question.trim()) signals.push("answer_without_question"); // its question is in an earlier part
  else if (statesAFact(question)) {
    if (readRecollection(said)) signals.push("recollection_of_proposition");
    else if (readAnswer(question, said) !== "uncertain") signals.push("adopts_or_rejects_question");
    else if (!said.endsWith("?") && !said.endsWith("--") && !FILLER.test(said)) signals.push("short_answer_to_factual_question");
  }
  return signals;
}

export type CardReading = { unusable: string | null; cards: CheckedCard[]; coverage: Coverage[]; unknownNoAssertion: string[] };

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 32);
const usableKey = (cited: string, statement: string) => hash(`${cited}\0${normalize(statement)}`);
const rejectedKey = (cited: string, ordinal: number, raw: unknown) => hash(`rejected\0${cited}\0${ordinal}\0${JSON.stringify(raw)}`);

// Grounds a card's source phrase in the exchange's question and answer lines: exact words only, and
// a bare answer stands for its question too. Returns the lines, or why it can't be grounded.
function ground(card: ExtractedCard, exchange: ChunkExchange): { first: number; last: number } | string {
  const testimony = exchange.lines.filter((l) => l.role === "question" || l.role === "answer");
  if (testimony.length === 0) return "span_unresolved";
  if (matchScore(card.sourcePhrase, testimony.map((l) => spoken(l.text)).join(" ")) < VERIFIED) return "source_phrase_not_in_exchange";
  const bare = isBareAnswer(card.sourcePhrase);
  if (bare && !testimony.some((l) => l.role === "question")) return "bare_answer_without_question";
  const ids = bare ? testimony.map((l) => l.id) : locate(card.sourcePhrase, testimony.map((l) => ({ id: l.id, text: spoken(l.text) })));
  if (ids.length === 0) return "span_unresolved";
  return { first: ids[0], last: ids[ids.length - 1] };
}

// Reads one chunk's response. `seen` carries usable card keys, and `carded` the exchanges that already
// have usable cards, between chunks: the model rewords an exchange it reads twice, so on the page two
// chunks overlap the first chunk's cards stand, whatever the second one's wording. One bad card never
// costs the good ones; a response that can't be read fails every exchange in the chunk, which stays
// retryable and is never read as "no claims".
export function readCards(chunk: Chunk, reply: ModelReply | null, seen: Set<string> = new Set(), carded: Set<number> = new Set()): CardReading {
  const failAll = (reason: string): CardReading => ({ unusable: reason, cards: [], unknownNoAssertion: [], coverage: chunk.exchanges.map((e) => ({ exchangeId: e.id, status: "failed", cards: 0, error: reason })) });
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
  const output = json as { cards?: unknown; noAssertion?: unknown } | null;
  if (!Array.isArray(output?.cards) || !Array.isArray(output?.noAssertion)) return failAll("the output has no cards or noAssertion list");

  const byLabel = new Map(chunk.exchanges.map((e) => [exchangeLabel(e.id), e]));
  const cards: CheckedCard[] = [];
  const ordinals = new Map<string, number>();
  for (const raw of output.cards as unknown[]) {
    const cited = typeof (raw as { exchangeId?: unknown })?.exchangeId === "string" ? (raw as { exchangeId: string }).exchangeId : "(none)";
    const ordinal = ordinals.get(cited) ?? 0;
    ordinals.set(cited, ordinal + 1);
    const exchange = byLabel.get(cited) ?? null;
    const reject = (rejectionReason: string, card: ExtractedCard | null = null, ungroundedEntities: string[] = []): CheckedCard => ({
      cardKey: rejectedKey(cited, ordinal, raw), citedExchange: cited, exchangeId: exchange?.id ?? null, ordinal, status: "rejected", rejectionReason, card, entities: [], ungroundedEntities, firstLineId: null, lastLineId: null, raw,
    });
    const parsed = ExtractedCard.safeParse(raw);
    if (!parsed.success) {
      cards.push(reject(`invalid_fields: ${parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ")}`.slice(0, 500)));
      continue;
    }
    const card = parsed.data;
    if (!exchange) {
      cards.push(reject("unknown_exchange", card));
      continue;
    }
    if (exchange.witnessId !== chunk.witnessId || exchange.depositionId !== chunk.depositionId) {
      cards.push(reject("exchange_outside_session", card));
      continue;
    }
    if (exchange.kind !== "qa") {
      cards.push(reject("not_a_qa_exchange", card));
      continue;
    }
    if (!exchange.lines.some((l) => l.role === "answer")) {
      cards.push(reject("no_witness_answer", card));
      continue;
    }
    const span = ground(card, exchange);
    if (typeof span === "string") {
      cards.push(reject(span, card));
      continue;
    }
    if (card.stance === "denies" && isNegated(card.statement)) {
      cards.push(reject("negated_denial", card));
      continue;
    }
    const cardKey = usableKey(cited, card.statement);
    if (seen.has(cardKey) || carded.has(exchange.id)) {
      cards.push(reject("duplicate_card", card));
      continue;
    }
    seen.add(cardKey);
    const { entities, ungrounded } = groundEntities(card.entities, exchange.lines.map((l) => spoken(l.text)).join(" "));
    cards.push({ cardKey, citedExchange: cited, exchangeId: exchange.id, ordinal, status: "usable", rejectionReason: null, card, entities, ungroundedEntities: ungrounded, firstLineId: span.first, lastLineId: span.last, raw });
  }

  const said = new Set((output.noAssertion as unknown[]).filter((x): x is string => typeof x === "string"));
  const coverage = chunk.exchanges.map((e): Coverage => {
    const mine = cards.filter((c) => c.exchangeId === e.id);
    const usable = mine.filter((c) => c.status === "usable").length;
    // A card repeated from the overlap means this exchange was already carded by the earlier chunk.
    const repeated = mine.some((c) => c.rejectionReason === "duplicate_card");
    if (usable > 0 || repeated) return { exchangeId: e.id, status: "carded", cards: usable, error: null };
    // Code can see there is no answer, so no retry could change this: it isn't a failure.
    if (mine.length > 0 && mine.every((c) => c.rejectionReason === "no_witness_answer")) return { exchangeId: e.id, status: "no_assertion", cards: 0, error: null };
    if (mine.length > 0) return { exchangeId: e.id, status: "failed", cards: 0, error: `every card was rejected: ${[...new Set(mine.map((c) => c.rejectionReason))].join(", ")}`.slice(0, 500) };
    if (!said.has(exchangeLabel(e.id))) return { exchangeId: e.id, status: "omitted", cards: 0, error: null };
    const text = (role: PartLine["role"]) => e.lines.filter((l) => l.role === role).map((l) => spoken(l.text)).join(" ");
    const signals = screenNoAssertion(text("question"), text("answer"));
    return signals.length > 0 ? { exchangeId: e.id, status: "suspected_omission", cards: 0, error: null, signals } : { exchangeId: e.id, status: "no_assertion", cards: 0, error: null };
  });
  for (const c of cards) if (c.status === "usable") carded.add(c.exchangeId!);
  return { unusable: null, cards, coverage, unknownNoAssertion: [...said].filter((id) => !byLabel.has(id)) };
}

// How much of a readable response the model addressed. A call can end normally having skipped most of
// its chunk, or having waved it through as noAssertion, so this is what flags it. An unreadable response is a failure, reported as one.
export const MIN_ADDRESSED_SHARE = 0.5;
export function addressedShare(reading: CardReading): number | null {
  if (reading.unusable || reading.coverage.length === 0) return null;
  return reading.coverage.filter((c) => c.status !== "omitted" && c.status !== "suspected_omission").length / reading.coverage.length;
}

const STRENGTH: CoverageStatus[] = ["not_processed", "omitted", "failed", "suspected_omission", "no_assertion", "carded"];

// One coverage row for every eligible exchange across all chunks: an exchange in two chunks keeps
// the better outcome and their card counts add up, and one in no chunk is not_processed.
export function mergeCoverage(eligible: readonly number[], readings: readonly { coverage: readonly Coverage[] }[]): Coverage[] {
  return eligible.map((exchangeId) => {
    const rows = readings.flatMap((r) => r.coverage.filter((c) => c.exchangeId === exchangeId));
    if (rows.length === 0) return { exchangeId, status: "not_processed", cards: 0, error: null };
    const best = rows.reduce((a, b) => (STRENGTH.indexOf(b.status) > STRENGTH.indexOf(a.status) ? b : a));
    return { ...best, cards: rows.reduce((n, r) => n + r.cards, 0) };
  });
}
