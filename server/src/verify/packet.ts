// Verifies a model's reply to one evidence packet, per listed pair, for every packet contract (v1, v2, v3).
// Pure. Four results are kept apart: completeness (one verdict per pair), source (Layer 1, per citation),
// attribution (Layer 2, on each side's key statement) and the model's semantic classification, with
// deterministic consistency issues separate from heuristic review flags. Passing source checks never
// validates a classification, and nothing in the reply is ever rewritten: a wrong citation is rejected and
// diagnosed, never corrected.
import type { IssuePacket, PacketPassage } from "../adjudicate/packetPrompt";
import { ABSTENTIONS, CONFLICT_OUTCOMES, MAX_CITATIONS_PER_SIDE, PACKET_OUTCOMES, PACKET_OUTCOMES_V2, type MalformedVerdict, type PacketOutcome, type PacketOutcomeV2, type PairVerdict, type PairVerdictV2, type PairVerdictV3 } from "../adjudicate/packetSchema";
import { attributeSide, type SideAttribution } from "./attribution";
import { APPROXIMATE, checkSide, matchScore, VERIFIED, type EvidenceExchange, type SideSource } from "./source";
import { spoken } from "./text";

export type PacketSourceStatus = "verified" | "approximate" | "not_cited" | "wrong_reference" | "wrong_pair_reference" | "unsupported";
// Why a citation failed, when it did:
//   invalid_exchange_id         the cited ID isn't any exchange shown in this packet
//   cites_other_side            the ID belongs to the pair's other passage or its neighbours
//   cites_other_passage         the ID is another passage of the packet (not in this pair) or its neighbour
//   phrase_in_other_exchange    the quote is not in the cited exchange but is, exactly, in one other shown exchange
//   phrase_in_several_exchanges the quote is exactly in more than one other shown exchange
//   unsupported_quotation       the quote is in no shown exchange
//   phrase_in_context_lines     the quote is in no shown exchange, but is in a passage's plain context lines (not citable)
export type CitationDiagnosis = "invalid_exchange_id" | "cites_other_side" | "cites_other_passage" | "phrase_in_other_exchange" | "phrase_in_several_exchanges" | "phrase_in_context_lines" | "unsupported_quotation";
// Where a diagnosed quote actually is, relative to the side that cited it.
export type FoundIn = { exchangeId: string; relation: "own_exchange" | "own_adjacent" | "other_side" | "other_passage" | "own_context_lines" | "other_context_lines" };
// cited: whether the quote was checked in the side's own exchange or in an adjacent exchange shown with it.
// Support from an adjacent exchange is valid evidence but is recorded as such, never as the candidate exchange.
export type PacketSourceSide = Omit<SideSource, "status"> & { status: PacketSourceStatus; cited?: "exchange" | "adjacent"; diagnosis?: CitationDiagnosis; foundIn?: FoundIn[] };
export type AnyPairVerdict = PairVerdict | PairVerdictV2 | PairVerdictV3;
type AnyOutcome = PacketOutcome | PacketOutcomeV2;
const isAbstention = (o: string) => (ABSTENTIONS as readonly string[]).includes(o);
const isConflict = (o: string) => (CONFLICT_OUTCOMES as readonly string[]).includes(o);
export type PacketSource = {
  status: PacketSourceStatus; // the worse of the two sides' key statements
  swapped: boolean;
  a: PacketSourceSide; // each side's key statement (its first citation)
  b: PacketSourceSide;
  supporting: { side: "a" | "b"; source: PacketSourceSide }[]; // packet-v3: each side's further citations
  packetIds: string[];
};
export type PacketAttributionSide = SideAttribution & { attributionError: boolean };
export type PacketAttribution = { a: PacketAttributionSide | null; b: PacketAttributionSide | null };
// consistencyIssues: deterministic contradictions inside the verdict's own fields. reviewFlags: heuristic
// signs (wording in the explanation, a detail not found in the evidence for v1/v2) that a person should
// check; they assert nothing on their own. requiresReview: any of either.
export type PacketSemantic = {
  outcome: AnyOutcome;
  consistencyIssues: string[];
  reviewFlags: string[];
  requiresReview: boolean;
};
export type PacketPairVerification = {
  pairId: string;
  status: "answered" | "missing" | "duplicate" | "malformed" | "request_failed";
  duplicateCount?: number;
  error?: string;
  verdict: AnyPairVerdict | null;
  source: PacketSource | null;
  attribution: PacketAttribution | null;
  semantic: PacketSemantic | null;
  validationFailures: string[];
};
export type PacketVerificationSummary = {
  answered: number;
  missing: number;
  duplicate: number;
  malformed: number;
  request_failed: number;
  unknownPairIds: number;
  outcomes: Record<string, number>;
  abstentions: number;
  sourceStatuses: Record<PacketSourceStatus, number>;
  diagnoses: Record<string, number>;
  attributionErrors: number;
  consistencyIssues: number;
  requiresReview: number;
};
export type PacketVerification = {
  pairs: PacketPairVerification[];
  unknownPairIds: string[];
  malformed: MalformedVerdict[];
  summary: PacketVerificationSummary;
};

