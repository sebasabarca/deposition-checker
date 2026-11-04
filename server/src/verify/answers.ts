// Reads a witness's answer to a yes-or-no question (DESIGN.md, Layer 2 `readAnswer`). Pure: no I/O.
// A plain "No." is always a denial, never agreement. Anything that isn't a plain yes or no, or a bare
// yes or no to a negatively phrased or tag question, is uncertain rather than assumed. Path A uses it
// to accept a claim adopted from an attorney's question; Layer 2 verification will reuse it.

import { unpiped } from "./text";

export type AnswerReading = "affirms" | "denies" | "uncertain";

const YES = /^(yes|yeah|yep|correct|right|absolutely|certainly|definitely|of course|i did|i do|i was|i am|i have|that is (correct|right|true)|that's (correct|right|true))(,? (sir|ma'am|i (did|do|was|am|have)|we (did|do|were|are|have)|they (did|do|were|are|have)|(he|she) (did|does|was|has)|it (is|was|did|does)|that's (correct|right)|of course|absolutely|definitely|certainly))?$/;
const NO = /^(no|nope|incorrect|never|not at all|not ever|absolutely not|certainly not|definitely not|of course not|i did not|i didn't|i do not|i don't|i was not|i wasn't|i have not|i haven't|i never|that is not (correct|right|true)|that's not (correct|right|true))(,? (sir|ma'am|never|not ever|i (did not|didn't|do not|don't|was not|wasn't|have not|haven't|never did|never)|we (did not|didn't|do not|don't)|they (did not|didn't|do not|don't)|(he|she) (did not|didn't|does not|doesn't|was not|wasn't|has not|hasn't)|it (is not|isn't|was not|wasn't|does not|doesn't)|not at all|absolutely not|certainly not|definitely not|of course not))?$/;
// Sentences after a plain answer that only elaborate it keep it plain: for a denial, every later
// sentence is itself negative ("No, never. I don't even know where that is."); for an affirmative,
// none is. Anything that hedges, contrasts or limits the answer leaves it uncertain.
const NEGATED = /\b(no|not|never|nothing|none|nobody|neither|nor)\b|n't\b/;
const QUALIFYING = /\b(but|however|although|though|except|unless|only|maybe|perhaps|possibly|probably|think|believe|guess|suppose|might|may|could|sort of|kind of|i mean|well|if|not sure|not certain|recall|remember)\b/;
// "Didn't you…?", "You never…?" and "…, did you?" make a bare yes or no ambiguous. Only the question
// asked counts, not a preamble before it ("You said you weren't there. Did he call?").
const NEGATIVE_QUESTION = /\b(not|never|no)\b|n't\b/i;
const TAG_QUESTION = /,\s*(did|didn't|do|don't|does|doesn't|is|isn't|was|wasn't|are|aren't|were|weren't|have|haven't|will|won't)(\s+(you|he|she|it|they|we|i|that|there))?\s*\??\s*$/i;
// A confirming tag ("…, correct?", "…, isn't that right?") asks whether the statement before it is
// true: a plain yes affirms it and a plain no denies it, unless the statement is itself negative.
// After a comma or alone ("Correct?"), or as "is that …?" ("Did you turn right?" is no tag).
const CONFIRMING_TAG = /(?:(?:^|[,.])\s*(?:(?:is|isn't|is not|was|wasn't|would|wouldn't) (?:that|it|this) (?:be )?)?|\s(?:is|isn't|is not|was|wasn't|would|wouldn't) (?:that|it|this) (?:be )?)(?:right|correct|true|accurate|fair)\s*\?\s*$/i;
// A sentence ends at . ? ! before a space, except after a title or an initial ("Mr. Smith", "O.J."):
// splitting there could drop a negation ("Isn't it true that Mr. Smith called?").
const SENTENCE_END = /(?<!\b(?:Mr|Ms|Mrs|Dr|St|Jr|Sr|No|vs|Inc|Co|[A-Za-z]))[.?!]+\s+/g;

// The question the answer replies to: from the start of the sentence holding the last "?" to the end,
// or the whole text when there is no "?". A bare confirming question ("Is that right?") reaches back
// to the whole text, since it asks about what came before.
function asked(question: string): { stem: string; confirming: boolean } {
  const text = question.trim().replace(/[’]/g, "'");
  const mark = text.lastIndexOf("?");
  let start = 0;
  for (const m of text.matchAll(SENTENCE_END)) if (m.index + m[0].length <= mark) start = m.index + m[0].length;
  const sentence = text.slice(start);
  const tag = sentence.match(CONFIRMING_TAG);
  if (!tag) return { stem: sentence, confirming: false };
  const stem = sentence.slice(0, tag.index);
  return { stem: /[a-z]/i.test(stem) ? stem : text.slice(0, start), confirming: true };
}

// A turn marker at the start of a sentence ("A: No.", "A. No, sir.", "A No.") isn't testimony: transcripts
// in archive or printed form keep it in the stored line, and it must not turn a plain answer uncertain.
// After splitting on periods, "A." leaves a sentence that is only "a", dropped here too.
const TURN_MARKER = /^[qa](?::|\s+|$)\s*/;
const sentences = (text: string) =>
  unpiped(text)
    .toLowerCase()
    .replace(/[’]/g, "'")
    .split(/[.!?]+/)
    .map((s) => s.replace(/\s+/g, " ").trim().replace(TURN_MARKER, ""))
    .filter(Boolean);

export function readAnswer(question: string, answer: string): AnswerReading {
  const { stem, confirming } = asked(question);
  if (NEGATIVE_QUESTION.test(stem) || (!confirming && TAG_QUESTION.test(stem))) return "uncertain";
  const parts = sentences(answer);
  if (parts.length === 0) return "uncertain";
  // Every sentence must be the same plain answer ("No. No." is a denial; "Yes, but…" is not plain),
  // or a plain answer followed only by sentences that elaborate it.
  if (parts.every((s) => YES.test(s))) return "affirms";
  if (parts.every((s) => NO.test(s))) return "denies";
  const rest = parts.slice(1);
  if (rest.some((s) => QUALIFYING.test(s))) return "uncertain";
  if (YES.test(parts[0]) && rest.every((s) => !NEGATED.test(s))) return "affirms";
  if (NO.test(parts[0]) && rest.every((s) => NEGATED.test(s))) return "denies";
  return "uncertain";
}

// A witness's whole answer when it only says they don't know or don't remember: "I don't know.",
// "I don't recall.", "I don't remember that.", "I'm not sure." The two stay distinct (never knew
// against can't remember), and neither denies the proposition. Null for any other answer.
export type RecollectionReading = "does_not_know" | "does_not_recall";

const DONT_KNOW = /^(i (don't|do not) know|i'm not sure|i am not sure|i have no idea)( (that|it|the answer|for sure|offhand))?$/;
const DONT_RECALL = /^(i (don't|do not) (recall|remember)|i can't (recall|remember)|i cannot (recall|remember))( (that|it|offhand|one way or the other))?$/;

export function readRecollection(answer: string): RecollectionReading | null {
  const parts = sentences(answer).map((s) => s.replace(/^(sir|ma'am),?\s*/, ""));
  if (parts.length === 0) return null;
  if (parts.every((s) => DONT_KNOW.test(s))) return "does_not_know";
  if (parts.every((s) => DONT_RECALL.test(s))) return "does_not_recall";
  return null;
}
