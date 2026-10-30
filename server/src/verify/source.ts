// Layer 1: source verification (DESIGN.md, "Evidence verification"). Pure: no I/O. For each side of
// a verdict, the cited exchange ID must be that side's packet exchange, its deposition must belong to
// the finding's witness, its lines must resolve, and the model's key phrase must be found in it. The
// key phrase is only checked, never displayed: displayed text always comes from the stored lines.
//
//   verified         the IDs are valid and the key phrase matches exactly
//   approximate      the IDs are valid and the key phrase matches at 0.6 to 0.99
//   wrong_reference  the phrase is found in another exchange of the packet, or in the context lines
//                    around it, but not in the one cited (this includes citing the other session)
//   unsupported      an ID outside the packet, another witness's exchange, or a phrase found nowhere
//
// Layer 1 also records where the phrase sits, which Layer 2 builds on, and what proposition the side
// stands for. A yes or no means nothing without its question: a key phrase that is only an answer
// ("Yes.", "Yes, they do.", "No, sir.", "I don't recall.") stands for the question it answers, read
// together with that answer, and its evidence lines are the question and the answer, never the bare
// answer alone. A bare answer with no question in the exchange supports no proposition: unsupported.

import { readAnswer } from "./answers";
import { normalize, quoteMatchScore, STOPWORDS } from "./quotes";
import { locate, spoken } from "./text";

export const VERIFIED = 1;
export const APPROXIMATE = 0.6; // v1's threshold, also used for claims

export type EvidenceStatus = "verified" | "approximate" | "wrong_reference" | "unsupported";
export type Location = "answer" | "question_affirmed" | "question_denied" | "question_other" | "attorney_or_colloquy";

export type EvidenceLine = { id: number; role: "question" | "answer" | "context" | "unknown"; text: string };
// One side of a packet: the logical exchange's member lines, and the context lines shown around it.
export type EvidenceExchange = {
  id: string; // "E<first part id>", as shown to the model
  witnessId: number;
  lines: readonly EvidenceLine[];
  context: readonly { id: number; text: string }[]; // the other lines shown with it, not part of it
};

export type SideSource = {
  citedId: string;
  status: EvidenceStatus;
  reason: string | null; // why it isn't verified or approximate
  matchScore: number; // in the cited exchange
  location: Location | null; // null unless the phrase was found in the cited exchange
  bareAnswer: boolean; // the key phrase is only an answer, so the side stands for the question
  // The proposition code's checks read: the key phrase, or for a bare answer the question it answers.
  proposition: string;
  // Why a plain yes or no to a question wasn't taken as adopting or denying the cited part of it.
  compound: "and" | "or" | null;
  evidenceLineIds: number[]; // what the lawyer sees: for a question-side phrase, the question and the answer
  questionText: string; // the cited exchange's spoken question and answer, for Layer 2
  answerText: string;
};

export type SourceCheck = {
  status: EvidenceStatus; // the worse of the two sides
  a: SideSource;
  b: SideSource;
  packetIds: string[];
};

// v1's word-share match ignores word order and where the words are, so on its own it would accept
// words gathered from different sentences (a fabricated "I met Daniel Cho at the warehouse" took
// "Daniel Cho" from the question and "met" from the answer, 0.675), and "I was not there" for "I was
// there". An approximate match must therefore be found within one sentence, and carry the same
// negations as that sentence. An exact match is exact by definition, across sentences or not.
const NEGATIONS = new Set(["not", "never", "no", "nobody", "nothing", "none", "neither", "nor"]);
function negationsOf(text: string): string[] {
  const words = normalize(text.replace(/[’]/g, "'")).split(" ");
  // normalize() splits "didn't" into "didn t": a "t" after a word ending in n is a negation.
  return words.filter((w, i) => NEGATIONS.has(w) || (w === "t" && /n$/.test(words[i - 1] ?? ""))).map((w) => (w === "t" ? "n't" : w));
}
const sameNegations = (x: string[], y: string[]) => x.length === y.length && [...x].sort().join() === [...y].sort().join();

