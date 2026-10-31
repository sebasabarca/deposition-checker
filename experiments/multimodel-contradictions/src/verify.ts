// Checks every citation against the parsed transcript. Pure. The model's own claims count for nothing.
// Whether a passage truly supports a proposition is a human judgement; this reports word overlap only.
import { contentWords, normalize, quoteMatchScore } from "../../../server/src/verify";
import type { Dataset, Line, Session } from "./data";
import type { Finding } from "./schemas";

export type SideCheck = {
  citation: "resolved" | "unparsable" | "no_such_lines";
  excerpt: "exact" | "approximate" | "elsewhere_in_session" | "not_found";
  speaker: "witness" | "attorney" | "mixed" | "unknown";
  propositionOverlap: number; // share of the proposition's content words on the cited lines
  lines: Line[];
};
export type Verification = { status: "verified" | "approximate" | "wrong_reference" | "unsupported"; identity: string[]; a: SideCheck; b: SideCheck };

export function parseCitation(citation: string): { first: [number, number]; last: [number, number] } | null {
  const m = citation.trim().match(/^(\d+):(\d+)(?:\s*[-–—]\s*(?:(\d+):)?(\d+))?$/);
  if (!m) return null;
  const first: [number, number] = [Number(m[1]), Number(m[2])];
  return { first, last: m[4] ? [Number(m[3] ?? m[1]), Number(m[4])] : first };
}

const within = (l: Line, r: NonNullable<ReturnType<typeof parseCitation>>) => (l.page > r.first[0] || (l.page === r.first[0] && l.line >= r.first[1])) && (l.page < r.last[0] || (l.page === r.last[0] && l.line <= r.last[1]));
const TURN = /^\s*(?:Q\.|A\.|THE WITNESS:|(?:MR|MS|MRS|DR)\. [A-Z'-]+:)\s*/;
const spoken = (lines: readonly Line[]) => lines.map((l) => l.text.replace(TURN, "")).join(" ");

function checkSide(session: Session | undefined, citation: string, excerpt: string, proposition: string): SideCheck {
  const none: SideCheck = { citation: "no_such_lines", excerpt: "not_found", speaker: "unknown", propositionOverlap: 0, lines: [] };
  if (!session) return none;
  const range = parseCitation(citation);
  if (!range) return { ...none, citation: "unparsable" };
  const lines = session.lines.filter((l) => within(l, range));
  const inSession = normalize(spoken(session.lines)).includes(normalize(excerpt));
  if (lines.length === 0) return { ...none, excerpt: inSession ? "elsewhere_in_session" : "not_found" };
  const text = spoken(lines);
  const score = quoteMatchScore(excerpt, text);
  const speakers = new Set(lines.map((l) => (l.speaker === "witness" ? "witness" : "attorney")));
  const cited = new Set(contentWords(text));
  const words = contentWords(proposition);
  return {
    citation: "resolved",
    excerpt: score >= 1 ? "exact" : inSession ? "elsewhere_in_session" : score >= 0.6 ? "approximate" : "not_found",
    speaker: speakers.size === 2 ? "mixed" : ([...speakers][0] as "witness" | "attorney"),
    propositionOverlap: words.length === 0 ? 0 : words.filter((w) => cited.has(w)).length / words.length,
    lines,
  };
}

export function verifyFinding(f: Finding, d: Dataset): Verification {
  const session = (label: string) => d.sessions.find((s) => s.label === label);
  const a = checkSide(session(f.session_a), f.citation_a, f.exact_excerpt_a, f.factual_proposition_a);
  const b = checkSide(session(f.session_b), f.citation_b, f.exact_excerpt_b, f.factual_proposition_b);
  const identity = [...(normalize(f.witness) === normalize(d.witness) ? [] : ["wrong_witness"]), ...(f.session_a === f.session_b ? ["same_session"] : [])];
  const sides = [a.excerpt, b.excerpt];
  const status = identity.length > 0 || sides.includes("not_found") ? "unsupported" : sides.includes("elsewhere_in_session") ? "wrong_reference" : sides.includes("approximate") ? "approximate" : "verified";
  return { status, identity, a, b };
}