// A parsed reply: strict ({ reply: { verdicts } }), lenient ({ verdicts, malformed }) or a failed request.
export type ParsedReply = { ok: true; reply: { verdicts: AnyPairVerdict[] } } | { ok: true; verdicts: AnyPairVerdict[]; malformed: MalformedVerdict[] } | { ok: false; error: string };

const SOURCE_RANK: Record<PacketSourceStatus, number> = { verified: 0, approximate: 1, not_cited: 2, wrong_reference: 3, wrong_pair_reference: 4, unsupported: 5 };
const FAILED = new Set<PacketSourceStatus>(["unsupported", "wrong_reference", "wrong_pair_reference"]);

// Every exchange shown in the packet, by ID: a passage's own exchange, or a neighbour shown with one or more
// passages. One exchange can border several passages (two passages of one deposition a few exchanges apart),
// and can be one passage's own exchange and another's neighbour; every relationship is kept.
type Shown = { exchange: EvidenceExchange; coreOf: string | null; borders: Set<string> };
function registry(packet: IssuePacket): Map<string, Shown> {
  const reg = new Map<string, Shown>();
  const entry = (id: string, make: () => EvidenceExchange) => reg.get(id) ?? reg.set(id, { exchange: make(), coreOf: null, borders: new Set() }).get(id)!;
  for (const p of packet.passages) entry(p.id, () => exchangeOf(p)).coreOf = p.id;
  for (const p of packet.passages) for (const a of p.adjacent ?? []) entry(a.id, () => ({ id: a.id, witnessId: p.witnessId, lines: a.lines, context: [] })).borders.add(p.id);
  return reg;
}
const exchangeOf = (p: PacketPassage): EvidenceExchange => ({ id: p.id, witnessId: p.witnessId, lines: p.lines, context: [...p.before, ...p.after] });
// How an exchange relates to a passage: its own exchange, one of its neighbours, or neither.
const relationTo = (s: Shown | undefined, passage: string) => (!s ? null : s.coreOf === passage ? "exchange" : s.borders.has(passage) ? "adjacent" : null);

const blankSide = (citedId: string, status: PacketSourceStatus, reason: string): PacketSourceSide => ({ citedId, status, reason, matchScore: 0, location: null, bareAnswer: false, proposition: "", compound: null, evidenceLineIds: [], questionText: "", answerText: "" });
const textOf = (x: EvidenceExchange) => x.lines.map((l) => spoken(l.text)).join(" ");

// Where a quote is, exactly, among the shown exchanges other than the one cited, relative to the citing side.
function locateQuote(quote: string, cited: string, reg: Map<string, Shown>, own: string, other: string): FoundIn[] {
  const out: FoundIn[] = [];
  for (const [id, s] of reg) {
    if (id === cited || matchScore(quote, textOf(s.exchange)) < VERIFIED) continue;
    const rel = relationTo(s, own);
    out.push({ exchangeId: id, relation: rel === "exchange" ? "own_exchange" : rel === "adjacent" ? "own_adjacent" : relationTo(s, other) ? "other_side" : "other_passage" });
  }
  return out;
}

