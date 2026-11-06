// One verified packet-v1 pair result, turned into the fields of a `findings` row with the same rubric,
// context, corroboration and time checks as assess(), so packet adjudication gives findings exactly
// comparable to pairwise ones. Pure: no I/O. The model's interpretation (outcome, attributions, the
// categorical observations) and code's verification (verify/packet.ts, per side) are kept apart, and no
// number from the model is ever read: there is none in the contract.

import { SAFEGUARDS_VERSION, safeguardsFor } from "../verify/safeguards";
import { contextCheck, corroborate, prioritize, RUBRIC_V1, score, timeCheckOf, type Assessment, type Priority } from "../score";
import { attributeSide, type AttributionCheck, type SideAttribution } from "../verify/attribution";
import type { PacketPairVerification, PacketSourceSide, PacketSourceStatus } from "../verify/packet";
import type { EvidenceStatus, SideSource, SourceCheck } from "../verify/source";
import { VERIFICATION_VERSION } from "../verify/version";
import { isCompactDismissal } from "./compactRead";
import { PACKET_PROMPT_VERSION, type IssuePacket } from "./packetPrompt";
import type { PairVerdict } from "./packetSchema";
import type { Classification, Verdict } from "./schema";

export type PacketFindingFields = {
  type: Classification; // the scoring classification
  outcome: string; // the model's packet outcome, verbatim
  evidenceStatus: EvidenceStatus;
  attributionA: string | null;
  attributionB: string | null;
  score: number | null;
  band: string | null;
  unscoredReason: string | null;
  factors: unknown;
  caps: unknown;
  checks: Record<string, unknown>;
  rubricVersion: string;
  priority: Priority;
  contextRequested: boolean;
};

// Outcome -> scoring classification. direct, inferential and false_positive keep theirs. The three
// abstentions (insufficient_evidence, needs_more_context, unable_to_assess) all score as
// insufficient_evidence, which score() leaves unscored; the verbatim outcome is kept in `outcome`.
const CLASSIFICATION: Record<PairVerdict["outcome"], Classification> = {
  direct: "direct",
  inferential: "inferential",
  false_positive: "false_positive",
  insufficient_evidence: "insufficient_evidence",
  needs_more_context: "insufficient_evidence",
  unable_to_assess: "insufficient_evidence",
};

// A packet side's status -> the findings row's evidence status. Citing another passage of the packet
// (wrong_pair_reference) is a wrong reference; giving no quote (not_cited) leaves nothing verified, so
// unsupported. The packet's own status stays in checks.source.
const EVIDENCE_STATUS: Record<PacketSourceStatus, EvidenceStatus> = {
  verified: "verified",
  approximate: "approximate",
  wrong_reference: "wrong_reference",
  wrong_pair_reference: "wrong_reference",
  not_cited: "unsupported",
  unsupported: "unsupported",
};

const asSide = (s: PacketSourceSide): SideSource => ({ ...s, status: EVIDENCE_STATUS[s.status] });

