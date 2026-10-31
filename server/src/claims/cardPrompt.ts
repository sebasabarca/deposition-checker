// The statement-card prompt, chunking by page, and a cost estimate made before any call. Pure: no I/O.

import { callCost } from "../costs/cost";
import { V2_MODELS } from "../costs/models";
import { maxRequestCost } from "../costs/budget";
import { CARDS_JSON_SCHEMA } from "./cards";
import { EPISTEMIC_MEANINGS, formatBatch, type BatchPart } from "./prompt";
import { CARD_EPISTEMIC, PREDICATES } from "./vocabulary";

// Bump the prompt version whenever the prompt or schema changes: cards are cached per extractor
// version, so a changed prompt is a new extraction, never a silent mix with the old one.
export const CARDS_PROMPT_VERSION = "cards-v2";
export const CARDS_MODEL = V2_MODELS.statement_cards;
export const CARD_EXTRACTOR_VERSION = `${CARDS_PROMPT_VERSION}+${CARDS_MODEL}`;

export const PAGES_PER_CHUNK = 10;
export const CHUNK_OVERLAP_PAGES = 1;
export const CARD_MAX_OUTPUT_TOKENS = 16_000;

export const CARDS_SYSTEM_PROMPT = `You read one section of a deposition transcript and record what the witness asserts in each exchange, as statement cards. Cards are used only to find statements worth comparing across sessions. You only read and label; you never judge truth, contradiction or confidence.

Each exchange is marked with its ID in brackets, like [E1453]. Lines start with the speaker: Q: is the examining attorney, A: is the witness, and names such as MR. SCOTT: are attorneys or others speaking.

For every exchange, do exactly one of these:
- return one or more cards, each with that exchange's ID; or
- list its ID in noAssertion, when the witness asserts nothing of substance (procedure, document handling, a request to repeat the question, an objection with no answer). An exchange where the witness gives no answer always goes here, whatever the attorney said.
Never skip an exchange. Saying nothing about an exchange is different from saying it has no assertion.

Cards:
- One card per distinct assertion. "We met in March, discussed pricing in April, and signed in May" is three cards.
- sourcePhrase: words copied exactly from one exchange's question or answer, one contiguous phrase, no ellipsis, no speaker label. Never change, correct or add a word, and never join the question's words to the answer's. When the witness adopts a question with a plain "Yes" or "No", copy the question's words that carry the assertion.
- statement: the assertion as one sentence that stands alone. Replace pronouns and references like "that meeting" with what they refer to, using this section. Always write the proposition in positive form and put the direction only in stance. A statement never contains "no", "not", "never" or a negative contraction: for "I never met him", the statement is "The witness met Daniel Cho." with stance "denies", and for "My duties have not changed", it is "The witness's duties changed." with stance "denies".
- event: one short line naming the event or subject matter itself, with its date if known, so that statements about the same event from different sessions read alike. Name what is being discussed, not the exhibit or document it came up in: "Definition of an application server", not "Exhibit 550".
- subject: who or what the statement is about, in a few words.
- entities: people, companies, products and documents named in this exchange's own words, in full canonical form. Do not add names that are only implied.
- predicate: the name from the list below that fits best.
- object: what the predicate applies to, or null.
- time, location, amount: as stated in the exchange, or null. Never guess them.
- stance: "asserts" when the witness says the statement holds, "denies" when the witness says it does not, "not_answered" when the witness doesn't answer it (including "I don't recall" and "I don't know"), "unclear" when the answer can't be read either way.
- epistemic: how the witness holds it, from the list below. "I don't recall" and "I don't know" are never denials.
- Only the witness's assertions count. An attorney's statement is a card only if the witness adopts it.
- Never invent words, names or facts that are not in the exchange.

predicate, one of:
${Object.entries(PREDICATES)
  .map(([name, meaning]) => `- ${name}: ${meaning}`)
  .join("\n")}

epistemic, one of:
${CARD_EPISTEMIC.map((name) => `- ${name}: ${EPISTEMIC_MEANINGS[name]}`).join("\n")}`;

// Chunks of about `pages` printed pages, each repeating the previous chunk's last page. A chunk is cut
// by the page each exchange starts on, so an exchange is never split, and pages an excerpted
// transcript omits don't count. Exchanges must already be in transcript order.
export function chunkByPages<T extends { firstPage: number }>(exchanges: readonly T[], pages = PAGES_PER_CHUNK, overlap = CHUNK_OVERLAP_PAGES): T[][] {
  const distinct = [...new Set(exchanges.map((e) => e.firstPage))].sort((a, b) => a - b);
  const chunks: T[][] = [];
  for (let start = 0; start < distinct.length; start += pages - overlap) {
    const window = new Set(distinct.slice(start, start + pages));
    chunks.push(exchanges.filter((e) => window.has(e.firstPage)));
    if (start + pages >= distinct.length) break;
  }
  return chunks;
}

// Planning allowance until cards have been measured: a card's JSON is longer than the words it reads
// (the claims pilot measured output at 1.0x input). Only the worst case is a limit; this is a guess.
export const PLANNING_CARD_OUTPUT_SHARE = 1.5;
const CHARS_PER_TOKEN = 3;

export type CardEstimate = { chunks: number; parts: number; inputTokens: number; expectedUsd: number; worstCaseUsd: number };

export function estimateCards(chunks: readonly (readonly BatchPart[])[], outputShare = PLANNING_CARD_OUTPUT_SHARE): CardEstimate {
  const fixed = CARDS_SYSTEM_PROMPT.length + JSON.stringify(CARDS_JSON_SCHEMA).length;
  let inputTokens = 0;
  let expectedUsd = 0;
  let worstCaseUsd = 0;
  for (const chunk of chunks) {
    const chars = fixed + formatBatch(chunk).length;
    const input = Math.ceil(chars / CHARS_PER_TOKEN);
    inputTokens += input;
    const cost = callCost(CARDS_MODEL, { input, output: Math.min(Math.ceil(input * outputShare), CARD_MAX_OUTPUT_TOKENS), cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });
    if (!cost) throw new Error(`${CARDS_MODEL} has no price`);
    expectedUsd += cost.costUsd;
    worstCaseUsd += maxRequestCost(CARDS_MODEL, { inputTokens: chars, maxOutputTokens: CARD_MAX_OUTPUT_TOKENS });
  }
  return { chunks: chunks.length, parts: chunks.reduce((n, c) => n + c.length, 0), inputTokens, expectedUsd: Math.round(expectedUsd * 1e6) / 1e6, worstCaseUsd: Math.round(worstCaseUsd * 1e6) / 1e6 };
}
