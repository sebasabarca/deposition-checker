// Hand-built SYNTHETIC documents for the Stage 2 tests: invented speakers and testimony.
import type { StoredDocument, StoredMember, StoredPart } from "../../server/src/claims/facts";

type Line = string | { text: string; role?: string; speaker?: string; segments?: { at: string; role: string }[] };

// A line written "Q: …" or "A: …" is a question or answer line; "MR. X: …" counsel; anything else
// continues the line before. segments: the text each segment starts with, and its speaker.
export function part(id: number, groupId: number, firstLine: number, written: Line[], opts: { partNo?: number; status?: string; kind?: string; page?: number } = {}): StoredPart {
  let lastRole = "unknown";
  const members = written.map((w, i): StoredMember => {
    const x = typeof w === "string" ? { text: w } : w;
    const role = x.role ?? (x.text.startsWith("Q:") ? "question" : x.text.startsWith("A:") ? "answer" : /^[A-Z. ]+:/.test(x.text) ? "context" : lastRole);
    lastRole = role;
    const speaker = x.speaker ?? ({ question: "attorney", answer: "witness", context: "colloquy", unknown: "unknown" } as Record<string, string>)[role];
    const starts = (x.segments ?? []).map((s) => x.text.indexOf(s.at));
    const segments = (x.segments ?? []).map((s, k) => ({ seq: k, start: starts[k], end: k + 1 < starts.length ? x.text.slice(0, starts[k + 1]).trimEnd().length : x.text.length, role: s.role, name: null }));
    return { lineId: id * 100 + i, page: opts.page ?? 1, line: firstLine + i, text: x.text, lineRole: role, speakerRole: speaker, speakerName: null, segments };
  });
  return { id, groupId, partNo: opts.partNo ?? 1, kind: opts.kind ?? "qa", speakerStatus: opts.status ?? "verified", members };
}

export const doc = (parts: StoredPart[], sha = "a".repeat(64)): StoredDocument => ({ id: 7, caseId: 3, witnessId: 5, sha, scheme: "archive_statement", parts });
