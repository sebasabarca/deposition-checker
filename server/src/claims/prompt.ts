// The extraction prompt, the batch text, and a cost estimate made before any call. Pure: no I/O.

import { callCost } from "../costs/cost";
import { V2_MODELS } from "../costs/models";
import { EPISTEMIC, PREDICATES } from "./vocabulary";

// Bump PROMPT_VERSION whenever the prompt or schema changes: claims are cached per extractor version,
// so a changed prompt is a new extraction, never a silent mix with the old one.
export const PROMPT_VERSION = "claims-v2";
export const CLAIMS_MODEL = V2_MODELS.claim_tagging;
export const EXTRACTOR_VERSION = `${PROMPT_VERSION}+${CLAIMS_MODEL}`;

export const BATCH_SIZE = 12; // exchange parts per call
export const MAX_OUTPUT_TOKENS = 16_000;

const EPISTEMIC_MEANINGS: Record<(typeof EPISTEMIC)[number], string> = {
  asserted: "the witness states it as fact",
  qualified: "the witness hedges or limits it (I think, I believe, I'm not sure, I don't know that for a fact, probably, in a narrow sense)",
  does_not_know: "the witness says they don't know (never knew), which is not a denial",
  does_not_recall: "the witness says they don't remember or don't recall, which is not a denial",
  hypothetical: "a supposition (if, would have, assuming), not a statement of what happened",
  reported_by_other: "the witness repeats what someone else said or believes",
};

export const SYSTEM_PROMPT = `You extract the factual claims a deposition witness makes, so that claims from different sessions can be compared later. You only read and label; you never judge truth, contradiction or confidence.

Each exchange is marked with its ID in brackets, like [E1453]. Lines start with the speaker: Q: is the examining attorney, A: is the witness, and names such as MR. SCOTT: are attorneys or others speaking.

Rules:
- Extract only what the witness asserts. Attorneys' statements, objections and colloquy are not claims.
- source "answer": the witness's own words state the claim. keyPhrase is copied word for word from the witness's answer, a short contiguous phrase that carries the claim.
- source "adopted_question": the witness answers a yes-or-no question with a plain "Yes" or "No" (or "Correct", "That's right", "I did not"). keyPhrase is copied word for word from the attorney's question, and answerPhrase word for word from the witness's answer. A "Yes" means polarity "affirms"; a "No" means "denies". Do not use this for hedged or partial answers.
- When the witness answers a question with only "I don't know", "I'm not sure", "I don't recall" or "I don't remember", extract one adopted_question claim: keyPhrase from the question, answerPhrase from the answer, polarity "affirms" (the proposition as the question puts it), and epistemic "does_not_know" for not knowing or "does_not_recall" for not remembering. This is never a denial.
- answerPhrase is null for source "answer".
- polarity: "affirms" if the witness says the predicate holds, "denies" if the witness says it does not.
- epistemic "qualified" when a hedge governs the statement ("I think", "I believe", "I'm not sure", "I don't know that for a fact, but…", "probably"). "I'm sure" and "certainly" are not hedges.
- A general statement of how things work is asserted even when phrased with "if" ("if customers outsource payroll, they don't buy payroll software"). Use "hypothetical" only for a scenario the witness imagines or a supposition about what would or might happen.
- dependsOnEarlierExchange: true when the claim cannot be understood from this exchange alone, because the question continues an earlier one ("-- to the customer, I mean?", "In the applications area?") or a word like "it" or "that" refers to something said before. Otherwise false.
- One claim per distinct fact. Skip greetings, procedure, document handling and filler. Return no claims for an exchange with no factual assertion.
- Never invent words, names or facts that are not in the exchange.
- subject: who or what the claim is about, in a few words. object: what the predicate applies to, or null.
- time, place, quantity: as stated in the exchange, or null.
- entities: the people, companies, products and documents named in this exchange's own words, written in full canonical form ("Safra Catz", "PeopleSoft", "Oracle E-Business Suite"). Do not add names that are only implied, such as the witness's company when the exchange doesn't name it.

predicate, one of:
${Object.entries(PREDICATES)
  .map(([name, meaning]) => `- ${name}: ${meaning}`)
  .join("\n")}

epistemic, one of:
${Object.entries(EPISTEMIC_MEANINGS)
  .map(([name, meaning]) => `- ${name}: ${meaning}`)
  .join("\n")}`;

export type BatchPart = { id: number; dialogueText: string };

export const exchangeLabel = (id: number) => `E${id}`;

export function formatBatch(parts: readonly BatchPart[]): string {
  return parts.map((p) => `[${exchangeLabel(p.id)}]\n${p.dialogueText}`).join("\n\n");
}

// Planning estimate, before any call (DESIGN.md, "Estimated cost"). Input tokens are taken as one per
// 3 characters, and output as a share of input: DESIGN.md's planning allowance of 40% until calls have
// been measured, then the measured share (measuredOutputShare in costs/). The first pilot measured
// output at about 1.0x input, not 0.4x (thinking counts as output). The system prompt and schema are
// counted at the full input price on every call, ignoring the cache, so the input side errs high.
const CHARS_PER_TOKEN = 3;
export const PLANNING_OUTPUT_SHARE = 0.4;

export type Estimate = { batches: number; parts: number; inputTokens: number; outputTokens: number; costUsd: number };

export function estimateCost(batches: readonly (readonly BatchPart[])[], schemaChars: number, outputShare = PLANNING_OUTPUT_SHARE): Estimate {
  const fixed = SYSTEM_PROMPT.length + schemaChars;
  let inputTokens = 0;
  for (const batch of batches) inputTokens += Math.ceil((fixed + formatBatch(batch).length) / CHARS_PER_TOKEN);
  const outputTokens = Math.ceil(inputTokens * outputShare);
  // Each call is priced on its own (Haiku's rates depend on a call's prompt length), then summed.
  const costUsd = batches.reduce((sum, batch) => {
    const input = Math.ceil((fixed + formatBatch(batch).length) / CHARS_PER_TOKEN);
    const cost = callCost(CLAIMS_MODEL, { input, output: Math.ceil(input * outputShare), cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 });
    if (!cost) throw new Error(`${CLAIMS_MODEL} has no price`);
    return sum + cost.costUsd;
  }, 0);
  return { batches: batches.length, parts: batches.reduce((n, b) => n + b.length, 0), inputTokens, outputTokens, costUsd: Math.round(costUsd * 1e6) / 1e6 };
}
