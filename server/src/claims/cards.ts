// Statement cards: the model's reading of what each exchange asserts, checked by code (DESIGN.md,
// "Path A"). Pure, no I/O. A card is a retrieval representation, never evidence. These checks are
// deterministic: IDs, shape, grounding in the stored lines. Whether a card reads the testimony
// correctly is semantic, and is left to adjudication against the lines themselves.

import { createHash } from "node:crypto";
import { z } from "zod";
import { isBareAnswer, matchScore, normalize, spoken, VERIFIED } from "../verify";
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
export const CARDS_JSON_SCHEMA = cardsJsonSchema;

export type ChunkExchange = { id: number; depositionId: number; witnessId: number; kind: string; lines: readonly PartLine[] };
export type Chunk = { depositionId: number; witnessId: number; exchanges: readonly ChunkExchange[] };
export type ModelReply = { stopReason: string | null; text: string | null };

export type CoverageStatus = "carded" | "no_assertion" | "omitted" | "failed" | "not_processed";
export type Coverage = { exchangeId: number; status: CoverageStatus; cards: number; error: string | null };
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

// Reads one chunk's response. `seen` carries usable card keys between chunks, so the page two chunks
// overlap on keeps the first card. One bad card never costs the good ones; a response that can't be
// read fails every exchange in the chunk, which stays retryable and is never read as "no claims".
export function readCards(chunk: Chunk, reply: ModelReply | null, seen: Set<string> = new Set()): CardReading {
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
    const span = ground(card, exchange);
    if (typeof span === "string") {
      cards.push(reject(span, card));
      continue;
    }
    const cardKey = usableKey(cited, card.statement);
    if (seen.has(cardKey)) {
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
    if (mine.length > 0) return { exchangeId: e.id, status: "failed", cards: 0, error: `every card was rejected: ${[...new Set(mine.map((c) => c.rejectionReason))].join(", ")}`.slice(0, 500) };
    return { exchangeId: e.id, status: said.has(exchangeLabel(e.id)) ? "no_assertion" : "omitted", cards: 0, error: null };
  });
  return { unusable: null, cards, coverage, unknownNoAssertion: [...said].filter((id) => !byLabel.has(id)) };
}

const STRENGTH: CoverageStatus[] = ["not_processed", "omitted", "failed", "no_assertion", "carded"];

// One coverage row for every eligible exchange across all chunks: an exchange in two chunks keeps
// the better outcome and their card counts add up, and one in no chunk is not_processed.
export function mergeCoverage(eligible: readonly number[], readings: readonly CardReading[]): Coverage[] {
  return eligible.map((exchangeId) => {
    const rows = readings.flatMap((r) => r.coverage.filter((c) => c.exchangeId === exchangeId));
    if (rows.length === 0) return { exchangeId, status: "not_processed", cards: 0, error: null };
    const best = rows.reduce((a, b) => (STRENGTH.indexOf(b.status) > STRENGTH.indexOf(a.status) ? b : a));
    return { ...best, cards: rows.reduce((n, r) => n + r.cards, 0) };
  });
}
