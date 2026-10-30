// Everything code does with a valid verdict, in one pure function: Layer 1 (source), Layer 2
// (attribution), the context, corroboration and time checks, the rubric score and the review
// priority. No I/O, so every finding can be recomputed from its stored verdict and packet.

import { quoteMatchScore } from "../verify";
import { checkAttribution, checkSources, type AttributionCheck, type SourceCheck } from "../verify";
import { contextCheck, corroborate, prioritize, RUBRIC_V1, score, timeCheckOf, type Assessment, type ContextCheck, type CorroborationCheck, type Priority } from "../score";
import type { TimeCheck } from "../ambiguity";
import { checkConsistency, type ConsistencyIssue } from "./consistency";
import { evidenceOf, type Packet } from "./packet";
import type { Attribution, Verdict } from "./schema";

// Path A's claims on the cited exchanges, for the disagreement check.
export type TaggedClaim = { keyPhrase: string; epistemic: string };

const AS_ATTRIBUTION: Record<string, Attribution> = {
  asserted: "asserted",
  qualified: "qualified",
  does_not_recall: "does_not_recall",
  does_not_know: "does_not_recall",
  hypothetical: "hypothetical",
  reported_by_other: "reported_by_other",
};

// Path A disagrees when one of its usable claims on the cited exchange carries the same statement
// (the key phrases match either way) with a different epistemic status than Claude's attribution.
export function disagrees(claims: readonly TaggedClaim[], keyPhrase: string, attribution: Attribution): boolean {
  return claims.some(
    (c) =>
      (quoteMatchScore(c.keyPhrase, keyPhrase) >= 0.6 || quoteMatchScore(keyPhrase, c.keyPhrase) >= 0.6) &&
      AS_ATTRIBUTION[c.epistemic] !== undefined &&
      AS_ATTRIBUTION[c.epistemic] !== attribution,
  );
}

export type Checks = {
  source: SourceCheck;
  attribution: AttributionCheck;
  context: ContextCheck;
  corroboration: CorroborationCheck;
  timeCheck: TimeCheck | null;
  extractionDisagreement: boolean;
};
export type Assessed = { checks: Checks; assessment: Assessment; priority: Priority; consistencyIssues: ConsistencyIssue[] };

export function assess(packet: Packet, verdict: Verdict, pathA: { a: readonly TaggedClaim[]; b: readonly TaggedClaim[] } = { a: [], b: [] }): Assessed {
  const source = checkSources(verdict, { witnessId: packet.witnessId, a: evidenceOf(packet.a), b: evidenceOf(packet.b) });
  const attribution = checkAttribution(verdict, source);
  // Code's checks read each side's proposition: the key phrase, or the question a bare answer answers.
  const [propA, propB] = [source.a.proposition, source.b.proposition];
  const timeCheck = timeCheckOf(verdict.aboutTimingOfSameEvent, propA, propB);
  const checks: Checks = {
    source,
    attribution,
    context: contextCheck([packet.a, packet.b].map((x) => ({ wholeExchange: x.wholeExchange, surroundingLines: x.before.length + x.after.length, sourceGap: x.gapBefore || x.gapAfter }))),
    corroboration: corroborate(propA, propB, attribution, timeCheck),
    timeCheck,
    extractionDisagreement: disagrees(pathA.a, propA, verdict.attributionA) || disagrees(pathA.b, propB, verdict.attributionB),
  };
  // A verdict whose own fields contradict each other isn't scored: code's checks still run and are
  // kept, and the finding goes to review (needs_context), never shown as a scored result.
  const consistencyIssues = checkConsistency(verdict, packet);
  const assessment: Assessment =
    consistencyIssues.length > 0
      ? { eligible: false, score: null, band: null, unscoredReason: "inconsistent_verdict", factors: [], capsApplied: [], notCorroborated: [], reasons: [], rubricVersion: RUBRIC_V1.version }
      : score({ verdict, ...checks });
  const priority = prioritize(verdict.classification, source.status, assessment, "unreviewed", verdict.needsMoreContext);
  return { checks, assessment, priority, consistencyIssues };
}