export function matchScore(phrase: string, text: string): number {
  const score = quoteMatchScore(phrase, text);
  if (score >= VERIFIED || score < APPROXIMATE) return score;
  const sentences = text.split(/(?<=[.?!;])\s+/).filter(Boolean);
  const best = sentences.map((s) => ({ s, score: quoteMatchScore(phrase, s) })).sort((a, b) => b.score - a.score)[0];
  if (!best || best.score < APPROXIMATE) return 0;
  return sameNegations(negationsOf(phrase), negationsOf(best.s)) ? best.score : 0;
}

const RANK: Record<EvidenceStatus, number> = { verified: 0, approximate: 1, wrong_reference: 2, unsupported: 3 };
const textOf = (lines: readonly { text: string }[]) => lines.map((l) => spoken(l.text)).join(" ");

// Words that make up an answer without stating anything: yes, no, sir, I don't recall...
const ANSWER_WORDS = new Set(
  "yes yeah yep yup correct right true absolutely certainly sure definitely indeed exactly no nope never not incorrect wrong sir ma am did didn t don does doesn was wasn is isn have haven had hadn recall remember know think believe guess suppose so uh huh okay ok that s".split(" "),
);
export const isBareAnswer = (phrase: string) => normalize(phrase).split(" ").filter((w) => w && !ANSWER_WORDS.has(w) && !STOPWORDS.has(w)).length === 0;

// The question sentence a phrase sits in: a question often follows a preamble ("Let me show you
// Exhibit 5. Did you sign it?").
function sentenceHolding(phrase: string, text: string): string {
  const sentences = text.split(/(?<=[.?!;])\s+/).filter(Boolean);
  return sentences.map((s) => ({ s, score: quoteMatchScore(phrase, s) })).sort((a, b) => b.score - a.score)[0]?.s ?? text;
}

export type Located = { location: Location; bareAnswer: boolean; proposition: string; compound: "and" | "or" | null };

// Where a phrase found in an exchange sits. A bare answer stands for the question it answers. Then
// the witness's answer; then the attorney's question, read through the answer that follows
// (readAnswer: a plain "No." is a denial; anything not plainly yes or no is question_other);
// otherwise an objection, colloquy, or a question with no answer, which the witness never adopted.
//
// Compound questions: a plain "No." to "Did you A and B?" denies the conjunction, not each part, and
// a plain "Yes." to "Did you A or B?" adopts one of them, not either in particular. So when the key
// phrase cites only part of such a question, that answer leaves the side question_other.
export function locatePhrase(phrase: string, lines: readonly EvidenceLine[]): Located {
  const question = textOf(lines.filter((l) => l.role === "question"));
  const answer = textOf(lines.filter((l) => l.role === "answer"));
  const bare = isBareAnswer(phrase);
  const read = (proposition: string, partOf: string | null): Located => {
    const reading = readAnswer(question, answer);
    let compound: Located["compound"] = null;
    if (partOf !== null) {
      const sentence = sentenceHolding(phrase, partOf);
      const cited = new Set(normalize(phrase).split(" "));
      const partial = normalize(sentence).split(" ").some((w) => w && !STOPWORDS.has(w) && !cited.has(w));
      if (partial && reading === "denies" && /\band\b/i.test(sentence)) compound = "and";
      if (partial && reading === "affirms" && /\bor\b/i.test(sentence)) compound = "or";
    }
    const location = compound ? "question_other" : reading === "affirms" ? "question_affirmed" : reading === "denies" ? "question_denied" : "question_other";
    return { location, bareAnswer: bare, proposition, compound };
  };
  if (bare && answer && matchScore(phrase, answer) >= APPROXIMATE) {
    if (!question) return { location: "attorney_or_colloquy", bareAnswer: true, proposition: phrase, compound: null };
    return read(question, null);
  }
  if (answer && matchScore(phrase, answer) >= APPROXIMATE) return { location: "answer", bareAnswer: false, proposition: phrase, compound: null };
  if (question && matchScore(phrase, question) >= APPROXIMATE) {
    if (!answer) return { location: "attorney_or_colloquy", bareAnswer: false, proposition: phrase, compound: null };
    return read(phrase, question);
  }
  return { location: "attorney_or_colloquy", bareAnswer: bare, proposition: phrase, compound: null };
}

