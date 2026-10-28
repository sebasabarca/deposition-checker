// Rebuilds question/answer exchanges from page:line source lines.
// An exchange is a question, its answer, and any objections or colloquy before the next question.
// Exchanges cross page breaks, but never a redaction gap (a jump in page:line), because the
// testimony between the two sides of a gap is missing.

export type TurnMarker =
  | "Q" // examining attorney's question
  | "A" // witness's answer, including the witness speaking as "THE WITNESS:"
  | "speaker" // colloquy: "MR. RILL: I'm going to object ...", "MR. WALL: \"The market\" defined as what?"
  | "examiner" // "BY MR. SCOTT:" — a new examining attorney takes over
  | "parenthetical" // "(Marked Deposition Exhibit No. 17)"
  | null; // continues the current turn (including a new paragraph by the same speaker)

export type MarkedLine = { page: number; line: number; text: string; turn: TurnMarker };

export type Turn = { marker: Exclude<TurnMarker, null> | "continuation"; first: number; last: number };

export type Exchange = {
  id: string;
  kind: "qa" | "colloquy" | "objection" | "exhibit";
  start: { page: number; line: number };
  end: { page: number; line: number };
  lineIndexes: [number, number]; // inclusive range into the input lines
  turns: Turn[];
  question: string;
  answer: string;
  pages: number; // how many printed pages the exchange touches
  flags: ("starts_mid_turn" | "ends_at_gap" | "no_answer" | "no_question")[];
};

