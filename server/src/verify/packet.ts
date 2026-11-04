import type { IssuePacket, PacketPassage } from "../adjudicate/packetPrompt";
import { CONFLICT_OUTCOMES, isAbstention, type PacketOutcome, type PairVerdict } from "../adjudicate/packetSchema";
import { attributeSide, type SideAttribution } from "./attribution";
import { checkSide, type EvidenceExchange, type SideSource } from "./source";

export type PacketSourceStatus = "verified" | "approximate" | "not_cited" | "wrong_reference" | "wrong_pair_reference" | "unsupported";
export type PacketSourceSide = Omit<SideSource, "status"> & { status: PacketSourceStatus };
export type PacketSource = {
  status: PacketSourceStatus;
  swapped: boolean;
  a: PacketSourceSide;
  b: PacketSourceSide;
  packetIds: string[];
};
export type PacketAttributionSide = SideAttribution & { attributionError: boolean };
export type PacketAttribution = { a: PacketAttributionSide | null; b: PacketAttributionSide | null };
export type PacketSemantic = {
  outcome: PacketOutcome;
  consistencyIssues: string[];
};
export type PacketPairVerification = {
  pairId: string;
  status: "answered" | "missing" | "duplicate" | "request_failed";
  duplicateCount?: number;
  error?: string;
  verdict: PairVerdict | null;
  source: PacketSource | null;
  attribution: PacketAttribution | null;
  semantic: PacketSemantic | null;
  validationFailures: string[];
};
export type PacketVerificationSummary = {
  answered: number;
  missing: number;
  duplicate: number;
  request_failed: number;
  unknownPairIds: number;
  outcomes: Record<PacketOutcome, number>;
  abstentions: number;
  sourceStatuses: Record<PacketSourceStatus, number>;
  attributionErrors: number;
  consistencyIssues: number;
};
export type PacketVerification = {
  pairs: PacketPairVerification[];
  unknownPairIds: string[];
  summary: PacketVerificationSummary;
};

const SOURCE_RANK: Record<PacketSourceStatus, number> = {
  verified: 0,
  approximate: 1,
  not_cited: 2,
  wrong_reference: 3,
  wrong_pair_reference: 4,
  unsupported: 5,
};

const exchangeOf = (p: PacketPassage): EvidenceExchange => ({
  id: p.id,
  witnessId: p.witnessId,
  lines: p.lines,
  context: [...p.before, ...p.after],
});

const notCited = (citedId: string): PacketSourceSide => ({
  citedId,
  status: "not_cited",
  reason: "no key phrase was cited",
  matchScore: 0,
  location: null,
  bareAnswer: false,
  proposition: "",
  compound: null,
  evidenceLineIds: [],
  questionText: "",
  answerText: "",
});

function sourceSide(phrase: string | null, citedId: string, own: EvidenceExchange, other: EvidenceExchange, witnessId: number, packetIds: Set<string>): PacketSourceSide {
  if (phrase === null) return notCited(citedId);
  const checked = checkSide(phrase, citedId, own, other, witnessId);
  if (citedId !== own.id && packetIds.has(citedId) && citedId !== other.id) {
    return { ...checked, status: "wrong_pair_reference", reason: "cites another passage in this packet" };
  }
  return checked;
}

function semanticOf(v: PairVerdict): PacketSemantic {
  const issues: string[] = [];
  if (CONFLICT_OUTCOMES.includes(v.outcome) && v.conflictSource !== "cited_exchanges") issues.push("ungrounded");
  if (v.outcome !== "false_positive" && v.falsePositiveReason !== null) issues.push("false_positive_reason_on_non_false_positive");
  if (v.outcome === "false_positive" && v.falsePositiveReason === null) issues.push("false_positive_reason_missing");
  if (!CONFLICT_OUTCOMES.includes(v.outcome) && v.conflictBasis !== "none") issues.push("conflict_basis_on_non_conflict");
  if ((v.alternativeExplanation === null) !== (v.alternativeSupport === null)) issues.push("alternative_support_mismatch");
  return { outcome: v.outcome, consistencyIssues: issues };
}

function summarize(rows: PacketPairVerification[], unknownPairIds: string[]): PacketVerificationSummary {
  const outcomes = Object.fromEntries(["direct", "inferential", "false_positive", "insufficient_evidence", "needs_more_context", "unable_to_assess"].map((x) => [x, 0])) as Record<PacketOutcome, number>;
  const sourceStatuses = Object.fromEntries(Object.keys(SOURCE_RANK).map((x) => [x, 0])) as Record<PacketSourceStatus, number>;
  let attributionErrors = 0;
  let consistencyIssues = 0;
  for (const row of rows) {
    if (row.semantic) {
      outcomes[row.semantic.outcome]++;
      consistencyIssues += row.semantic.consistencyIssues.length;
    }
    if (row.source) {
      sourceStatuses[row.source.status]++;
    }
    if (row.attribution) attributionErrors += Number(row.attribution.a?.claudeContradicted ?? false) + Number(row.attribution.b?.claudeContradicted ?? false);
  }
  return {
    answered: rows.filter((r) => r.status === "answered").length,
    missing: rows.filter((r) => r.status === "missing").length,
    duplicate: rows.filter((r) => r.status === "duplicate").length,
    request_failed: rows.filter((r) => r.status === "request_failed").length,
    unknownPairIds: unknownPairIds.length,
    outcomes,
    abstentions: Object.entries(outcomes).filter(([o]) => isAbstention(o as PacketOutcome)).reduce((n, [, count]) => n + count, 0),
    sourceStatuses,
    attributionErrors,
    consistencyIssues,
  };
}

