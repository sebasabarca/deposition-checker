// Speaker attribution, Q/A exchanges and long-answer parts, built from validated source lines.
// Pure: no I/O. Ported from scripts/spike/exchanges.ts, which was reviewed by hand on 52 exchanges.
//
// Source lines stay authoritative. Exchanges and parts only reference lines (by their index in the
// deposition's line list, which becomes a line ID once stored) and say what role each line plays.
// questionText and answerText (retrieval) and dialogueText (model input) are derived from those lines.

import type { LayoutProfile } from "./layout";
import type { SourceLine } from "./pdf";

export const MAX_ANSWER_LINES = 40;
export const ANSWER_OVERLAP_LINES = 5;

export type TurnMarker =
  | "Q" // the examining attorney's question, including "MR. SCOTT: Q. ..." after colloquy
  | "A" // the witness's answer, including the witness speaking as "THE WITNESS: ..."
  | "colloquy" // "MR. RILL: I'm going to object ...", "THE REPORTER: ..."
  | "examiner" // "BY MR. SCOTT:" — a new examining attorney takes over
  | "parenthetical" // "(Marked Deposition Exhibit No. 17)"
  | "unrecognized" // an explicit "SPEAKER:" label we don't know, e.g. "COURT REPORTER:"
  | null; // continues the current turn

export type SpeakerRole = "attorney" | "witness" | "colloquy" | "parenthetical" | "unknown";

export type AttributedLine = SourceLine & {
  index: number; // position in the deposition's line list; becomes the line's ID once stored
  turn: TurnMarker;
  role: SpeakerRole;
  speakerName: string | null; // when the transcript names the speaker: "MR. RILL", "MR. SCOTT"
};

// A line's role inside an exchange. `unknown` text (after a redaction gap, before any speaker
// marker) is kept but is never treated as the witness's answer.
export type LineRole = "question" | "answer" | "context" | "unknown";
export type ExchangeLine = { index: number; role: LineRole };

export type ExchangeKind = "qa" | "colloquy" | "objection" | "exhibit";
export type ExchangeFlag = "starts_mid_turn" | "ends_at_gap" | "no_answer" | "no_question";

export type Exchange = {
  groupNo: number; // 1-based; shared by every part of the exchange
  kind: ExchangeKind;
  flags: ExchangeFlag[];
  lines: ExchangeLine[]; // every line of the exchange, in source order
};

export type LineRange = { first: number; last: number }; // line indexes, inclusive

export type ExchangePart = {
  groupNo: number;
  partNo: number;
  partCount: number;
  kind: ExchangeKind;
  flags: ExchangeFlag[];
  lines: ExchangeLine[]; // exact membership; ranges below are endpoints only, not "every line between"
  span: LineRange;
  question: LineRange | null;
  answer: LineRange | null;
  answerLineCount: number;
} & DerivedText;

// Surnames may have several words: "MR. VAN DYKE", "MS. DE LA CRUZ".
const NAME = String.raw`(?:MR|MS|MRS|DR)\. [A-Z][A-Za-z'-]+(?: [A-Z][A-Za-z'-]+)*`;
// Any all-caps label followed by a colon. Checked after the known labels, so whatever it catches is
// a speaker we can't identify; it must never inherit the previous speaker (often the witness).
// Lines are trimmed before matching, so a label alone on its line ends at the colon: every label
// pattern accepts end-of-line as well as whitespace after it.
const ANY_LABEL = /^([A-Z][A-Z.'-]*(?: [A-Z][A-Z.'-]*)*):(?:\s|$)/;
const QA_MARKER = /^([QA])(?:\.|\s|$)/;
const ATTORNEY_QUESTION = new RegExp(`^(${NAME}):\\s+Q\\.(?:\\s|$)`);
const WITNESS = /^THE WITNESS:(?:\s|$)/;
const COLLOQUY = new RegExp(`^(${NAME}|THE (?:REPORTER|VIDEOGRAPHER)):`);
const EXAMINER = new RegExp(`^BY (${NAME}):`);
const OBJECTION = /\bobject(?:ion)?\b/i;
const EXHIBIT = /\bexhibit\b|\bmarked\b/i;

// Q./A. turn markers are indented less than paragraph and colloquy indents (x ≈ 110–113 against
// 122–125 in the Ellison PDFs); the layout profile holds the threshold between them.
export function markLine(text: string, indentX: number | null, layout: LayoutProfile): { turn: TurnMarker; name: string | null } {
  const t = text.trim();
  const examiner = t.match(EXAMINER);
  if (examiner) return { turn: "examiner", name: examiner[1] };
  if (indentX === null) return { turn: null, name: null };
  if (indentX < layout.turnIndentMaxX) {
    const qa = t.match(QA_MARKER);
    return { turn: qa ? (qa[1] as "Q" | "A") : null, name: null };
  }
  const attorney = t.match(ATTORNEY_QUESTION);
  if (attorney) return { turn: "Q", name: attorney[1] };
  if (WITNESS.test(t)) return { turn: "A", name: null };
  const colloquy = t.match(COLLOQUY);
  if (colloquy) return { turn: "colloquy", name: colloquy[1] };
  if (t.startsWith("(")) return { turn: "parenthetical", name: null };
  const label = t.match(ANY_LABEL);
  if (label) return { turn: "unrecognized", name: label[1] };
  return { turn: null, name: null };
}

