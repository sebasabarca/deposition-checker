// Checks a cross-witness finding against the stored transcripts, and sorts it into a review lane. Pure:
// no I/O, no model. Each side is checked as in direct discovery (does the citation resolve, is the
// quotation there, are the words that witness's own), and then the rules that only apply across
// witnesses: the two sides must be different witnesses, and a lack of recollection never conflicts with
// another witness's memory, whatever the model said.

import type { CrossFinding } from "../adjudicate/discoverCrossSchema";
import { checkDirectSide, evidenceStatusOf, parseCitation, type DirectCheck, type DirectSide, type Lane, type StoredSession } from "./direct";
import { UNNUMBERED_PAGE } from "../ingest/text";
import { normalize } from "./quotes";

// A session as the cross-witness prompt labelled it (A1, A2, B1, ...), with its witness.
export type CrossStoredSession = Omit<StoredSession, "label"> & { label: string; witness: string };
// How each side's quotation was verified, rebuilt from the stored transcript text (never the model's
// wording): one continuous passage, ordered fragments, or not verified at all.
export type StoredQuote = { form: "continuous" | "fragments" | "unverified"; stored: string[]; lineIds: number[] };
export type CrossCheck = Omit<DirectCheck, "a" | "b"> & { a: DirectSide; b: DirectSide; witnessA: string | null; witnessB: string | null; quotes: { a: StoredQuote; b: StoredQuote } };