export function verifyPacketReply(packet: IssuePacket, reply: { ok: true; reply: { verdicts: PairVerdict[] } } | { ok: false; error: string }): PacketVerification {
  const byId = new Map(packet.passages.map((p) => [p.id, exchangeOf(p)]));
  const packetIds = new Set(byId.keys());
  if (!reply.ok) {
    const pairs = packet.pairs.map((p): PacketPairVerification => ({ pairId: p.pairId, status: "request_failed", error: reply.error, verdict: null, source: null, attribution: null, semantic: null, validationFailures: [reply.error] }));
    return { pairs, unknownPairIds: [], summary: summarize(pairs, []) };
  }

  const listed = new Set(packet.pairs.map((p) => p.pairId));
  const unknownPairIds = [...new Set(reply.reply.verdicts.map((v) => v.pairId).filter((id) => !listed.has(id)))];
  const pairs = packet.pairs.map((pair): PacketPairVerification => {
    const matches = reply.reply.verdicts.filter((v) => v.pairId === pair.pairId);
    if (matches.length === 0) return { pairId: pair.pairId, status: "missing", verdict: null, source: null, attribution: null, semantic: null, validationFailures: ["missing verdict"] };
    if (matches.length > 1) return { pairId: pair.pairId, status: "duplicate", duplicateCount: matches.length, verdict: null, source: null, attribution: null, semantic: null, validationFailures: [`duplicate verdict: ${matches.length}`] };

    const v = matches[0];
    const pa = byId.get(pair.a);
    const pb = byId.get(pair.b);
    if (!pa || !pb) return { pairId: pair.pairId, status: "answered", verdict: v, source: null, attribution: null, semantic: semanticOf(v), validationFailures: ["pair references a missing passage"] };
    const swapped = v.evidenceAId === pair.b && v.evidenceBId === pair.a;
    // Each phrase is checked against the pair passage it cites (so swapped IDs verify); a cite outside the
    // pair is checked against the side's own passage, which reports it.
    const [ownA, otherA] = v.evidenceAId === pair.b ? [pb, pa] : [pa, pb];
    const [ownB, otherB] = v.evidenceBId === pair.a ? [pa, pb] : [pb, pa];
    const sourceA = sourceSide(v.keyPhraseA, v.evidenceAId, ownA, otherA, ownA.witnessId, packetIds);
    const sourceB = sourceSide(v.keyPhraseB, v.evidenceBId, ownB, otherB, ownB.witnessId, packetIds);
    const source: PacketSource = { status: SOURCE_RANK[sourceA.status] >= SOURCE_RANK[sourceB.status] ? sourceA.status : sourceB.status, swapped, a: sourceA, b: sourceB, packetIds: [pair.a, pair.b] };
    const attribution: PacketAttribution = {
      a: v.keyPhraseA === null || sourceA.location === null ? null : withAttributionError(attributeSide(sourceA as SideSource, v.keyPhraseA, v.attributionA, v.stanceA)),
      b: v.keyPhraseB === null || sourceB.location === null ? null : withAttributionError(attributeSide(sourceB as SideSource, v.keyPhraseB, v.attributionB, v.stanceB)),
    };
    const semantic = semanticOf(v);
    // Evidence validation only: the model's own consistency issues stay in `semantic`, apart.
    const validationFailures: string[] = [];
    if (v.evidenceAId === v.evidenceBId) validationFailures.push("both sides cite the same passage");
    if (sourceA.status === "unsupported" || sourceA.status === "wrong_reference" || sourceA.status === "wrong_pair_reference") validationFailures.push(`A source ${sourceA.status}`);
    if (sourceB.status === "unsupported" || sourceB.status === "wrong_reference" || sourceB.status === "wrong_pair_reference") validationFailures.push(`B source ${sourceB.status}`);
    if (isAbstention(v.outcome) === false && (sourceA.status === "not_cited" || sourceB.status === "not_cited")) validationFailures.push("missing phrase on substantive outcome");
    return { pairId: pair.pairId, status: "answered", verdict: v, source, attribution, semantic, validationFailures };
  });
  return { pairs, unknownPairIds, summary: summarize(pairs, unknownPairIds) };
}

function withAttributionError(side: SideAttribution): PacketAttributionSide {
  return { ...side, attributionError: side.claudeContradicted };
}
