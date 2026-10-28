// Which exchanges Path B leaves out, and which words its queries ignore. Pure: no I/O.
// Both are settings to be measured with the evaluation labels, not fixed truths.

// Courtroom vocabulary and conversational filler that carry no subject matter. Postgres's English
// configuration already drops common words ("the", "did", "you"); these are what it keeps but
// that would make unrelated exchanges look alike. Removed from queries and from the content-term
// count, stemmed by Postgres the same way as the index. Words that can carry testimony ("know",
// "remember", "said") are deliberately kept.
export const COURTROOM_WORDS = [
  // procedure
  "objection", "object", "form", "foundation", "exhibit", "mark", "marked", "counsel", "record",
  "strike", "nonresponsive", "deposition", "transcript", "witness", "question", "answer",
  "page", "line", "reporter", "videographer",
  // address and filler
  "sir", "ma'am", "mr", "ms", "mrs", "dr", "yes", "yeah", "okay", "ok", "right", "correct",
  "sure", "uh", "um", "well", "would", "could", "ve", "got", "thing", "things",
] as const;

// Exchanges with at least this many content terms become queries; shorter ones say too little to
// search on, though they can still be found by longer exchanges' queries.
//
// Known limit: two exchanges of exactly two terms each can't find each other, even when both terms
// match. Letting two-term exchanges with two weighted terms query was tried and measured on Ellison
// (docs/agent-log.md): it added about 12 pairs but filled the top 20 with 14 perfect-score follow-up
// fragments ("Of your current products? — Yes."), pushing the best real candidate from rank 3 to 15.
export const MIN_CONTENT_TERMS = 3;

export type ExchangeForRetrieval = {
  kind: "qa" | "colloquy" | "objection" | "exhibit";
  questionText: string;
};

export type ProceduralReason = "not_testimony" | "name_or_address";

// Questions about the witness's identity, not the subject matter.
const NAME_OR_ADDRESS = /\b(state|spell|give us) your (full |complete )?name\b|\byour (home |business |current )?address\b/i;

// Why an exchange is procedural, or null when it is testimony to search. Objection-only, exhibit
// marking and colloquy exchanges are not testimony; nor are questions about name and address.
export function proceduralReason(exchange: ExchangeForRetrieval): ProceduralReason | null {
  if (exchange.kind !== "qa") return "not_testimony";
  if (NAME_OR_ADDRESS.test(exchange.questionText)) return "name_or_address";
  return null;
}