const ELLIPSIS_SPLIT = /\s*(?:\.\s*){3,}\s*|\s*…\s*/;
const MIN_FRAGMENT_WORDS = 2;
const MARKER = /^\s*(?:[QA](?:[._:]|\s)\s*|[A-Z][A-Z .'-]+:\s+)/;

// The text's normalized form (as quotes.ts compares it) with, for each of its characters, where it came
// from in the original, so a match found in the normalized text can be cut from the stored text itself.
function normalizedWithMap(text: string) {
  let norm = "";
  const map: number[] = [];
  let space = true;
  for (let i = 0; i < text.length; i++) {
    const c = text[i].toLowerCase();
    if (/[a-z0-9]/.test(c)) {
      norm += c;
      map.push(i);
      space = false;
    } else if (!space) {
      norm += " ";
      map.push(i);
      space = true;
    }
  }
  return { norm, map };
}

// Pure. The stored text of each piece, found in order in the cited text, or null if any piece is missing.
function locate(pieces: string[], text: string): string[] | null {
  const { norm, map } = normalizedWithMap(text);
  const padded = ` ${norm} `;
  const found: string[] = [];
  let from = 0;
  for (const piece of pieces) {
    const p = normalize(piece);
    if (!p) return null;
    const at = padded.indexOf(` ${p} `, from);
    if (at < 0) return null;
    found.push(text.slice(map[at], map[at + p.length - 1] + 1));
    from = at + p.length + 1;
  }
  return found;
}

// Pure. True when the excerpt is fragments joined by "..." or "…", every fragment at least two words, and
// each found word for word in the cited lines, after the one before it. Never true for a single piece.
export function fragmentsInOrder(excerpt: string, citedText: string): boolean {
  const fragments = excerpt.split(ELLIPSIS_SPLIT).filter((f) => normalize(f));
  if (fragments.length < 2 || fragments.some((f) => normalize(f).split(" ").length < MIN_FRAGMENT_WORDS)) return false;
  return locate(fragments, citedText) !== null;
}

// Pure. The quotation as the stored transcript has it, from the cited lines.
export function storedQuote(excerpt: string, cited: readonly { id: number; text: string }[], form: StoredQuote["form"]): StoredQuote {
  const text = cited.map((l) => l.text).join(" ");
  const lineIds = cited.map((l) => l.id);
  if (form === "fragments") return { form, stored: locate(excerpt.split(ELLIPSIS_SPLIT).filter((f) => normalize(f)), text) ?? [], lineIds };
  if (form === "continuous") return { form, stored: locate([excerpt.replace(MARKER, "")], text) ?? locate([excerpt], text) ?? [text], lineIds };
  return { form, stored: [], lineIds };
}

// Benchmark only: score references that aren't official page:line (an archive's statement numbers) as
// if they were. In the product they always hold a finding at needs context.
export type CrossOptions = { acceptUnofficialLines?: boolean };

const unofficial = (s: DirectSide) => s.physicalLines || parseCitation(s.citation)?.first[0] === UNNUMBERED_PAGE;

export function crossLaneOf(classification: CrossFinding["classification"], evidenceStatus: DirectCheck["evidenceStatus"], a: DirectSide, b: DirectSide, options: CrossOptions = {}): { lane: Lane; reasons: string[] } {
  const sides = [a, b];
  const unverified: string[] = [];
  if (evidenceStatus === "unsupported") unverified.push("A cited quotation couldn't be found in the transcript, or both passages are one witness's.");
  if (evidenceStatus === "wrong_reference") unverified.push("A quotation is in the transcript, but not at the cited line.");
  if (sides.some((s) => s.speaker === "attorney_only" || s.speaker === "none")) unverified.push("A cited statement is not the witness's testimony.");
  if (unverified.length > 0) return { lane: "unverified", reasons: unverified };

  if (sides.some((s) => s.noRecall)) return { lane: "compatible", reasons: ["One witness doesn't recall. A lack of recollection is not a conflict with another witness's memory."] };
  if (classification === "recollection_or_knowledge_difference") return { lane: "compatible", reasons: ["The model judged this a difference in recollection or knowledge, not a conflict."] };
  if (classification === "compatible") return { lane: "compatible", reasons: ["The model judged both accounts compatible."] };

  const doubts: string[] = [];
  if (classification === "possible_conflict_needs_context") doubts.push("The model said this depends on context the testimony doesn't settle.");
  if (evidenceStatus === "approximate") doubts.push("A quotation only approximately matches the transcript.");
  if (sides.some((s) => s.level === "uncertain")) doubts.push("Code couldn't establish who said a cited statement.");
  if (sides.some((s) => s.ocr.lowLines.length > 0)) doubts.push("A cited line was hard to read on the scanned page. Compare it with the page image.");
  if (!options.acceptUnofficialLines && sides.some(unofficial)) doubts.push("A cited passage has no official page and line number, so its reference is not an official citation.");
  return doubts.length > 0 ? { lane: "needs_context", reasons: doubts } : { lane: "contradictions", reasons: [] };
}

export function verifyCrossFinding(finding: CrossFinding, sessions: readonly CrossStoredSession[], options: CrossOptions = {}): CrossCheck {
  const sa = sessions.find((s) => s.label === finding.session_a);
  const sb = sessions.find((s) => s.label === finding.session_b);
  const quotes = {} as CrossCheck["quotes"];
  // Each quotation is checked against the cited lines and rebuilt from their stored text. Ordered fragments
  // joined by an ellipsis are verified piece by piece and kept as fragments, never as one continuous quote.
  const side = (session: CrossStoredSession | undefined, citation: string, excerpt: string, which: "a" | "b"): DirectSide => {
    const checked = checkDirectSide(session, citation, excerpt);
    const cited = session ? session.lines.filter((l) => checked.lineIds.includes(l.id)) : [];
    if (checked.quote === "exact") {
      quotes[which] = storedQuote(excerpt, cited, "continuous");
      return checked;
    }
    if (cited.length > 0 && fragmentsInOrder(excerpt, cited.map((l) => l.text).join(" "))) {
      quotes[which] = storedQuote(excerpt, cited, "fragments");
      return { ...checked, quote: "fragments", matchScore: 1 };
    }
    quotes[which] = storedQuote(excerpt, cited, "unverified");
    return checked;
  };
  const a = side(sa, finding.citation_a, finding.excerpt_a, "a");
  const b = side(sb, finding.citation_b, finding.excerpt_b, "b");
  const identityIssues = [
    ...(sa && sb && sa.witness === sb.witness ? ["both passages are one witness's testimony"] : []),
    ...(!sa || !sb ? ["a cited session label isn't one of the sessions provided"] : []),
  ];
  const evidenceStatus = evidenceStatusOf([a.quote, b.quote], identityIssues);
  return { evidenceStatus, identityIssues, a, b, witnessA: sa?.witness ?? null, witnessB: sb?.witness ?? null, quotes, ...crossLaneOf(finding.classification, evidenceStatus, a, b, options) };
}
