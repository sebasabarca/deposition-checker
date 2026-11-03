// Scores a cross-witness analysis against human labels. Pure: no I/O. A finding counts for a labelled
// pair only if one of its citations lands on the pair's lines for one witness and the other on the
// other's, never for similar wording. Findings that match no label are listed for a person to review:
// labels are never complete, so they are neither credited nor counted as false.

export type ScoredPair = { id: string; expected: "conflict" | "conflict_needs_context" | "no_conflict" | "exploratory"; a: readonly number[]; b: readonly number[] };
export type ScoredFinding = { index: number; lane: string; classification: string; evidenceStatus: string; a: readonly number[]; b: readonly number[] };

const overlaps = (x: readonly number[], y: readonly number[]) => x.some((id) => y.includes(id));
const hits = (f: ScoredFinding, p: ScoredPair) => (overlaps(f.a, p.a) && overlaps(f.b, p.b)) || (overlaps(f.a, p.b) && overlaps(f.b, p.a));
const REPORTED = new Set(["contradictions", "needs_context"]);
// Below this many labels a rate moves too much per example to support a conclusion.
export const MIN_STABLE_LABELS = 5;
const stability = (n: number) => (n >= MIN_STABLE_LABELS ? null : `Only ${n} labelled ${n === 1 ? "example" : "examples"}: each one moves this rate by ${n ? Math.round(100 / n) : 100} points, too much to draw a conclusion.`);

export function scoreCross(pairs: readonly ScoredPair[], findings: readonly ScoredFinding[]) {
  const reported = findings.filter((f) => REPORTED.has(f.lane));
  const unresolved = pairs.filter((p) => p.a.length === 0 || p.b.length === 0).map((p) => p.id);
  const targets = pairs.filter((p) => p.expected === "conflict" || p.expected === "conflict_needs_context"); // established plus review-worthy
  const exploratory = pairs.filter((p) => p.expected === "exploratory"); // shown, never scored
  const strict = pairs.filter((p) => p.expected === "conflict"); // confirmed, materially incompatible statements
  const contextual = pairs.filter((p) => p.expected === "conflict_needs_context");
  const controls = pairs.filter((p) => p.expected === "no_conflict");
  const laneOf = (p: ScoredPair) => (reported.some((f) => f.lane === "contradictions" && hits(f, p)) ? "contradictions" : reported.some((f) => hits(f, p)) ? "needs_context" : null);
  const perPair = pairs.map((p) => ({ id: p.id, expected: p.expected, reportedAs: laneOf(p), findings: findings.filter((f) => hits(f, p)).map((f) => ({ index: f.index, lane: f.lane, classification: f.classification })) }));
  const discovered = targets.filter((p) => laneOf(p) !== null);
  const strictFound = strict.filter((p) => laneOf(p) === "contradictions");
  const falseOnControls = controls.filter((p) => laneOf(p) !== null);
  const unlabelled = reported.filter((f) => !pairs.some((p) => hits(f, p)));
  const none = (n: number) => (n === 0 ? "Not measurable: the set has no labels of this kind." : stability(n));
  return {
    // Did the pipeline work: proposals that came back, how verification sorted them, citations that hold.
    pipeline: {
      proposals: findings.length,
      inContradictions: reported.filter((f) => f.lane === "contradictions").length,
      inNeedsContext: reported.filter((f) => f.lane === "needs_context").length,
      compatible: findings.filter((f) => f.lane === "compatible").length,
      unverified: findings.filter((f) => f.lane === "unverified").length,
      citationValidity: findings.length ? findings.filter((f) => f.evidenceStatus === "verified").length / findings.length : null,
      unresolvedLabels: unresolved,
      unlabelledForReview: unlabelled.map((f) => f.index),
    },
    // 1. Discovery recall: established conflicts and review-worthy disagreements surfaced in either lane.
    //    Surfacing a review-worthy pair is discovery, never a proven contradiction.
    discoveryRecall: {
      labelled: targets.length,
      rate: targets.length ? discovered.length / targets.length : null,
      missed: targets.filter((p) => !discovered.includes(p)).map((p) => p.id),
      caution: none(targets.length),
    },
    // 2. Strict recall: established, materially incompatible pairs reported in the contradictions lane.
    strictRecall: {
      labelled: strict.length,
      rate: strict.length ? strictFound.length / strict.length : null,
      missed: strict.filter((p) => !strictFound.includes(p)).map((p) => p.id),
      onlyAsNeedsContext: strict.filter((p) => laneOf(p) === "needs_context").map((p) => p.id),
      caution: none(strict.length),
    },
    // Needs-context targets the pipeline put in the contradictions lane: shown, never counted as proven.
    contextTargetsReportedAsContradictions: contextual.filter((p) => laneOf(p) === "contradictions").map((p) => p.id),
    // 3. False-positive rate on the confirmed negative controls, in either lane.
    falsePositives: {
      controls: controls.length,
      rate: controls.length ? falseOnControls.length / controls.length : null,
      reported: falseOnControls.map((p) => p.id),
      caution: none(controls.length),
    },
    // 4. Exploratory cases: whether each was surfaced, for inspection only; in no rate.
    exploratory: exploratory.map((p) => ({ id: p.id, reportedAs: laneOf(p) })),
    perPair,
  };
}
