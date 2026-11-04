// Text helpers over stored transcript lines, shared by claim checks (claims/) and verdict checks
// (Layers 1 and 2). Pure: no I/O.

import { normalize, STOPWORDS } from "./quotes";

// OCR reads "I" at a word's start as "|" ("|didn't"), as quotes.normalize() assumes; a pipe standing
// alone is noise. Stored text is never changed: this only shapes what a check reads.
export const unpiped = (text: string) => text.replace(/(?<![A-Za-z0-9])[|¦](?=[a-z])/g, "I ").replace(/(^|\s)[|¦]+(?=\s|$)/g, "$1");
// A line's spoken words, without the speaker label printed at the start of a turn
// ("A. Yes, they do." -> "Yes, they do."), so a plain answer reads as plain. Labels only at the line's
// start: Q/A with ".", ":" or a space, an OCR "0:" for "Q:", a name in capitals with ":" ("O.J.
// SIMPSON:") with words after it, "THE WITNESS:", or a titled name with ":", or with "." and more
// words after it ("Ms. Hutchinson. I did."). A titled name running into a sentence ("Mr. Smith went")
// is kept, and so is a capitals label alone on its line ("BY MR. PETROCELLI:"), which other checks
// read as the line's opening words.
const NAME = String.raw`[A-Z][A-Za-z'-]+(?: [A-Z][A-Za-z'-]+)*`;
const SPEAKER = new RegExp(
  String.raw`^\s*(?:[QA](?:[.:]|\s)|0:|THE WITNESS:|[A-Z][A-Z.'-]+(?: [A-Z][A-Z.'-]+)*:(?=\s*\S)|(?:MR|MS|MRS|DR|Mr|Ms|Mrs|Dr)\. ${NAME}(?::|\.(?=\s+\S)))\s*`,
);
export const spoken = (text: string) => unpiped(text).replace(SPEAKER, "");
export const contentWords = (text: string) => normalize(text).split(" ").filter((w) => w.length > 1 && !STOPWORDS.has(w));

// The lines an exact phrase sits on; all the given lines when it only matched approximately.
export function locate(phrase: string, lines: readonly { id: number; text: string }[]): number[] {
  const target = normalize(phrase);
  let joined = "";
  const spans = lines.map((l) => {
    const start = joined.length;
    joined += `${normalize(l.text)} `;
    return { id: l.id, start, end: joined.length - 1 };
  });
  const at = target ? joined.indexOf(target) : -1;
  if (at < 0) return lines.map((l) => l.id);
  const end = at + target.length;
  return spans.filter((s) => s.start < end && s.end > at).map((s) => s.id);
}

// Hedges that make the witness's statement qualified, in normalized form (normalize() turns
// "don't" into "don t"). "I'm sure" and "certainly" are not hedges. "about" and "around" aren't
// either: they are approximations, which feed the time check and the approximation deduction.
const HEDGES = [
  "i think", "i don't think", "i believe", "i don't believe", "i'm not sure", "i am not sure", "i'm not certain",
  "i don't know that for a fact", "i don't know for a fact", "i guess", "i suppose", "probably", "my understanding is",
  "to the best of my knowledge", "to the best of my recollection",
  "might have", "may have", "maybe", "perhaps", "possibly", "as far as i know", "as far as i recall", "as far as i remember",
  "if i recall", "if i remember", "if i recall correctly", "i'd say", "i would say", "i'm not positive",
].map(normalize);
// Modal hedges can belong to someone else's words the witness reports ("he said he might have"):
// those don't qualify the witness's own statement.
const MODAL = ["might have", "may have", "maybe", "perhaps", "possibly", "probably"].map(normalize);
const REPORTED = /\b(\w+) (said|says|told me|told us|claimed|claims|thought|thinks|suggested|asked)\b/g;
// Words reported from someone other than the witness ("Safra told me", "they said"), before a hedge.
const reportedBefore = (text: string) => [...text.matchAll(REPORTED)].some((m) => m[1] !== "i" && m[1] !== "we");
// A clause that is nothing but a disclaimer governs the clause it introduces:
// "I don't know that for a fact, but it has to go to Safra Catz."
const DISCLAIMERS = ["i don't know that for a fact", "i don't know for a fact", "i'm not sure", "i am not sure", "i'm not certain"].map(normalize);

// The first hedge in a normalized clause that qualifies the witness's own words: not negated
// ("there's no maybe about it"), and not a modal inside words reported from someone else.
function hedgeIn(text: string): string | null {
  const padded = ` ${text} `;
  for (const h of HEDGES) {
    let from = 0;
    for (;;) {
      const at = padded.indexOf(` ${h} `, from);
      if (at < 0) break;
      from = at + 1;
      const before = padded.slice(0, at);
      if (/ (no|not)$/.test(before)) continue;
      if (MODAL.includes(h) && reportedBefore(before)) continue;
      return h;
    }
  }
  return null;
}

// Letters inside double quotation marks masked out, length kept, so a quoted hedge ("he wrote
// 'maybe'") is never the witness's own qualification, while positions still line up.
const maskQuotes = (text: string) => text.replace(/"[^"]*"|“[^”]*”/g, (q) => q.replace(/[A-Za-z0-9]/g, "x"));

// The hedge governing a phrase in the witness's words. Only the clause holding the phrase counts
// (sentences split at . ? ! ; and at ", but", " but" and ", and": "I left at 9, perhaps 9:15, and I
// never went back" hedges only the time), and in it only the words up to the phrase's end, so a
// hedge on a later conjunct ("…and I believe it goes through HQ Apps") doesn't qualify an earlier one;
// then a bare disclaimer clause right before it. A hedge placed after the phrase ("X, I think") is
// not caught: the check errs toward leaving the model's reading alone.
export function findHedge(phrase: string, answerText: string): string | null {
  const raw = answerText.replace(/[’]/g, "'").split(/[.?!;]+|,\s*(?:but|and)\b|\sbut\b/i);
  const clean = (c: string) => normalize(c).replace(/^(and|but|well|so) /, "");
  const clauses = raw.map(clean).filter(Boolean);
  const masked = raw.filter((c) => clean(c)).map((c) => clean(maskQuotes(c)));
  const target = normalize(phrase);
  for (let i = 0; i < clauses.length; i++) {
    const at = clauses[i].indexOf(target);
    const reach = at >= 0 ? at + target.length : target.includes(clauses[i]) ? clauses[i].length : -1;
    if (reach < 0) continue;
    const own = hedgeIn(masked[i].slice(0, reach));
    if (own) return own;
    const before = clauses[i - 1];
    if (before && DISCLAIMERS.includes(before)) return before;
  }
  return null;
}