export function checkSide(
  phrase: string,
  citedId: string,
  own: EvidenceExchange,
  other: EvidenceExchange,
  witnessId: number,
): SideSource {
  const base = { citedId, matchScore: 0, location: null, bareAnswer: isBareAnswer(phrase), proposition: phrase, compound: null, evidenceLineIds: [], questionText: "", answerText: "" };
  // The best match outside the cited exchange: the other session's exchange and every context line.
  const elsewhere = () => Math.max(0, ...[other.lines, own.context, other.context].filter((ls) => ls.length > 0).map((ls) => matchScore(phrase, textOf(ls))));

  if (citedId !== own.id) {
    if (citedId === other.id) {
      return { ...base, status: "wrong_reference", reason: "cites the other session's exchange" };
    }
    return { ...base, status: "unsupported", reason: `exchange ID ${citedId} is not in the packet` };
  }
  if (own.witnessId !== witnessId) return { ...base, status: "unsupported", reason: "the exchange belongs to another witness" };
  if (own.lines.length === 0) return { ...base, status: "unsupported", reason: "the exchange's lines don't resolve" };

  const score = matchScore(phrase, textOf(own.lines));
  const texts = {
    questionText: textOf(own.lines.filter((l) => l.role === "question")),
    answerText: textOf(own.lines.filter((l) => l.role === "answer")),
  };
  const outside = score < VERIFIED ? elsewhere() : 0;
  if (score < APPROXIMATE || outside > score) {
    return outside >= APPROXIMATE
      ? { ...base, ...texts, matchScore: score, status: "wrong_reference", reason: "the phrase is outside the cited exchange" }
      : { ...base, ...texts, matchScore: score, status: "unsupported", reason: "the phrase is found nowhere in the packet" };
  }
  const located = locatePhrase(phrase, own.lines);
  const questionLines = own.lines.filter((l) => l.role === "question");
  const answerLines = own.lines.filter((l) => l.role === "answer");
  if (located.bareAnswer && questionLines.length === 0) {
    return { ...base, ...texts, matchScore: score, status: "unsupported", reason: "a bare answer, with no question in the exchange to give it meaning" };
  }
  // A question-side phrase is shown with the answer that adopts or denies it, and a bare answer with
  // its whole question, so the evidence can never be a lone "Yes" or "No".
  const evidenceLineIds = located.location.startsWith("question_")
    ? [...(located.bareAnswer ? questionLines.map((l) => l.id) : locate(phrase, questionLines)), ...answerLines.map((l) => l.id)]
    : locate(phrase, own.lines);
  return {
    citedId,
    status: score >= VERIFIED ? "verified" : "approximate",
    reason: null,
    matchScore: score,
    ...located,
    evidenceLineIds,
    ...texts,
  };
}

export function checkSources(
  verdict: { evidenceAId: string; evidenceBId: string; keyPhraseA: string; keyPhraseB: string },
  packet: { witnessId: number; a: EvidenceExchange; b: EvidenceExchange },
): SourceCheck {
  const a = checkSide(verdict.keyPhraseA, verdict.evidenceAId, packet.a, packet.b, packet.witnessId);
  const b = checkSide(verdict.keyPhraseB, verdict.evidenceBId, packet.b, packet.a, packet.witnessId);
  return { status: RANK[a.status] >= RANK[b.status] ? a.status : b.status, a, b, packetIds: [packet.a.id, packet.b.id] };
}
