// Code's check of one extracted claim against the exchange part's stored source lines. Pure: no I/O.
// A matching phrase alone is not enough:
// - an `answer` claim's key phrase must be in the witness's own testimony (answer lines), not in
//   the attorney's question;
// - an `adopted_question` claim's key phrase must be in the attorney's question, its answer phrase
//   in the witness's answer, and that answer must be either a plain yes or no (readAnswer) whose
//   direction is the claim's polarity, or a plain "I don't know" / "I don't recall"
//   (readRecollection) matching the claim's epistemic status, stated as the question puts it.
// Beyond the pass or fail, code records what it can check deterministically, kept apart from the
// model's reading: a hedge governing the phrase, whether the claim depends on an earlier exchange,
// and which named entities the exchange's words actually support.
// The exchange and its lines stay authoritative: the claim records which lines hold the evidence.

import { contentWords, findHedge, locate, normalize, quoteMatchScore, readAnswer, readRecollection, spoken, STOPWORDS } from "../verify";

export { contentWords, findHedge, locate };
import { normalizeEntities } from "./entities";
import type { ExtractedClaim } from "./schema";

export const VERIFIED = 1;
export const APPROXIMATE = 0.6; // v1's threshold: at least this share of the phrase's words found
export const MIN_STANDALONE_WORDS = 3; // fewer content words than this can't stand on their own

export type PartLine = { id: number; role: "question" | "answer" | "context" | "unknown"; text: string };
export type Part = { lines: readonly PartLine[]; flags: readonly string[] };

export type ClaimCheck = {
  status: "verified" | "approximate" | "rejected";
  rejectionReason: string | null;
  matchScore: number;
  answerMatchScore: number | null;
  evidenceLineIds: number[];
  hedge: string | null;
  contextDependent: boolean;
  contextReason: string | null;
  entities: string[]; // grounded in the exchange's words
  ungroundedEntities: string[];
};

const textOf = (lines: readonly PartLine[]) => lines.map((l) => spoken(l.text)).join(" ");

// Why a claim's meaning depends on an earlier exchange outside its evidence, or null. Conservative:
// a claim is excluded only on one of these explicit, deterministic grounds. The model's own
// dependsOnEarlierExchange flag is kept on the claim as diagnostic metadata but never excludes it:
// in the second pilot it marked 14 of 19 claims, many of them self-contained (approved October 29).
export function contextReason(claim: ExtractedClaim, part: Part, question: string): string | null {
  if (part.flags.includes("starts_mid_turn")) return "exchange_starts_mid_turn";
  if (claim.source === "adopted_question") {
    if (/^\s*(--|\.\.\.|…)/.test(question)) return "question_continues_earlier_exchange";
    if (contentWords(question).length < MIN_STANDALONE_WORDS) return "question_too_short_to_stand_alone";
  } else if (contentWords(claim.keyPhrase).length < MIN_STANDALONE_WORDS) {
    return "phrase_too_short_to_stand_alone";
  }
  return null;
}

// An entity is kept only if the exchange's own words support it: every meaningful word of its name
// appears, or it is named by an alias, at least half its words, one of them capitalized as a proper
// noun ("Ms. Catz" for Safra Catz). A lowercase common word ("systems", "suite") never grounds a name
// on its own. Names the model added from the wider deposition are set aside as ungrounded.
export function groundEntities(entities: readonly string[], exchangeText: string): { entities: string[]; ungrounded: string[] } {
  const words = new Set(normalize(exchangeText).split(" "));
  const capitalized = new Set((exchangeText.match(/\b[A-Z][A-Za-z0-9&'-]*/g) ?? []).map((w) => normalize(w)));
  const grounded: string[] = [];
  const ungrounded: string[] = [];
  for (const entity of normalizeEntities(entities)) {
    const parts = normalize(entity).split(" ").filter((w) => w.length > 1 && !STOPWORDS.has(w));
    const present = parts.filter((w) => words.has(w));
    const byName = parts.length > 0 && present.length === parts.length;
    const byAlias = present.length * 2 >= parts.length && present.some((w) => capitalized.has(w));
    (byName || byAlias ? grounded : ungrounded).push(entity);
  }
  return { entities: grounded, ungrounded };
}

export function checkClaim(claim: ExtractedClaim, part: Part): ClaimCheck {
  const question = part.lines.filter((l) => l.role === "question");
  const answer = part.lines.filter((l) => l.role === "answer");
  const questionText = textOf(question);
  const answerText = textOf(answer);
  const { entities, ungrounded } = groundEntities(claim.entities, textOf(part.lines));
  const reason = contextReason(claim, part, questionText);
  const findings = {
    hedge: claim.source === "answer" ? findHedge(claim.keyPhrase, answerText) : null,
    contextDependent: reason !== null,
    contextReason: reason,
    entities,
    ungroundedEntities: ungrounded,
  };
  const reject = (rejectionReason: string, matchScore: number, answerMatchScore: number | null = null): ClaimCheck => ({
    status: "rejected",
    rejectionReason,
    matchScore,
    answerMatchScore,
    evidenceLineIds: [],
    ...findings,
  });

  if (answer.length === 0) return reject("no_witness_answer", 0);
  const inAnswer = quoteMatchScore(claim.keyPhrase, answerText);
  const inQuestion = quoteMatchScore(claim.keyPhrase, questionText);

  if (claim.source === "answer") {
    if (inAnswer < APPROXIMATE) {
      return reject(inQuestion >= APPROXIMATE ? "phrase_in_question_not_answer" : "phrase_not_in_testimony", inAnswer);
    }
    return {
      status: inAnswer >= VERIFIED ? "verified" : "approximate",
      rejectionReason: null,
      matchScore: inAnswer,
      answerMatchScore: null,
      evidenceLineIds: locate(claim.keyPhrase, answer),
      ...findings,
    };
  }

  // adopted_question
  if (!questionText.includes("?")) return reject("not_a_question", inQuestion);
  if (inQuestion < APPROXIMATE) return reject("phrase_not_in_question", inQuestion);
  if (!claim.answerPhrase) return reject("adopting_answer_missing", inQuestion);
  const answerMatch = quoteMatchScore(claim.answerPhrase, answerText);
  if (answerMatch < APPROXIMATE) return reject("adopting_answer_not_in_testimony", inQuestion, answerMatch);

  const recollection = readRecollection(answerText);
  if (recollection) {
    // "I don't know" / "I don't recall": the question's proposition, as asked, held with no knowledge
    // or no memory. Never a denial.
    if (claim.epistemic !== recollection) return reject("epistemic_contradicts_answer", inQuestion, answerMatch);
    if (claim.polarity !== "affirms") return reject("no_recall_claim_not_stated_as_asked", inQuestion, answerMatch);
  } else {
    const reading = readAnswer(questionText, answerText);
    if (reading === "uncertain") return reject("answer_not_plain_yes_or_no", inQuestion, answerMatch);
    if (reading !== claim.polarity) return reject("polarity_contradicts_answer", inQuestion, answerMatch);
    if (claim.epistemic !== "asserted") return reject("plain_answer_not_asserted", inQuestion, answerMatch);
  }
  return {
    status: inQuestion >= VERIFIED && answerMatch >= VERIFIED ? "verified" : "approximate",
    rejectionReason: null,
    matchScore: inQuestion,
    answerMatchScore: answerMatch,
    evidenceLineIds: [...locate(claim.keyPhrase, question), ...answer.map((l) => l.id)],
    ...findings,
  };
}
