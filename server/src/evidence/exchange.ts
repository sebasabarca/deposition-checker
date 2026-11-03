// The Stage 1 evidence fields of one Q/A exchange, from its source lines alone. Pure: no I/O, no model.
// The same functions run at ingestion (ingest/rows.ts) and when indexing exchanges stored before these
// fields existed (store.ts), so both give the same key, hash and status for the same lines.

import { createHash } from "node:crypto";

export const SPEAKER_STATUSES = ["verified", "uncertain", "invalid"] as const;
export type SpeakerStatus = (typeof SPEAKER_STATUSES)[number];

// One member line of an exchange: where it is, its stored text, its role in the exchange, who the reader
// attributed it to, and the speaker segments of a line that holds more than one turn (ingest/segments.ts).
export type MemberSegment = { role: string; start: number; end: number };
export type MemberLine = { page: number; line: number; text: string; lineRole: string; speakerRole: string; segments?: readonly MemberSegment[] };

// What each speaker said in the exchange: a whole line, or each segment of a line that holds several turns.
// answer: words the witness said (a segmented line's witness segments, wherever the line sits, or an
// answer line's whole text); question: an attorney's (a question line, or a segmented line's attorney segments).
export type Piece = { text: string; speaker: string; answer: boolean; question: boolean; segmented: boolean };
export function piecesOf(members: readonly MemberLine[]): Piece[] {
  return members.flatMap((m): Piece[] => {
    if (!m.segments?.length) return [{ text: m.text, speaker: m.speakerRole, answer: m.lineRole === "answer", question: m.lineRole === "question", segmented: false }];
    return m.segments.map((s) => ({ text: m.text.slice(s.start, s.end), speaker: s.role, answer: s.role === "witness", question: s.role === "attorney", segmented: true }));
  });
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// Stable across re-ingestion of the same file: the file's SHA-256 and the exchange's first and last
// stored positions. A parser change that moves an exchange's boundaries gives it a new key, as it should.
export const evidenceKeyOf = (fileSha256: string, first: { page: number; line: number }, last: { page: number; line: number }) =>
  `ex_${sha256(`${fileSha256}|${first.page}:${first.line}|${last.page}:${last.line}`).slice(0, 24)}`;

// Of the exchange's stored lines, in order, with their positions: any change to the evidence changes it.
export const textHashOf = (members: readonly MemberLine[]) => sha256(members.map((m) => `${m.page}:${m.line}\t${m.text}`).join("\n"));

// Whether the answer is reliably the witness's, from the reader's line roles. verified: every answer line
// is the witness's and nothing in the exchange is unattributed. uncertain: some of it has no identified
// speaker. invalid: no answer, or answer lines attributed to someone else. Never raised by anything else:
// a status can only be recomputed from the lines, so an uncertain or invalid answer stays so.
export function speakerStatusOf(kind: string, members: readonly MemberLine[]): { status: SpeakerStatus; reasons: string[] } {
  if (kind !== "qa") return { status: "invalid", reasons: [`a ${kind} exchange, not a question and answer`] };
  const pieces = piecesOf(members);
  const answers = pieces.filter((p) => p.answer);
  const unknown = members.some((m) => m.lineRole === "unknown") || pieces.some((p) => p.speaker === "unknown");
  // Text no speaker could be found for may still be the witness's: uncertain, never invalid or verified.
  if (answers.length === 0) return unknown ? { status: "uncertain", reasons: ["no identified answer: its lines have no identified speaker"] } : { status: "invalid", reasons: ["no answer lines"] };
  // A whole answer line attributed to someone else is an attribution error, not testimony. (A segmented
  // line's other speakers are separated from its answer, so they don't count here.)
  const notWitness = answers.filter((p) => !p.segmented && p.speaker !== "witness" && p.speaker !== "unknown");
  if (notWitness.length > 0) return { status: "invalid", reasons: [`answer lines attributed to ${[...new Set(notWitness.map((p) => p.speaker))].join(", ")}`] };
  const reasons: string[] = [];
  if (answers.some((p) => p.speaker === "unknown")) reasons.push("an answer line has no identified speaker");
  if (unknown && !reasons.length) reasons.push("the exchange holds lines with no identified speaker");
  return reasons.length > 0 ? { status: "uncertain", reasons } : { status: "verified", reasons: [] };
}

export function evidenceFieldsOf(fileSha256: string, kind: string, members: readonly MemberLine[]) {
  if (members.length === 0) throw new Error("an exchange with no lines can't be indexed");
  const ordered = [...members].sort((x, y) => x.page - y.page || x.line - y.line);
  return { evidenceKey: evidenceKeyOf(fileSha256, ordered[0], ordered[ordered.length - 1]), textHash: textHashOf(ordered), speakerStatus: speakerStatusOf(kind, ordered).status };
}
