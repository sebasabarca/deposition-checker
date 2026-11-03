// Speaker attribution, Q/A exchanges and long-answer parts, built from validated source lines.
// Pure: no I/O. Ported from scripts/spike/exchanges.ts, which was reviewed by hand on 52 exchanges.
//
// Source lines stay authoritative. Exchanges and parts only reference lines (by their index in the
// deposition's line list, which becomes a line ID once stored) and say what role each line plays.
// questionText and answerText (retrieval) and dialogueText (model input) are derived from those lines.

import type { LayoutProfile } from "./layout";
import type { SourceLine } from "./pdf";
import type { SpeakerSegment } from "./segments";

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
  segments?: SpeakerSegment[]; // speaker changes inside the line (archive statements only; segments.ts)
};

// A line's role inside an exchange. `unknown` text (after a redaction gap, before any speaker
// marker) is kept but is never treated as the witness's answer.
export type LineRole = "question" | "answer" | "context" | "unknown";
// segments: for a line holding several turns, the range (inclusive) of its segments in this exchange.
// Its role is then the most telling of theirs: answer, then question, then the first segment's.
export type ExchangeLine = { index: number; role: LineRole; segments?: { from: number; to: number } };

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
const QA_MARKER = /^([QA])(?:[._:]|\s|$)/; // OCR can read the space after a marker as "_"; some exports write "Q:"
const ATTORNEY_QUESTION = new RegExp(`^(${NAME}):\\s+Q\\.(?:\\s|$)`);
const WITNESS = /^THE WITNESS:(?:\s|$)/;
const COLLOQUY = new RegExp(`^(${NAME}|THE (?:REPORTER|VIDEOGRAPHER)):`);
const EXAMINER = new RegExp(`^BY (${NAME}):`);
// Congressional transcripts label a turn "Ms. Cheney." at the Q/A indent, with no colon.
const HEARING_LABEL = /^((?:Mr|Ms|Mrs|Dr)\. [A-Z][A-Za-z'-]+)[.,](?:\s|$)/;
// A blacked-out speaker's name reads as stray marks at the start of a turn ("P| Can I ask ..."), or as
// a line of only a character or two ("a" where "BY [redacted]:" stood).
const REDACTED_LABEL = /^(?:[A-Za-z]{0,3}[|\]=~_]+(?:\s|$)|.{1,2}$)/;
// A note closed on its own line, "[2:05 p.m.]" or "(Recess.)": the record's, at whatever indent it sits.
const WHOLE_NOTE = /^(?:\[[^\]]*\]|\([^)]*\))$/;
const OBJECTION = /\bobject(?:ion)?\b/i;
const EXHIBIT = /\bexhibit\b|\bmarked\b/i;

// Characters that differ between two words of similar length, or Infinity when they aren't similar.
function misread(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1 || a[0] !== b[0]) return Infinity;
  const [long, short] = a.length >= b.length ? [a, b] : [b, a];
  let i = 0, j = 0, misses = 0;
  while (i < long.length) {
    if (long[i] === short[j]) { i++; j++; continue; }
    misses++;
    i++;
    if (long.length === short.length) j++;
  }
  return misses;
}

// Who a hearing label names. Anything short of a clean label stays unknown, because the guess would
// decide whether words count as testimony: no known witness, a comma where the period belongs, or a
// surname one or two letters from the witness's, which is OCR noise or a relative.
function hearingTurn(name: string, clean: boolean, witnessSurname?: string): { turn: TurnMarker; name: string | null } {
  const surname = name.split(" ")[1].toLowerCase();
  if (!witnessSurname || !clean) return { turn: "unrecognized", name };
  if (surname === witnessSurname) return { turn: "A", name: null };
  return misread(surname, witnessSurname) <= 2 ? { turn: "unrecognized", name } : { turn: "Q", name };
}