// One citation, checked against the exchange it names, for the side whose passage is `own` (the pair's other
// passage is `other`). A failure carries a diagnosis and, when the quote is elsewhere, where it is.
function checkCitation(quote: string | null, cited: string, reg: Map<string, Shown>, own: string, other: string): PacketSourceSide {
  if (quote === null) return blankSide(cited, "not_cited", "no key phrase was cited");
  const ownCore = reg.get(own)!.exchange;
  const otherCore = reg.get(other)!.exchange;
  const s = reg.get(cited);
  const rel = relationTo(s, own);
  const diagnose = (base: PacketSourceSide, fallback: CitationDiagnosis): PacketSourceSide => {
    const found = locateQuote(quote, cited, reg, own, other);
    // Not in any exchange: perhaps in a passage's plain context lines, which can't be cited (v1's only context).
    const inContext = found.length ? [] : [own, other].filter((pid) => { const c = reg.get(pid)!.exchange.context; return c.length > 0 && matchScore(quote, c.map((l) => spoken(l.text)).join(" ")) >= VERIFIED; }).map((pid): FoundIn => ({ exchangeId: pid, relation: pid === own ? "own_context_lines" : "other_context_lines" }));
    if (inContext.length) return { ...base, diagnosis: "phrase_in_context_lines", foundIn: inContext, reason: `${base.reason ?? "phrase_in_context_lines"}; the quote is in ${inContext[0].relation === "own_context_lines" ? "this side's" : "the other side's"} context lines, which aren't citable` };
    const diagnosis: CitationDiagnosis = found.length === 1 ? "phrase_in_other_exchange" : found.length > 1 ? "phrase_in_several_exchanges" : fallback;
    const where = found.length === 1 ? `; the quote is in ${found[0].exchangeId} (${found[0].relation.replace("_", " ")}), not in ${cited}` : found.length > 1 ? `; the quote is in ${found.map((f) => f.exchangeId).join(", ")}` : "";
    return { ...base, diagnosis, foundIn: found.length ? found : undefined, reason: `${base.reason ?? diagnosis}${where}` };
  };
  if (!s) return diagnose(blankSide(cited, "unsupported", "the cited ID is not an exchange shown in this packet"), "invalid_exchange_id");
  if (rel === null) {
    const otherSide = relationTo(s, other) !== null;
    const status: PacketSourceStatus = otherSide ? "wrong_reference" : "wrong_pair_reference";
    const checked = checkSide(quote, cited, s.exchange, ownCore, s.exchange.witnessId);
    return diagnose({ ...checked, status, reason: otherSide ? "cites the pair's other passage or its neighbours" : "cites another passage in this packet" }, otherSide ? "cites_other_side" : "cites_other_passage");
  }
  const checked: PacketSourceSide = { ...checkSide(quote, cited, s.exchange, otherCore, s.exchange.witnessId), cited: rel };
  if (!FAILED.has(checked.status)) return checked;
  return diagnose(checked, "unsupported_quotation");
}

// Each contract's verdict as citations per side (key statement first), details and the fields code checks.
type Normal = { sides: { a: { citations: { exchangeId: string; quote: string | null }[]; attribution: PairVerdict["attributionA"]; stance: PairVerdict["stanceA"] }; b: Normal["sides"]["a"] }; details: { detail: string; sideA: string; sideB: string; relation: string }[] | null; conflictBasis: string; conflictSource: string | null; explanation: string; alternativeExplanation: string | null; alternativeSupport: string | null; version: "v1" | "v2" | "v3" };
function normalize(v: AnyPairVerdict): Normal {
  if ("sideA" in v && typeof v.sideA === "object") {
    const side = (s: PairVerdictV3["sideA"]) => ({ citations: s.citations.length ? s.citations : [{ exchangeId: "", quote: null }], attribution: s.attribution, stance: s.stance });
    return { sides: { a: side(v.sideA), b: side(v.sideB) }, details: v.details, conflictBasis: v.conflictBasis, conflictSource: null, explanation: v.explanation, alternativeExplanation: v.alternativeExplanation, alternativeSupport: v.alternativeSupport, version: "v3" };
  }
  const old = v as PairVerdict | PairVerdictV2;
  return {
    sides: { a: { citations: [{ exchangeId: old.evidenceAId, quote: old.keyPhraseA }], attribution: old.attributionA, stance: old.stanceA }, b: { citations: [{ exchangeId: old.evidenceBId, quote: old.keyPhraseB }], attribution: old.attributionB, stance: old.stanceB } },
    details: "detailsCompared" in old ? old.detailsCompared.map((d) => ({ detail: d.detail, sideA: d.sideA, sideB: d.sideB, relation: d.relation })) : null,
    conflictBasis: old.conflictBasis, conflictSource: old.conflictSource, explanation: old.explanation, alternativeExplanation: old.alternativeExplanation, alternativeSupport: old.alternativeSupport,
    version: "detailsCompared" in old ? "v2" : "v1",
  };
}