export function assessPacketPair(packet: IssuePacket, pair: PacketPairVerification): PacketFindingFields | null {
  // Missing, malformed, duplicate or a failed request: no finding, never read as compatible.
  if (pair.status !== "answered" || !pair.verdict || !pair.source || !pair.attribution || !pair.semantic) return null;
  // A compact contract's dismissal (compactRead.ts) is a code, not cited evidence: stored as the pair's verdict, never a finding.
  if (isCompactDismissal(pair.verdict)) return null;
  if ("sideA" in pair.verdict || "detailsCompared" in pair.verdict) throw new Error(`assessPacketPair reads packet-v1 verdicts only (pair ${pair.pairId})`);
  const v = pair.verdict as PairVerdict;
  const listed = packet.pairs.find((p) => p.pairId === pair.pairId);
  const passages = listed && [listed.a, listed.b].map((id) => packet.passages.find((p) => p.id === id));
  if (!passages || passages.some((p) => !p)) return null;

  const classification = CLASSIFICATION[v.outcome];
  // The equivalent pairwise verdict, so score() reads it as it reads any other. v1 packets don't report
  // whether the conflict is about the timing of one event, nor inference steps or assumptions.
  const verdict: Verdict = {
    classification,
    evidenceAId: v.evidenceAId,
    evidenceBId: v.evidenceBId,
    keyPhraseA: v.keyPhraseA ?? "",
    keyPhraseB: v.keyPhraseB ?? "",
    attributionA: v.attributionA,
    attributionB: v.attributionB,
    stanceA: v.stanceA,
    stanceB: v.stanceB,
    sameEvent: v.sameEvent,
    scopeAligned: v.scopeAligned,
    conflictBasis: v.conflictBasis,
    aboutTimingOfSameEvent: false,
    inferenceSteps: [],
    unestablishedAssumptions: [],
    falsePositiveReason: v.falsePositiveReason,
    explanation: v.explanation,
    alternativeExplanation: v.alternativeExplanation,
    needsMoreContext: v.outcome === "needs_more_context",
    alternativeSupport: v.alternativeSupport,
    conflictSource: v.conflictSource,
    contextUsed: v.contextUsed,
  };

  // Layer 1 and 2 come from the pair's own per-side verification (each side's own witness, adjacent
  // exchanges), never re-run with one witness. The worse side sets the status.
  const src = pair.source;
  const source: SourceCheck = { status: EVIDENCE_STATUS[src.status], a: asSide(src.a), b: asSide(src.b), packetIds: src.packetIds };
  // verify/packet leaves a side unattributed when its quote wasn't found; the scorer still needs a side,
  // so it is read here as assess() reads any unfound phrase. Its stored level stays null.
  const sideOf = (s: SourceCheck["a"], got: SideAttribution | null, phrase: string | null, attribution: PairVerdict["attributionA"], stance: PairVerdict["stanceA"]) =>
    got ?? attributeSide(s, phrase ?? "", attribution, stance);
  const attribution: AttributionCheck = {
    a: sideOf(source.a, pair.attribution.a, v.keyPhraseA, v.attributionA, v.stanceA),
    b: sideOf(source.b, pair.attribution.b, v.keyPhraseB, v.attributionB, v.stanceB),
  };
  // Deterministic safeguards (verify/safeguards.ts): a conflict verdict that trips one is published as needs context,
  // never as an unqualified contradiction; the model's outcome stays in `outcome` and the rules in checks.safeguards.
  const safeguards = safeguardsFor(v, attribution, { a: source.a.answerText, b: source.b.answerText });
  if (safeguards.length) {
    verdict.classification = "insufficient_evidence";
    verdict.needsMoreContext = true;
  }
  const finalClass = verdict.classification;
  const [propA, propB] = [source.a.proposition, source.b.proposition];
  const timeCheck = timeCheckOf(verdict.aboutTimingOfSameEvent, propA, propB);
  const checks = {
    source,
    attribution,
    context: contextCheck(passages.map((x) => ({ wholeExchange: x!.wholeExchange, surroundingLines: x!.before.length + x!.after.length, sourceGap: x!.gapBefore || x!.gapAfter }))),
    corroboration: corroborate(propA, propB, attribution, timeCheck),
    timeCheck,
    extractionDisagreement: false,
  };
  // A deterministic consistency issue from verify/packet leaves the finding unscored for review, as
  // assess() does for its own consistency check. Review flags are heuristic: kept, never decisive.
  const { consistencyIssues, reviewFlags, requiresReview } = pair.semantic;
  const assessment: Assessment =
    consistencyIssues.length > 0
      ? { eligible: false, score: null, band: null, unscoredReason: "inconsistent_verdict", factors: [], capsApplied: [], notCorroborated: [], reasons: [], rubricVersion: RUBRIC_V1.version }
      : score({ verdict, ...checks });
  const priority = prioritize(finalClass, source.status, assessment, "unreviewed", verdict.needsMoreContext);

  return {
    type: finalClass,
    outcome: v.outcome,
    evidenceStatus: source.status,
    attributionA: pair.attribution.a?.level ?? null,
    attributionB: pair.attribution.b?.level ?? null,
    score: assessment.score,
    band: assessment.band,
    unscoredReason: assessment.unscoredReason,
    factors: assessment.factors,
    caps: assessment.capsApplied,
    checks: {
      ...checks,
      // The packet's own per-side record (cited, diagnosis, foundIn, packet status, swapped).
      source: src,
      packetAttribution: pair.attribution,
      verificationVersion: VERIFICATION_VERSION,
      contract: PACKET_PROMPT_VERSION,
      notCorroborated: assessment.notCorroborated,
      reasons: assessment.reasons,
      consistencyIssues,
      reviewFlags,
      requiresReview,
      safeguards,
      safeguardsVersion: SAFEGUARDS_VERSION,
      validationFailures: pair.validationFailures,
    },
    rubricVersion: assessment.rubricVersion,
    priority,
    contextRequested: verdict.needsMoreContext,
  };
}