// A whole row that only marks the page: "END PAGE", "END OF PAGE 1 / ...", "PAGE 2", "Page 2 of 9",
// "... | PAGE 2", or an all-capitals heading carried over, "DEPOSITION OF MARA VOSS (continued)". Whole
// rows only, so testimony such as "page 12 of the report says" is never caught.
const PAGE_MARKER = /^(?:end\s+(?:of\s+)?page\b.*|page\s+\d+(?:\s+of\s+\d+)?|.*\|\s*page\s+\d+)$/i;
const CONTINUED_HEADING = /^[A-Z][A-Z .,'-]+\((?:continued|CONTINUED)\)$/;

// Q./A. turn markers are indented less than paragraph and colloquy indents (x ≈ 110–113 against
// 122–125 in the Ellison PDFs); the layout profile holds the threshold between them.
export function markLine(text: string, indentX: number | null, layout: LayoutProfile, witnessSurname?: string, ocr = false): { turn: TurnMarker; name: string | null } {
  const t = text.trim();
  const examiner = t.match(EXAMINER);
  if (examiner) return { turn: "examiner", name: examiner[1] };
  // Before the indent: a centred note ("[2:05 p.m.]") has no turn indent at all.
  if (WHOLE_NOTE.test(t)) return { turn: "parenthetical", name: null };
  if (indentX === null) return { turn: null, name: null };
  const hearing = t.match(HEARING_LABEL);
  const clean = hearing !== null && t.charAt(hearing[1].length) === ".";
  if (hearing && (clean || ocr)) return hearingTurn(hearing[1], clean, witnessSurname); // in a text layer, "Mr. Scott, on behalf of" is a sentence
  if (ocr && !QA_MARKER.test(t) && !t.startsWith("[") && !t.startsWith("(") && REDACTED_LABEL.test(t)) return { turn: "unrecognized", name: null };
  if (indentX < layout.turnIndentMaxX) {
    const qa = t.match(QA_MARKER);
    return { turn: qa ? (qa[1] as "Q" | "A") : null, name: null };
  }
  const attorney = t.match(ATTORNEY_QUESTION);
  if (attorney) return { turn: "Q", name: attorney[1] };
  if (WITNESS.test(t)) return { turn: "A", name: null };
  // A label naming the witness ("O.J. SIMPSON:", as public archives write it) is the witness speaking. Only the
  // known witness's surname, and never a titled label ("MR. ..."), which the hearing rules above decide.
  const named = t.match(ANY_LABEL);
  if (named && witnessSurname && !/^(?:MR|MS|MRS|DR)\.?\s/.test(named[1]) && surnameOf(named[1]) === witnessSurname) return { turn: "A", name: null };
  const colloquy = t.match(COLLOQUY);
  if (colloquy) return { turn: "colloquy", name: colloquy[1] };
  // Parentheses, square brackets ("[EXHIBIT 7 IDENTIFIED]", "[STAMP: ...]") and page markers are the
  // record's notes, not anyone's words.
  if (t.startsWith("(") || t.startsWith("[") || PAGE_MARKER.test(t) || CONTINUED_HEADING.test(t)) return { turn: "parenthetical", name: null };
  const label = t.match(ANY_LABEL);
  // An archive names every speaker: a name that isn't the witness's, nor one or two letters from it, is someone else.
  if (label && layout.namedSpeakers && witnessSurname) {
    const surname = surnameOf(label[1]);
    if (surname !== witnessSurname && misread(surname, witnessSurname) > 2) return { turn: "colloquy", name: label[1] };
  }
  if (label) return { turn: "unrecognized", name: label[1] };
  return { turn: null, name: null };
}

// Consecutive lines on one page, or the last line of a full page followed by line 1 of the next (any
// page, for layouts whose page breaks always continue). Anything else means testimony between the
// two lines was redacted.
export function isContiguous(prev: SourceLine, next: SourceLine, layout: LayoutProfile): boolean {
  if (prev.printedPage === null || next.printedPage === null) return false;
  if (next.printedPage === prev.printedPage) return next.lineNo === prev.lineNo + 1;
  return next.printedPage === prev.printedPage + 1 && next.lineNo === 1 && (layout.pageBreaksContinue === true || prev.lineNo === layout.maxLinesPerPage);
}

const ROLE_OF_TURN: Record<Exclude<TurnMarker, null>, SpeakerRole> = {
  Q: "attorney",
  A: "witness",
  colloquy: "colloquy",
  examiner: "colloquy",
  parenthetical: "parenthetical",
  unrecognized: "unknown",
};

export const surnameOf = (name: string) => name.trim().replace(/,?\s+(?:jr|sr|ii|iii)\.?$/i, "").split(/\s+/).pop()!.toLowerCase();

// An unmarked line continues the previous speaker. After a note that has closed ("[Pause.]", "(Exhibit
// marked.)", "END PAGE"), it continues the speaker from before the note, so the rest of an answer stays
// the witness's; a note still open ("(Whereupon, the" ...) keeps its own continuation lines.
// segment: finds speaker changes inside a line (archive statements; segments.ts); an unmarked line after
// one continues its last segment's speaker.
export type Segmenter = (text: string, witnessSurname?: string) => SpeakerSegment[];
export function attributeSpeakers(lines: SourceLine[], layout: LayoutProfile, witnessSurname?: string, segment?: Segmenter): AttributedLine[] {
  const result: AttributedLine[] = [];
  let noteOpen = false;
  let speaker: AttributedLine | null = null; // the last line that wasn't a note, with nothing redacted since
  lines.forEach((line, index) => {
    const { turn, name } = markLine(line.rawText, line.indentX, layout, witnessSurname, line.ocrConfidence !== undefined);
    const previous = result[index - 1];
    const continuesTurn = previous !== undefined && isContiguous(lines[index - 1], line, layout);
    if (!continuesTurn) speaker = null;
    const before = previous?.role === "parenthetical" && !noteOpen && speaker ? speaker : previous;
    const tail = before?.segments?.at(-1);
    const from = tail ? { role: tail.role, speakerName: tail.name } : before;
    let attributed: AttributedLine;
    if (turn !== null) {
      attributed = { ...line, index, turn, role: ROLE_OF_TURN[turn], speakerName: name };
    } else if (continuesTurn) {
      attributed = { ...line, index, turn, role: from.role, speakerName: from.speakerName };
    } else {
      // First line, or the first line after a redaction gap, with no speaker marker.
      attributed = { ...line, index, turn, role: "unknown", speakerName: null };
    }
    const segments = segment?.(line.rawText, witnessSurname);
    if (segments?.length) attributed.segments = segments;
    result.push(attributed);
    const text = line.rawText.trim();
    if (attributed.role !== "parenthetical") {
      noteOpen = false;
      speaker = attributed;
    } else noteOpen = (turn === null ? noteOpen : /^[([]/.test(text)) && !/[)\]]$/.test(text);
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

// Every role a member plays: its segments' roles for a line holding several turns, else its own.
export function rolesOf(lines: readonly AttributedLine[], m: ExchangeLine): LineRole[] {
  const segs = lines[m.index].segments;
  return segs && m.segments ? segs.slice(m.segments.from, m.segments.to + 1).map((s) => LINE_ROLE[s.role]) : [m.role];
}
const primaryRole = (roles: LineRole[]): LineRole => (roles.includes("answer") ? "answer" : roles.includes("question") ? "question" : roles[0]);
const isExaminerHeading = (text: string) => /^BY\s/.test(text);

export function buildExchanges(lines: AttributedLine[], layout: LayoutProfile): Exchange[] {
  const exchanges: Exchange[] = [];
  let current: { members: ExchangeLine[]; startsAfterGap: boolean } | null = null;

  const close = (endsAtGap: boolean) => {
    if (!current) return;
    const members = current.members;
    const has = (role: LineRole) => members.some((m) => rolesOf(lines, m).includes(role));
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
    const segs = line.segments;
    if (!segs?.length) {
      current!.members.push({ index: line.index, role: LINE_ROLE[line.role] });
      return;
    }
    // A line holding several turns: a new question (or examiner) inside it starts a new exchange, the
    // same rule as between lines, so "A: Yes. Q. Where?" ends one exchange and starts the next. The
    // line belongs to both, each with only its own segments; its text and reference stay one line.
    const push = (from: number, to: number) => {
      const window = { from, to };
      current!.members.push({ index: line.index, role: primaryRole(rolesOf(lines, { index: line.index, role: "unknown", segments: window })), segments: window });
    };
    let qa = current!.members.some((m) => rolesOf(lines, m).some((r) => r === "question" || r === "answer"));
    let from = 0;
    segs.forEach((s, k) => {
      if (k > 0 && (isExaminerHeading(line.rawText.slice(s.start, s.end)) || (s.role === "attorney" && qa))) {
        push(from, k - 1);
        close(false);
        current = { members: [], startsAfterGap: false };
        from = k;
        qa = false;
      }
      if (s.role === "attorney" || s.role === "witness") qa = true;
    });
    push(from, segs.length - 1);
  });
  close(true);

  return exchanges;
}

function stripMarker(text: string): string {
  return text
    .trim()
    .replace(WITNESS, "")
    .replace(HEARING_LABEL, "")
    .replace(new RegExp(`^(?:${NAME}:\\s+)?[QA](?:[._]|\\s)\\s*`), "")
    .trim();
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
const TURN_OF_ROLE: Record<SpeakerRole, TurnMarker> = { attorney: "Q", witness: "A", colloquy: "colloquy", parenthetical: "parenthetical", unknown: "unrecognized" };

// A member as the lines its turns are read from: a line holding several turns gives one per segment
// in this exchange, each read as if it were a line of its own.
function turnLines(lines: AttributedLine[], m: ExchangeLine): AttributedLine[] {
  const line = lines[m.index];
  if (!line.segments || !m.segments) return [line];
  return line.segments.slice(m.segments.from, m.segments.to + 1).map((s) => {
    const rawText = line.rawText.slice(s.start, s.end);
    return { ...line, rawText, role: s.role, speakerName: s.name, turn: isExaminerHeading(rawText) ? "examiner" : TURN_OF_ROLE[s.role], segments: undefined };
  });
}

function turnsOf(lines: AttributedLine[], members: ExchangeLine[]): (DerivedTurn | "gap")[] {
  const turns: (DerivedTurn | "gap")[] = [];
  let current: DerivedTurn | null = null;
  let currentName: string | null = null;
  members.forEach((m, i) => {
    const jump = i > 0 && m.index !== members[i - 1].index + 1;
    if (jump) turns.push("gap");
    for (const line of turnLines(lines, m)) {
      if (!current || jump || line.turn !== null || line.role !== current.role || line.speakerName !== currentName) {
        current = { role: line.role, label: labelOf(line), text: turnText(line) };
        currentName = line.speakerName;
        turns.push(current);
      } else {
        // A turn whose first line was only a label ("THE WITNESS:") starts with empty text.
        current.text = current.text ? `${current.text} ${line.rawText.trim()}` : line.rawText.trim();
      }
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
  const questionMembers = members.filter((m) => rolesOf(lines, m).includes("question"));

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

    const answerMembers = partMembers.filter((m) => rolesOf(lines, m).includes("answer"));
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

export function buildExchangeParts(sourceLines: SourceLine[], layout: LayoutProfile, witnessSurname?: string, segment?: Segmenter): ExchangeResult {
  const lines = attributeSpeakers(sourceLines, layout, witnessSurname, segment);
  const exchanges = buildExchanges(lines, layout);
  return { lines, exchanges, parts: exchanges.flatMap((e) => splitExchange(e, lines)) };
}