// Explanation wording that contradicts the outcome. Heuristic: it flags for review, it never decides.
const SAYS_COMPATIBLE = /\b(?:are|is|remain|appear|seem)s? (?:fully |entirely |largely |broadly )?consistent\b|\bboth (?:can|could) be true\b|\bno (?:real |actual |genuine )?(?:conflict|contradiction|inconsistency)\b|\bdo(?:es)? not (?:conflict|contradict)\b|\bare compatible\b/i;
const SAYS_CONFLICT = /\b(?:directly )?contradicts?\b|\bcannot both be true\b|\bare inconsistent\b|\bmutually exclusive\b/i;
const NEGATED_CONFLICT = /\b(?:not|no|never|nothing)\b[^.]{0,30}\b(?:contradict|inconsistent|mutually exclusive)/i;

// Specific facts a detail names (numbers, month names, capitalised names not starting a clause) that occur in
// none of the given evidence. Pure; deliberately narrow, so it flags invented specifics, not paraphrase.
const MONTHS = /^(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)$/i;
const COMMON = new Set(["the", "a", "an", "i", "q", "a.", "mr", "mrs", "ms", "dr", "side", "witness", "yes", "no", "not", "both", "neither", "session", "exchange", "he", "she", "they", "it", "his", "her", "their", "on", "in", "at", "whether", "when", "where", "who", "what", "which", "and", "or", "but"]);
// Page:line references ("24:07", "5:15-6:10") and exchange IDs ("E6328") are citations, not facts: removed first.
// Each text (a detail's label, its side A words, its side B words) is scanned on its own, so a capital at the
// start of one isn't taken for a name.
const REFERENCES = /\b\d+:\d+(?:\s*-\s*\d+:\d+)?\b|\bE\d+\b/g;
export function unseenSpecifics(detailTexts: string | readonly string[], evidence: string): string[] {
  const seen = evidence.toLowerCase();
  const out = new Set<string>();
  for (const text of typeof detailTexts === "string" ? [detailTexts] : detailTexts) {
  const words = text.replace(REFERENCES, " ").split(/[^A-Za-z0-9']+/).filter(Boolean);
  words.forEach((w, i) => {
    const lower = w.toLowerCase().replace(/'s$/, ""); // a possessive names the same person
    const number = /\d/.test(w);
    const month = MONTHS.test(w);
    const name = i > 0 && /^[A-Z][a-z]{2,}/.test(w) && !COMMON.has(lower);
    if ((number || month || name) && !new RegExp(`\\b${lower.replace(/[^a-z0-9']/g, "")}\\b`).test(seen)) out.add(w);
  });
  }
  return [...out];
}

function semanticOf(v: AnyPairVerdict, n: Normal, evidenceText: { a: string; b: string; names: string }): PacketSemantic {
  const issues: string[] = [];
  const flags: string[] = [];
  const conflict = isConflict(v.outcome);
  if (conflict && n.conflictSource !== null && n.conflictSource !== "cited_exchanges") issues.push("ungrounded");
  if ("falsePositiveReason" in v) {
    if (v.outcome !== "false_positive" && v.falsePositiveReason !== null) issues.push("false_positive_reason_on_non_false_positive");
    if (v.outcome === "false_positive" && v.falsePositiveReason === null) issues.push("false_positive_reason_missing");
  }
  if (n.details) {
    if (v.outcome === "direct" && !n.details.some((d) => d.relation === "different")) issues.push("direct_without_different_detail");
    if (v.outcome === "direct" && n.conflictBasis === "requires_inference") issues.push("direct_requires_inference");
    if (conflict && n.details.length === 0) issues.push("conflict_without_details");
    // v3 requires each detail's words to come from that side's own citations: checked deterministically. v2
    // paraphrased its details, so "not verbatim" proves nothing there and isn't flagged.
    if (n.version === "v3" && n.details.some((d) => (d.sideA && matchScore(d.sideA, evidenceText.a) < APPROXIMATE) || (d.sideB && matchScore(d.sideB, evidenceText.b) < APPROXIMATE))) issues.push("detail_not_in_cited_evidence");
    // For every version: a date, number or name in a compared detail that appears in neither side's shown
    // evidence. A sign of an invented distinction, flagged for review; it decides nothing on its own.
    if (unseenSpecifics(n.details.flatMap((d) => [d.detail, d.sideA, d.sideB]), `${evidenceText.a} ${evidenceText.b} ${evidenceText.names}`).length) flags.push("detail_names_unseen_specific");
  }
  if (!conflict && n.conflictBasis !== "none") issues.push("conflict_basis_on_non_conflict");
  if ((n.alternativeExplanation === null) !== (n.alternativeSupport === null)) issues.push("alternative_support_mismatch");
  if (conflict && SAYS_COMPATIBLE.test(n.explanation)) flags.push("explanation_says_compatible");
  if (v.outcome === "compatible" || v.outcome === "false_positive") if (SAYS_CONFLICT.test(n.explanation) && !NEGATED_CONFLICT.test(n.explanation)) flags.push("explanation_says_conflict");
  return { outcome: v.outcome, consistencyIssues: issues, reviewFlags: flags, requiresReview: issues.length + flags.length > 0 };
}

function summarize(rows: PacketPairVerification[], unknownPairIds: string[]): PacketVerificationSummary {
  const outcomes: Record<string, number> = Object.fromEntries([...new Set<string>([...PACKET_OUTCOMES, ...PACKET_OUTCOMES_V2])].map((x) => [x, 0]));
  const sourceStatuses = Object.fromEntries(Object.keys(SOURCE_RANK).map((x) => [x, 0])) as Record<PacketSourceStatus, number>;
  const diagnoses: Record<string, number> = {};
  let attributionErrors = 0;
  let consistencyIssues = 0;
  for (const row of rows) {
    if (row.semantic) {
      outcomes[row.semantic.outcome]++;
      consistencyIssues += row.semantic.consistencyIssues.length;
    }
    if (row.source) {
      sourceStatuses[row.source.status]++;
      for (const s of [row.source.a, row.source.b, ...row.source.supporting.map((x) => x.source)]) if (s.diagnosis) diagnoses[s.diagnosis] = (diagnoses[s.diagnosis] ?? 0) + 1;
    }
    if (row.attribution) attributionErrors += Number(row.attribution.a?.claudeContradicted ?? false) + Number(row.attribution.b?.claudeContradicted ?? false);
  }
  const count = (s: PacketPairVerification["status"]) => rows.filter((r) => r.status === s).length;
  return {
    answered: count("answered"), missing: count("missing"), duplicate: count("duplicate"), malformed: count("malformed"), request_failed: count("request_failed"),
    unknownPairIds: unknownPairIds.length, outcomes,
    abstentions: Object.entries(outcomes).filter(([o]) => isAbstention(o)).reduce((n, [, c]) => n + c, 0),
    sourceStatuses, diagnoses, attributionErrors, consistencyIssues,
    requiresReview: rows.filter((r) => r.semantic?.requiresReview).length,
  };
}

const unanswered = (pairId: string, status: PacketPairVerification["status"], failure: string, extra: Partial<PacketPairVerification> = {}): PacketPairVerification => ({ pairId, status, verdict: null, source: null, attribution: null, semantic: null, validationFailures: [failure], ...extra });

export function verifyPacketReply(packet: IssuePacket, reply: ParsedReply): PacketVerification {
  if (!reply.ok) {
    const pairs = packet.pairs.map((p) => unanswered(p.pairId, "request_failed", reply.error, { error: reply.error }));
    return { pairs, unknownPairIds: [], malformed: [], summary: summarize(pairs, []) };
  }
  const verdicts = "reply" in reply ? reply.reply.verdicts : reply.verdicts;
  const malformed = "reply" in reply ? [] : reply.malformed;
  const reg = registry(packet);
  const packetIds = new Set(packet.passages.map((p) => p.id));
  const listed = new Set(packet.pairs.map((p) => p.pairId));
  const unknownPairIds = [...new Set([...verdicts.map((v) => v.pairId), ...malformed.map((m) => m.pairId).filter((x): x is string => x !== null)].filter((id) => !listed.has(id)))];

  const pairs = packet.pairs.map((pair): PacketPairVerification => {
    const matches = verdicts.filter((v) => v.pairId === pair.pairId);
    const bad = malformed.filter((m) => m.pairId === pair.pairId);
    // A pair is answered only by exactly one well-formed verdict. Anything else is never read as compatible.
    if (matches.length + bad.length > 1) return unanswered(pair.pairId, "duplicate", `duplicate verdict: ${matches.length + bad.length}`, { duplicateCount: matches.length + bad.length });
    if (bad.length === 1) return unanswered(pair.pairId, "malformed", `malformed verdict: ${bad[0].error}`, { error: bad[0].error });
    if (matches.length === 0) return unanswered(pair.pairId, "missing", "missing verdict");
    const v = matches[0];
    if (!reg.get(pair.a) || !reg.get(pair.b)) return unanswered(pair.pairId, "answered", "pair references a missing passage", { verdict: v });

    const n = normalize(v);
    // A side's home passage is the one its key statement's exchange relates to; a fully swapped reply (A cites
    // B's passage and B cites A's) verifies, each side checked against the passage it cites.
    const homeOf = (id: string, fallback: string, alt: string) => (relationTo(reg.get(id), fallback) ? fallback : relationTo(reg.get(id), alt) ? alt : fallback);
    const aHome0 = homeOf(n.sides.a.citations[0].exchangeId, pair.a, pair.b);
    const bHome0 = homeOf(n.sides.b.citations[0].exchangeId, pair.b, pair.a);
    const swapped = aHome0 === pair.b && bHome0 === pair.a;
    const [aHome, bHome] = swapped ? [pair.b, pair.a] : [pair.a, pair.b];
    const citeAll = (side: Normal["sides"]["a"], home: string, other: string) => side.citations.map((c) => (c.quote === null || c.exchangeId === "" ? blankSide(c.exchangeId, "not_cited", "no key phrase was cited") : checkCitation(c.quote, c.exchangeId, reg, home, other)));
    const aAll = citeAll(n.sides.a, aHome, bHome);
    const bAll = citeAll(n.sides.b, bHome, aHome);
    const sourceA = aAll[0];
    const sourceB = bAll[0];
    const supporting = [...aAll.slice(1).map((s) => ({ side: "a" as const, source: s })), ...bAll.slice(1).map((s) => ({ side: "b" as const, source: s }))];
    const source: PacketSource = { status: SOURCE_RANK[sourceA.status] >= SOURCE_RANK[sourceB.status] ? sourceA.status : sourceB.status, swapped, a: sourceA, b: sourceB, supporting, packetIds: [pair.a, pair.b] };
    const keyA = n.sides.a.citations[0].quote;
    const keyB = n.sides.b.citations[0].quote;
    const attribution: PacketAttribution = {
      a: keyA === null || sourceA.location === null ? null : withAttributionError(attributeSide(sourceA as SideSource, keyA, n.sides.a.attribution, n.sides.a.stance)),
      b: keyB === null || sourceB.location === null ? null : withAttributionError(attributeSide(sourceB as SideSource, keyB, n.sides.b.attribution, n.sides.b.stance)),
    };
    // The evidence a side's compared details may quote: v3, its own cited exchanges; v1/v2, every exchange shown for it.
    const evidenceOf = (side: Normal["sides"]["a"], home: string) =>
      (n.version === "v3" ? side.citations.map((c) => reg.get(c.exchangeId)).filter((s): s is Shown => !!s && relationTo(s, home) !== null) : [...reg.values()].filter((s) => relationTo(s, home) !== null)).map((s) => textOf(s.exchange)).join(" ");
    // The witnesses' names are shown in each passage's header, so a detail may name them.
    const names = packet.passages.filter((p) => p.id === aHome || p.id === bHome).map((p) => p.witnessName).join(" ");
    const semantic = semanticOf(v, n, { a: evidenceOf(n.sides.a, aHome), b: evidenceOf(n.sides.b, bHome), names });

    // Evidence validation only; the model's consistency issues and review flags stay in `semantic`.
    const validationFailures: string[] = [];
    const ownSide = (s: PacketSourceSide, home: string) => relationTo(reg.get(s.citedId), home) !== null;
    if (n.sides.a.citations[0].exchangeId === n.sides.b.citations[0].exchangeId || (ownSide(sourceA, aHome) && ownSide(sourceB, aHome)) || (ownSide(sourceA, bHome) && ownSide(sourceB, bHome))) validationFailures.push("both sides cite the same passage");
    for (const [label, s] of [["A", sourceA], ["B", sourceB]] as const) if (FAILED.has(s.status)) validationFailures.push(`${label} source ${s.status}${s.diagnosis ? ` (${s.diagnosis})` : ""}`);
    for (const x of supporting) if (FAILED.has(x.source.status)) validationFailures.push(`${x.side.toUpperCase()} supporting citation ${x.source.status}${x.source.diagnosis ? ` (${x.source.diagnosis})` : ""}`);
    if (n.version === "v3") for (const [label, side] of [["A", n.sides.a], ["B", n.sides.b]] as const) if (side.citations.length > MAX_CITATIONS_PER_SIDE) validationFailures.push(`${label} has ${side.citations.length} citations (at most ${MAX_CITATIONS_PER_SIDE})`);
    if (!isAbstention(v.outcome) && (sourceA.status === "not_cited" || sourceB.status === "not_cited")) validationFailures.push("missing phrase on substantive outcome");
    void packetIds;
    return { pairId: pair.pairId, status: "answered", verdict: v, source, attribution, semantic, validationFailures };
  });
  return { pairs, unknownPairIds, malformed, summary: summarize(pairs, unknownPairIds) };
}

function withAttributionError(side: SideAttribution): PacketAttributionSide {
  return { ...side, attributionError: side.claudeContradicted };
}

// A bounded, auditable recovery plan for an incomplete reply: the pairs left unresolved (missing, malformed,
// duplicate, or a failed request) and one follow-up packet holding only those pairs and their passages. It is
// a plan: nothing here sends a request, and the caller decides (under the paid-call gate and budget) whether
// to send at most MAX_RECOVERY_ROUNDS follow-ups, one after another, each for what is still unresolved. Two since
// November 6 (developer's choice): a single retry left pairs unread when the model repeated a reply-format slip,
// and a person had to press Resume. The original reply and its valid verdicts are kept as they are.
export const MAX_RECOVERY_ROUNDS = 2;
export function recoveryPlan(packet: IssuePacket, v: PacketVerification, round = 1): { unresolved: { pairId: string; status: string }[]; packet: IssuePacket | null } {
  const unresolved = v.pairs.filter((p) => p.status !== "answered").map((p) => ({ pairId: p.pairId, status: p.status }));
  if (unresolved.length === 0 || round > MAX_RECOVERY_ROUNDS) return { unresolved, packet: null };
  const ids = new Set(unresolved.map((u) => u.pairId));
  const pairs = packet.pairs.filter((p) => ids.has(p.pairId));
  const used = new Set(pairs.flatMap((p) => [p.a, p.b]));
  return { unresolved, packet: { id: `${packet.id}~recovery-${round}`, passages: packet.passages.filter((p) => used.has(p.id)), pairs } };
}