// Consecutive lines on one page, or the last line of a full page followed by line 1 of the next.
// Anything else means testimony between the two lines was redacted.
export function isContiguous(prev: SourceLine, next: SourceLine, layout: LayoutProfile): boolean {
  if (prev.printedPage === null || next.printedPage === null) return false;
  if (next.printedPage === prev.printedPage) return next.lineNo === prev.lineNo + 1;
  return next.printedPage === prev.printedPage + 1 && next.lineNo === 1 && prev.lineNo === layout.maxLinesPerPage;
}

const ROLE_OF_TURN: Record<Exclude<TurnMarker, null>, SpeakerRole> = {
  Q: "attorney",
  A: "witness",
  colloquy: "colloquy",
  examiner: "colloquy",
  parenthetical: "parenthetical",
  unrecognized: "unknown",
};

export function attributeSpeakers(lines: SourceLine[], layout: LayoutProfile): AttributedLine[] {
  const result: AttributedLine[] = [];
  lines.forEach((line, index) => {
    const { turn, name } = markLine(line.rawText, line.indentX, layout);
    const previous = result[index - 1];
    const continuesTurn = previous !== undefined && isContiguous(lines[index - 1], line, layout);
    if (turn !== null) {
      result.push({ ...line, index, turn, role: ROLE_OF_TURN[turn], speakerName: name });
    } else if (continuesTurn) {
      result.push({ ...line, index, turn, role: previous.role, speakerName: previous.speakerName });
    } else {
      // First line, or the first line after a redaction gap, with no speaker marker.
      result.push({ ...line, index, turn, role: "unknown", speakerName: null });
    }
  });
  return result;
}

const LINE_ROLE: Record<SpeakerRole, LineRole> = {
  attorney: "question",
  witness: "answer",
  colloquy: "context",
  parenthetical: "context",
  unknown: "unknown",
};

export function buildExchanges(lines: AttributedLine[], layout: LayoutProfile): Exchange[] {
  const exchanges: Exchange[] = [];
  let current: { members: ExchangeLine[]; startsAfterGap: boolean } | null = null;

  const close = (endsAtGap: boolean) => {
    if (!current) return;
    const members = current.members;
    const has = (role: LineRole) => members.some((m) => m.role === role);
    const contextText = members
      .filter((m) => m.role === "context")
      .map((m) => lines[m.index].rawText)
      .join(" ");
    // A fragment after a redaction gap is testimony from an unknown speaker, not colloquy.
    const kind: ExchangeKind =
      has("question") || has("answer") || has("unknown")
        ? "qa"
        : OBJECTION.test(contextText)
          ? "objection"
          : EXHIBIT.test(contextText)
            ? "exhibit"
            : "colloquy";

    const flags: ExchangeFlag[] = [];
    if (current.startsAfterGap && members[0].role === "unknown") flags.push("starts_mid_turn");
    if (endsAtGap) flags.push("ends_at_gap");
    if (has("question") && !has("answer")) flags.push("no_answer");
    if (has("answer") && !has("question")) flags.push("no_question");

    exchanges.push({ groupNo: exchanges.length + 1, kind, flags, lines: members });
    current = null;
  };

  lines.forEach((line, i) => {
    const gap = i > 0 && !isContiguous(lines[i - 1], line, layout);
    if (gap) close(true);

    const startsNew =
      !current ||
      line.turn === "examiner" ||
      (line.turn === "Q" && current.members.some((m) => m.role === "question" || m.role === "answer"));
    if (startsNew) {
      close(false);
      current = { members: [], startsAfterGap: gap || i === 0 };
    }
    current!.members.push({ index: line.index, role: LINE_ROLE[line.role] });
  });
  close(true);

  return exchanges;
}

function stripMarker(text: string): string {
  return text
    .trim()
    .replace(WITNESS, "")
    .replace(new RegExp(`^(?:${NAME}:\\s+)?[QA](?:\\.|\\s)\\s*`), "");
}

type DerivedTurn = { role: SpeakerRole; label: string; text: string };

function labelOf(line: AttributedLine): string {
  if (line.role === "attorney") return line.speakerName ? `Q (${line.speakerName})` : "Q";
  if (line.role === "witness") return "A";
  if (line.role === "colloquy" && line.turn !== "examiner" && line.speakerName) return line.speakerName;
  if (line.role === "unknown") return "UNKNOWN SPEAKER";
  return "NOTE"; // parentheticals and "BY MR. SCOTT:" headings
}