// P3171 layout: Q./A. markers are indented to x ≈ 110–113, paragraph and colloquy indents to x ≈ 122–125.
// The threshold sits between the two clusters. It is document-specific; production ingestion
// would derive it per document from the indent histogram.
const TURN_INDENT_MAX_X = 118;
const QA_MARKER = /^([QA])(?:\.|\s|$)/;
const SPEAKER = /^(?:MR|MS|MRS|DR)\. [A-Z][A-Za-z'-]+:|^THE (?:REPORTER|VIDEOGRAPHER):/;
// The witness speaking on the record during colloquy ("THE WITNESS: They are probably slightly larger...")
// is testimony, so it is an answer turn, not colloquy.
const WITNESS = /^THE WITNESS:\s/;
// After colloquy the examining attorney resumes with "MR. SCOTT: Q. ...", which is a question, not colloquy.
const ATTORNEY_QUESTION = /^(?:MR|MS|MRS|DR)\. [A-Z][A-Za-z'-]+:\s+Q\.\s/;
const EXAMINER = /^BY (?:MR|MS|MRS|DR)\. [A-Z][A-Za-z'-]+:/;
const OBJECTION = /\bobject(?:ion)?\b/i;
const EXHIBIT = /\bexhibit\b|\bmarked\b/i;

export function markPdfLine(text: string, indentX: number | null): TurnMarker {
  const t = text.trim();
  if (EXAMINER.test(t)) return "examiner";
  if (indentX === null) return null;
  if (indentX < TURN_INDENT_MAX_X) {
    const qa = t.match(QA_MARKER);
    return qa ? (qa[1] as "Q" | "A") : null;
  }
  if (ATTORNEY_QUESTION.test(t)) return "Q";
  if (WITNESS.test(t)) return "A";
  if (SPEAKER.test(t)) return "speaker";
  if (t.startsWith("(")) return "parenthetical";
  return null;
}

// The HTML has no coordinates, only leading spaces: 3 for a Q/A turn, 9–10 for a paragraph or colloquy,
// though not consistently. Used only to cross-check the PDF's turn boundaries.
export function markHtmlLine(text: string): TurnMarker {
  const lead = text.match(/^[ \t]*/)![0].length;
  const t = text.trim();
  if (EXAMINER.test(t)) return "examiner";
  if (ATTORNEY_QUESTION.test(t)) return "Q";
  if (WITNESS.test(t)) return "A";
  if (SPEAKER.test(t)) return "speaker";
  if (t.startsWith("(")) return "parenthetical";
  const qa = t.match(/^([QA])(?:\.|\t|\s{2,})/);
  if (qa && lead < 8) return qa[1] as "Q" | "A";
  return null;
}

// Consecutive lines on one page, or the last line of a full page followed by line 1 of the next.
// Anything else means testimony between the two lines was redacted.
export function isContiguous(prev: MarkedLine, next: MarkedLine, linesPerPage: number): boolean {
  if (next.page === prev.page) return next.line === prev.line + 1;
  return next.page === prev.page + 1 && next.line === 1 && prev.line === linesPerPage;
}

function stripMarker(text: string): string {
  return text
    .trim()
    .replace(/^THE WITNESS:\s+/, "")
    .replace(/^(?:(?:MR|MS|MRS|DR)\. [A-Z][A-Za-z'-]+:\s+)?[QA](?:\.|\s)\s*/, "");
}

export function buildExchanges(lines: MarkedLine[], prefix: string): Exchange[] {
  const exchanges: Exchange[] = [];
  let current: { from: number; turns: Turn[]; startsAfterGap: boolean } | null = null;
  // The page length is read from the data (22 in P3171), so a page that ends early counts as a gap.
  const linesPerPage = Math.max(...lines.map((l) => l.line));

  const close = (to: number, endsAtGap: boolean) => {
    if (!current) return;
    const turns = current.turns;
    const text = (marker: "Q" | "A") =>
      turns
        .filter((t) => t.marker === marker)
        .map((t) => lines.slice(t.first, t.last + 1).map((l, i) => (i === 0 ? stripMarker(l.text) : l.text.trim())).join(" "))
        .join(" ");
    const has = (m: Turn["marker"]) => turns.some((t) => t.marker === m);
    const colloquy = turns.filter((t) => t.marker === "speaker" || t.marker === "parenthetical");
    const colloquyText = colloquy.map((t) => lines.slice(t.first, t.last + 1).map((l) => l.text).join(" ")).join(" ");
    // A fragment that starts mid-turn after a redaction gap is testimony from an unknown speaker, not colloquy.
    const kind: Exchange["kind"] =
      has("Q") || has("A") || has("continuation") ? "qa" : OBJECTION.test(colloquyText) ? "objection" : EXHIBIT.test(colloquyText) ? "exhibit" : "colloquy";

    const flags: Exchange["flags"] = [];
    if (current.startsAfterGap && turns[0].marker === "continuation") flags.push("starts_mid_turn");
    if (endsAtGap) flags.push("ends_at_gap");
    if (has("Q") && !has("A")) flags.push("no_answer");
    if (has("A") && !has("Q")) flags.push("no_question");

    const first = lines[current.from];
    const last = lines[to];
    exchanges.push({
      id: `${prefix}-${exchanges.length + 1}`,
      kind,
      start: { page: first.page, line: first.line },
      end: { page: last.page, line: last.line },
      lineIndexes: [current.from, to],
      turns,
      question: text("Q"),
      answer: text("A"),
      pages: last.page - first.page + 1,
      flags,
    });
    current = null;
  };

  lines.forEach((l, i) => {
    const gap = i > 0 && !isContiguous(lines[i - 1], l, linesPerPage);
    if (gap) close(i - 1, true);

    const startsNew =
      !current ||
      l.turn === "examiner" ||
      (l.turn === "Q" && current.turns.some((t) => t.marker === "Q" || t.marker === "A"));
    if (startsNew) {
      close(i - 1, false);
      current = { from: i, turns: [], startsAfterGap: gap || i === 0 };
    }

    const turns = current!.turns;
    if (l.turn === null && turns.length > 0) turns[turns.length - 1].last = i;
    else turns.push({ marker: l.turn ?? "continuation", first: i, last: i });
  });
  close(lines.length - 1, true);

  return exchanges;
}
