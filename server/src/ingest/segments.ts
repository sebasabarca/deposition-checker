// Speaker changes inside one archive statement. Public archive exports sometimes run two turns into one
// numbered statement: "Q: … drove up in? A.Yes, I do." The statement stays one source line with its
// text untouched; its segments are character ranges of that text, each with the speaker its label names.
// Pure. Archive format only (TEXT_ARCHIVE_V1), where every turn starts with a label, so a label is
// recognized only after a sentence ends, never inside quotes or parentheses (a read-back of earlier
// testimony), and never inside the statement's own leading label ("MR. ROBERT BAKER:").

import { markLine } from "./exchanges";
import type { SpeakerRole } from "./exchanges";
import type { LayoutProfile } from "./layout";

export type SpeakerSegment = { start: number; end: number; role: SpeakerRole; name: string | null };

const TITLE = String.raw`(?:MR|MS|MRS|DR)\s?\.?\s?`;
const WORD = String.raw`[A-Z][A-Za-z'-]+`;
const CAPS = String.raw`[A-Z][A-Z.'-]+`;
// The label a statement opens with, consumed whole so a name inside it is never read as a second label.
const LEADING = new RegExp(String.raw`^(?:[QA][:.]|(?:BY\s)?${TITLE}${WORD}(?:\s${WORD}){0,2}:|THE\s[A-Z]+:|${CAPS}(?:\s${CAPS}){0,3}:)`);
// A label that starts a new turn: Q:/A:, "Q. " before a capital, "A." before a capitalized word (never
// initials such as "A.C."), a titled or examiner's name, THE WITNESS-style labels, or two to four
// capitalized words, each followed by a colon.
const LABEL = new RegExp(String.raw`(?:[QA]:\s|Q\.\s+[A-Z]|A\.\s?[A-Z][a-z]|(?:BY\s)?${TITLE}${WORD}(?:\s${WORD}){0,2}:(?:\s|$)|THE\s(?:WITNESS|REPORTER|VIDEOGRAPHER|COURT):(?:\s|$)|${CAPS}(?:\s${CAPS}){1,3}:(?:\s|$))`, "y");
// What may end the text before a new turn: a sentence's end, a dash, a closing quote or bracket, or a label's colon.
const ENDS_TURN = /[.?!"')\-:]$/;

// "MR . KELLY" and "MR MARKS" are "MR. KELLY" and "MR. MARKS": spelled out for the classifier only.
const normalized = (label: string) => label.replace(/^(BY\s)?(MR|MS|MRS|DR)\s?\.?\s?/, (_m, by: string | undefined, title: string) => `${by ?? ""}${title}. `);

// The archive layout's own label rules (text.ts), given here to keep this module free of an import cycle.
const ARCHIVE_LABELS = { turnIndentMaxX: 50, namedSpeakers: true } as LayoutProfile;

function roleOf(text: string, witnessSurname?: string): { role: SpeakerRole; name: string | null } {
  const t = normalized(text);
  const { turn, name } = markLine(t, /^[QA](?:[._:]|\s|$)/.test(t) ? 0 : 100, ARCHIVE_LABELS, witnessSurname);
  // "BY MR. KELLY: That she had?": the examiner's label with words after it is the examiner asking.
  if (turn === "examiner" && /:\s*\S/.test(t)) return { role: "attorney", name };
  const role: SpeakerRole = turn === "Q" ? "attorney" : turn === "A" ? "witness" : turn === "colloquy" || turn === "examiner" ? "colloquy" : turn === "parenthetical" ? "parenthetical" : "unknown";
  return { role, name };
}

// The statement's segments, or [] when it holds one turn only.
export function speakerSegments(text: string, witnessSurname?: string): SpeakerSegment[] {
  const lead = text.match(LEADING);
  const starts = [0];
  let quotes = 0;
  let parens = 0;
  for (let i = lead ? lead[0].length : 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quotes++;
    else if (c === "(") parens++;
    else if (c === ")") parens = Math.max(0, parens - 1);
    if (!/\s/.test(c) || quotes % 2 === 1 || parens > 0) continue;
    const at = i + text.slice(i).match(/^\s+/)![0].length;
    LABEL.lastIndex = at;
    if (at < text.length && ENDS_TURN.test(text.slice(0, i).trimEnd()) && LABEL.test(text)) {
      starts.push(at);
      i = at; // a new label: skip past its own text before looking again
      const own = text.slice(at).match(LEADING);
      if (own) i = at + own[0].length - 1;
    }
  }
  if (starts.length < 2) return [];
  return starts.map((start, k) => {
    const end = k + 1 < starts.length ? start + text.slice(start, starts[k + 1]).trimEnd().length : text.length;
    return { start, end, ...roleOf(text.slice(start, end), witnessSurname) };
  });
}