// The first line of a turn loses the marker its label replaces ("Q.", "A.", "THE WITNESS:",
// "MR. RILL:"). Unknown-speaker and note lines keep their text as printed.
function turnText(line: AttributedLine): string {
  const t = line.rawText.trim();
  if (line.turn === null) return t;
  if (line.role === "attorney" || line.role === "witness") return stripMarker(t);
  if (line.role === "colloquy" && line.turn === "colloquy") return t.replace(COLLOQUY, "").trim();
  return t;
}

// Groups a part's lines into speaker turns, in source order. A new turn starts at every speaker
// marker, at a change of speaker, and after a jump in line numbers (a later part of a split answer
// resuming after the question), which is shown as "[…]".
function turnsOf(lines: AttributedLine[], members: ExchangeLine[]): (DerivedTurn | "gap")[] {
  const turns: (DerivedTurn | "gap")[] = [];
  let current: DerivedTurn | null = null;
  members.forEach((m, i) => {
    const line = lines[m.index];
    const jump = i > 0 && m.index !== members[i - 1].index + 1;
    if (jump) turns.push("gap");
    if (!current || jump || line.turn !== null || line.role !== current.role || line.speakerName !== lines[members[i - 1].index].speakerName) {
      current = { role: line.role, label: labelOf(line), text: turnText(line) };
      turns.push(current);
    } else {
      // A turn whose first line was only a label ("THE WITNESS:") starts with empty text.
      current.text = current.text ? `${current.text} ${line.rawText.trim()}` : line.rawText.trim();
    }
  });
  return turns;
}

export type DerivedText = {
  questionText: string; // attorney question turns, one per line (retrieval)
  answerText: string; // witness turns, one per line, never merged across an interruption (retrieval)
  dialogueText: string; // every turn in order, labelled by speaker (model input)
};

// Derived text for retrieval and model input. The source lines are never changed and remain the
// only text shown as evidence.
export function deriveTexts(lines: AttributedLine[], members: ExchangeLine[]): DerivedText {
  const turns = turnsOf(lines, members);
  const spoken = turns.filter((t): t is DerivedTurn => t !== "gap");
  return {
    questionText: spoken.filter((t) => t.role === "attorney").map((t) => t.text).join("\n"),
    answerText: spoken.filter((t) => t.role === "witness").map((t) => t.text).join("\n"),
    dialogueText: turns.map((t) => (t === "gap" ? "[…]" : `${t.label}: ${t.text}`)).join("\n"),
  };
}

const range = (members: ExchangeLine[]): LineRange | null =>
  members.length === 0 ? null : { first: members[0].index, last: members[members.length - 1].index };

// Splits an exchange whose witness answer runs past MAX_ANSWER_LINES into parts of 40 answer lines,
// consecutive parts sharing 5. Only answer lines count. Every part carries the full question, and
// context lines (objections, colloquy) stay in the part whose answer lines surround them.
export function splitExchange(exchange: Exchange, lines: AttributedLine[]): ExchangePart[] {
  const members = exchange.lines;
  const answerPositions = members.flatMap((m, position) => (m.role === "answer" ? [position] : []));
  const questionMembers = members.filter((m) => m.role === "question");

  const windows: [number, number][] = []; // inclusive ranges into answerPositions
  if (answerPositions.length <= MAX_ANSWER_LINES) {
    windows.push([0, answerPositions.length - 1]);
  } else {
    for (let start = 0; ; start += MAX_ANSWER_LINES - ANSWER_OVERLAP_LINES) {
      const end = Math.min(start + MAX_ANSWER_LINES, answerPositions.length) - 1;
      windows.push([start, end]);
      if (end === answerPositions.length - 1) break;
    }
  }

  return windows.map(([start, end], k) => {
    const isFirst = k === 0;
    const isLast = k === windows.length - 1;
    const from = isFirst ? 0 : answerPositions[start];
    const to = isLast ? members.length - 1 : answerPositions[end];
    const slice = members.slice(from, to + 1);
    const partMembers = isFirst ? slice : [...questionMembers.filter((q) => !slice.includes(q)), ...slice];
    partMembers.sort((a, b) => a.index - b.index);

    const answerMembers = partMembers.filter((m) => m.role === "answer");
    return {
      groupNo: exchange.groupNo,
      partNo: k + 1,
      partCount: windows.length,
      kind: exchange.kind,
      flags: exchange.flags,
      lines: partMembers,
      span: range(partMembers)!,
      question: range(questionMembers),
      answer: range(answerMembers),
      answerLineCount: answerMembers.length,
      ...deriveTexts(lines, partMembers),
    };
  });
}

export type ExchangeResult = { lines: AttributedLine[]; exchanges: Exchange[]; parts: ExchangePart[] };

export function buildExchangeParts(sourceLines: SourceLine[], layout: LayoutProfile): ExchangeResult {
  const lines = attributeSpeakers(sourceLines, layout);
  const exchanges = buildExchanges(lines, layout);
  return { lines, exchanges, parts: exchanges.flatMap((e) => splitExchange(e, lines)) };
}
