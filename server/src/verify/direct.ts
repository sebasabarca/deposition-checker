// Checks a directly discovered finding against the stored transcript, and sorts it into a review
// lane. Pure: no I/O, no model. The model's own claims count for nothing here. Source facts (does
// the citation resolve, is the quotation there, who said it, how well was it read) stay separate
// from the model's interpretation, which code neither confirms nor scores.
//
// An exact match against OCR text shows the quotation is in our reading of the page, not that the
// page was read correctly, so OCR-read sides always say so, and doubtful ones go to a person.

import { createHash } from "node:crypto";
import type { DiscoveryFinding } from "../adjudicate/discoverSchema";
import { readAnswer, readRecollection } from "./answers";
import { normalize, quoteMatchScore } from "./quotes";
import { findHedge } from "./text";
import { UNNUMBERED_PAGE } from "../ingest/text";

export const LOW_OCR_LINE_CONFIDENCE = 85; // the same line the client warns at
export const APPROXIMATE_QUOTE = 0.6;
export const DUPLICATE_OVERLAP = 0.5; // of the shorter passage, on both sides

export type StoredLine = { id: number; page: number; line: number; pdfPage: number; text: string; role: string; ocrConfidence: number | null };
export type StoredSession = { label: "A" | "B"; depositionId: number; lines: readonly StoredLine[] };

export type QuoteStatus = "exact" | "approximate" | "elsewhere_in_session" | "not_found";
export type Speaker = "witness" | "adopted" | "attorney_only" | "mixed" | "unknown" | "none";
export type Lane = "contradictions" | "needs_context" | "compatible" | "unverified";

export type DirectSide = {
  depositionId: number;
  citation: string;
  resolved: boolean;
  quote: QuoteStatus;
  matchScore: number;
  speaker: Speaker;
  level: "clear" | "qualified" | "uncertain" | "not_adopted" | "no_recall";
  rule: string; // the deterministic reading behind `level`, in plain words
  qualifier: string | null;
  noRecall: boolean;
  reportedSpeech: boolean;
  ocr: { read: boolean; minConfidence: number | null; lowLines: string[] };
  lineIds: number[];
  pdfPages: number[];
};

export type DirectCheck = {
  evidenceStatus: "verified" | "approximate" | "wrong_reference" | "unsupported";
  identityIssues: string[];
  a: DirectSide;
  b: DirectSide;
  lane: Lane;
  reasons: string[]; // why it is in this lane, in plain words
};

const CITATION = /^(\d+):(\d+)(?:\s*[-–—]\s*(?:(\d+):)?(\d+))?$/;
export function parseCitation(citation: string): { first: [number, number]; last: [number, number] } | null {
  const m = citation.trim().match(CITATION);
  if (!m) return null;
  const first: [number, number] = [Number(m[1]), Number(m[2])];
  const last: [number, number] = m[4] ? [Number(m[3] ?? m[1]), Number(m[4])] : first;
  return first[0] * 1000 + first[1] <= last[0] * 1000 + last[1] ? { first, last } : null;
}

const refOf = (l: StoredLine) => `${l.page}:${String(l.line).padStart(2, "0")}`;
const position = (page: number, line: number) => page * 1000 + line;
// Turn markers aren't testimony, so an excerpt may be quoted with or without them.
const MARKER = /^\s*(?:[QA](?:[._]|\s)\s*|(?:Mr|Ms|Mrs|Dr)\. [A-Z][A-Za-z'-]+\.\s+)/;
const unmarked = (lines: readonly StoredLine[]) => lines.map((l) => l.text.replace(MARKER, "")).join(" ");
const printed = (lines: readonly StoredLine[]) => lines.map((l) => l.text).join(" ");
const SPOKEN_BY_ATTORNEY = new Set(["attorney", "colloquy"]);
const REPORTED = /\b(told me|said|relayed|retold|according to|under the impression|i heard|heard from|to my understanding)\b/i;

function speakerOf(cited: readonly StoredLine[], excerpt: string, following: readonly StoredLine[]): Pick<DirectSide, "speaker" | "level" | "rule"> {
  const roles = new Set(cited.map((l) => l.role).filter((r) => r !== "parenthetical"));
  if (roles.size === 0) return { speaker: "none", level: "not_adopted", rule: "the cited lines hold no spoken testimony" };
  if (roles.has("unknown")) return { speaker: "unknown", level: "uncertain", rule: "a cited line has no identified speaker" };
  const attorney = cited.filter((l) => SPOKEN_BY_ATTORNEY.has(l.role));
  const witness = cited.filter((l) => l.role === "witness");
  if (attorney.length === 0) return { speaker: "witness", level: "clear", rule: "the cited lines are the witness's own" };
  // Words only in a question are testimony only if the answer plainly adopts or denies them.
  const adoption = (answer: string) => readAnswer(unmarked(attorney), answer);
  if (witness.length === 0) {
    const nextTurn = following.slice(0, 6);
    const end = nextTurn.findIndex((l) => l.role !== "witness");
    const answer = nextTurn.slice(0, end < 0 ? undefined : end);
    if (answer.length > 0 && adoption(unmarked(answer)) !== "uncertain") return { speaker: "adopted", level: "clear", rule: "the attorney's words, answered with a plain yes or no in the next lines" };
    return { speaker: "attorney_only", level: "not_adopted", rule: "the cited words are only the attorney's, and the answer doesn't plainly adopt them" };
  }
  if (adoption(unmarked(witness)) !== "uncertain") return { speaker: "adopted", level: "clear", rule: "the attorney's words, answered with a plain yes or no" };
  // Question and answer both cited: the excerpt must be in the witness's own lines.
  if (quoteMatchScore(excerpt.replace(MARKER, ""), unmarked(witness)) >= APPROXIMATE_QUOTE) return { speaker: "witness", level: "clear", rule: "the excerpt is in the witness's own lines" };
  return { speaker: "mixed", level: "uncertain", rule: "the citation mixes attorney and witness lines, and the excerpt isn't clearly the witness's" };
}

export function checkDirectSide(session: StoredSession | undefined, citation: string, excerpt: string): DirectSide {
  const base = { depositionId: session?.depositionId ?? 0, citation, matchScore: 0, qualifier: null, noRecall: false, reportedSpeech: false, ocr: { read: false, minConfidence: null, lowLines: [] }, lineIds: [], pdfPages: [] };
  const inSession = session ? quoteMatchScore(excerpt, unmarked(session.lines)) >= 1 || quoteMatchScore(excerpt, printed(session.lines)) >= 1 : false;
  const unresolved: DirectSide = { ...base, resolved: false, quote: inSession ? "elsewhere_in_session" : "not_found", speaker: "none", level: "not_adopted", rule: "the citation doesn't resolve to stored lines" };
  const range = parseCitation(citation);
  if (!session || !range) return unresolved;
  const lower = position(...range.first);
  const upper = position(...range.last);
  const cited = session.lines.filter((l) => position(l.page, l.line) >= lower && position(l.page, l.line) <= upper);
  if (cited.length === 0) return unresolved;
  const matchScore = Math.max(quoteMatchScore(excerpt, unmarked(cited)), quoteMatchScore(excerpt, printed(cited)));
  const quote: QuoteStatus = matchScore >= 1 ? "exact" : inSession ? "elsewhere_in_session" : matchScore >= APPROXIMATE_QUOTE ? "approximate" : "not_found";
  const last = session.lines.indexOf(cited[cited.length - 1]);
  const speech = speakerOf(cited, excerpt, session.lines.slice(last + 1));
  const said = unmarked(cited.filter((l) => l.role === "witness")) || unmarked(cited);
  const noRecall = readRecollection(said) !== null;
  const qualifier = findHedge(excerpt, said);
  const confidences = cited.map((l) => l.ocrConfidence).filter((c): c is number => c !== null);
  const level = speech.level !== "clear" ? speech.level : noRecall ? "no_recall" : qualifier ? "qualified" : "clear";
  return {
    ...base,
    resolved: true,
    quote,
    matchScore,
    ...speech,
    level,
    rule: noRecall && speech.level === "clear" ? "the witness says they don't recall" : qualifier && speech.level === "clear" ? `the hedge "${qualifier}"` : speech.rule,
    qualifier,
    noRecall,
    reportedSpeech: REPORTED.test(said),
    ocr: { read: confidences.length > 0, minConfidence: confidences.length ? Math.min(...confidences) : null, lowLines: cited.filter((l) => l.ocrConfidence !== null && l.ocrConfidence < LOW_OCR_LINE_CONFIDENCE).map(refOf) },
    lineIds: cited.map((l) => l.id),
    pdfPages: [...new Set(cited.map((l) => l.pdfPage))],
  };
}

function evidenceStatusOf(sides: QuoteStatus[], identityIssues: string[]): DirectCheck["evidenceStatus"] {
  if (identityIssues.length > 0 || sides.includes("not_found")) return "unsupported";
  if (sides.includes("elsewhere_in_session")) return "wrong_reference";
  return sides.includes("approximate") ? "approximate" : "verified";
}

// The lane is code's decision, from code's checks and the model's classification. Nothing reaches the
// contradictions lane unless both sides are verified witness testimony, and even there it is a
// potential contradiction for a lawyer to weigh, never a proven one.
export function laneOf(finding: Pick<DiscoveryFinding, "classification" | "comparable">, evidenceStatus: DirectCheck["evidenceStatus"], a: DirectSide, b: DirectSide): { lane: Lane; reasons: string[] } {
  const sides = [a, b];
  const unverified: string[] = [];
  if (evidenceStatus === "unsupported") unverified.push("A cited quotation couldn't be found in the transcript.");
  if (evidenceStatus === "wrong_reference") unverified.push("A quotation is in the transcript, but not at the cited page and line.");
  if (sides.some((s) => s.speaker === "attorney_only" || s.speaker === "none")) unverified.push("A cited statement is not the witness's testimony.");
  if (unverified.length > 0) return { lane: "unverified", reasons: unverified };

  const doubts: string[] = [];
  if (finding.classification === "uncertain_needs_context" || finding.classification === "insufficient_evidence") doubts.push("The model said this depends on context it didn't have.");
  if (finding.comparable !== "yes") doubts.push("The model wasn't sure the two passages concern the same thing.");
  if (evidenceStatus === "approximate") doubts.push("A quotation only approximately matches the transcript.");
  if (sides.some((s) => s.level === "uncertain")) doubts.push("Code couldn't establish who said a cited statement.");
  if (sides.some((s) => s.noRecall)) doubts.push("A cited statement is a lack of recollection, not a denial.");
  if (sides.some((s) => s.ocr.lowLines.length > 0)) doubts.push("A cited line was read by OCR with low confidence. Check the scan.");
  if (sides.some((s) => parseCitation(s.citation)?.first[0] === UNNUMBERED_PAGE)) doubts.push("A cited passage is from a text without page and line numbers, so its reference is not an official citation.");
  if (finding.classification === "compatible") return doubts.length === 0 || (doubts.length === 1 && finding.comparable !== "yes") ? { lane: "compatible", reasons: [] } : { lane: "needs_context", reasons: doubts };
  return doubts.length > 0 ? { lane: "needs_context", reasons: doubts } : { lane: "contradictions", reasons: [] };
}

export function verifyDirectFinding(finding: DiscoveryFinding, sessions: readonly [StoredSession, StoredSession], witness: string): DirectCheck {
  const byLabel = (label: string) => sessions.find((s) => s.label === label);
  const a = checkDirectSide(byLabel(finding.session_a), finding.citation_a, finding.exact_excerpt_a);
  const b = checkDirectSide(byLabel(finding.session_b), finding.citation_b, finding.exact_excerpt_b);
  const identityIssues = [...(normalize(finding.witness) === normalize(witness) ? [] : ["the finding names a different witness"]), ...(finding.session_a === finding.session_b ? ["both citations are in one session"] : [])];
  const evidenceStatus = evidenceStatusOf([a.quote, b.quote], identityIssues);
  return { evidenceStatus, identityIssues, a, b, ...laneOf(finding, evidenceStatus, a, b) };
}

// The same two passages, whichever way round the model cited them.
export function evidenceKey(a: Pick<DirectSide, "depositionId" | "lineIds">, b: Pick<DirectSide, "depositionId" | "lineIds">): string {
  const part = (s: typeof a) => `${s.depositionId}:${[...s.lineIds].sort((x, y) => x - y).join(",")}`;
  return createHash("sha256").update([part(a), part(b)].sort().join("|")).digest("hex");
}

type Dedupable = { a: Pick<DirectSide, "depositionId" | "lineIds">; b: Pick<DirectSide, "depositionId" | "lineIds">; lane: Lane };

const sameAssertion = (x: Pick<DirectSide, "depositionId" | "lineIds">, y: Pick<DirectSide, "depositionId" | "lineIds">) => {
  if (x.depositionId !== y.depositionId || x.lineIds.length === 0 || y.lineIds.length === 0) return false;
  const lines = new Set(x.lineIds);
  return y.lineIds.filter((id) => lines.has(id)).length / Math.min(x.lineIds.length, y.lineIds.length) >= DUPLICATE_OVERLAP;
};
const canonical = <T extends Dedupable>(f: T) => (f.a.depositionId <= f.b.depositionId ? [f.a, f.b] : [f.b, f.a]);
const sameEvidence = (x: Dedupable, y: Dedupable) => {
  const [xa, xb] = canonical(x);
  const [ya, yb] = canonical(y);
  return sameAssertion(xa, ya) && sameAssertion(xb, yb);
};

// When findings merge, the one shown is the most cautious, so a doubt on any copy stays visible.
const CAUTION: Record<Lane, number> = { needs_context: 0, contradictions: 1, compatible: 2, unverified: 3 };
const sortKey = (f: Dedupable) => evidenceKey(f.a, f.b);

// Groups findings resting on the same evidence: both passages must overlap, on the same pair of
// sessions. Same people, dates or subject are not enough. Each group's first item is the one to
// show; the rest stay with it. Deterministic, and the same whatever order the findings arrive in.
export function groupDuplicates<T extends Dedupable>(findings: readonly T[]): T[][] {
  const ordered = [...findings].sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
  const groups: T[][] = [];
  for (const f of ordered) {
    const match = groups.filter((g) => g.some((m) => sameEvidence(m, f)));
    const merged = [...match.flat(), f];
    for (const g of match) groups.splice(groups.indexOf(g), 1);
    groups.push(merged);
  }
  return groups
    .map((g) => [...g].sort((x, y) => CAUTION[x.lane] - CAUTION[y.lane] || sortKey(x).localeCompare(sortKey(y))))
    .sort((x, y) => sortKey(x[0]).localeCompare(sortKey(y[0])));
}
