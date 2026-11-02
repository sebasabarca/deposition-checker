// Scores a direct analysis against a synthetic suite's labels. Pure: no I/O. A finding counts for a
// target only if both of its citations land on the target's own stored lines, never for similar
// wording, and only the contradictions lane counts as a detection: a needs-context finding on a
// target is reported, not credited. These suites shaped development, so this is a development-tuned
// synthetic evaluation, not a held-out benchmark, and says nothing about real depositions.

export type BenchmarkTarget = { id: string; label: string; a: readonly number[]; b: readonly number[] };
export type BenchmarkFinding = { lane: string; modelClassification: string; evidenceStatus: string; a: { depositionId: number; lineIds: readonly number[] }; b: { depositionId: number; lineIds: readonly number[] } };
export type LineTruth = { lineId: number; witness: boolean }; // from the fixture's own Q./A. text

const overlaps = (x: readonly number[], y: readonly number[]) => x.some((id) => y.includes(id));
const hits = (f: BenchmarkFinding, t: BenchmarkTarget, sessionA: number) => {
  const [a, b] = f.a.depositionId === sessionA ? [f.a, f.b] : [f.b, f.a];
  return overlaps(a.lineIds, t.a) && overlaps(b.lineIds, t.b);
};

export function scoreBenchmark(input: { sessionA: number; targets: readonly BenchmarkTarget[]; traps: readonly BenchmarkTarget[]; findings: readonly BenchmarkFinding[]; proposals: number; truth: readonly LineTruth[]; codeSaysWitness: (lineId: number) => boolean }) {
  const { sessionA, targets, traps, findings, proposals, truth, codeSaysWitness } = input;
  const reported = findings.filter((f) => f.lane === "contradictions");
  const context = findings.filter((f) => f.lane === "needs_context");
  const found = targets.filter((t) => reported.some((f) => hits(f, t, sessionA)));
  const onlyContext = targets.filter((t) => !found.includes(t) && context.some((f) => hits(f, t, sessionA)));
  const missed = targets.filter((t) => !found.includes(t) && !onlyContext.includes(t));
  const truePositives = reported.filter((f) => targets.some((t) => hits(f, t, sessionA)));
  const falsePositives = reported.filter((f) => !truePositives.includes(f));
  const cited = findings.flatMap((f) => [...f.a.lineIds, ...f.b.lineIds]);
  const known = new Map(truth.map((l) => [l.lineId, l.witness]));
  const judged = cited.filter((id) => known.has(id));
  const verified = findings.filter((f) => f.evidenceStatus === "verified").length;
  return {
    targets: targets.length,
    found: found.map((t) => t.id),
    needsContextOnly: onlyContext.map((t) => t.id),
    missed: missed.map((t) => t.id),
    recall: targets.length === 0 ? null : found.length / targets.length,
    recallCountingContext: targets.length === 0 ? null : (found.length + onlyContext.length) / targets.length,
    reported: reported.length,
    precision: reported.length === 0 ? null : truePositives.length / reported.length, // before a person reviews the false positives
    falsePositives: falsePositives.length,
    trapsFlagged: traps.filter((t) => reported.some((f) => hits(f, t, sessionA))).map((t) => t.id),
    direct: reported.filter((f) => f.modelClassification === "direct_contradiction").length,
    inferential: reported.filter((f) => f.modelClassification === "inferential_contradiction").length,
    unresolvedNeedingContext: context.length,
    unverified: findings.filter((f) => f.lane === "unverified").length,
    notStored: proposals - findings.length,
    citationValidity: findings.length === 0 ? null : verified / findings.length,
    speakerAccuracy: judged.length === 0 ? null : judged.filter((id) => codeSaysWitness(id) === known.get(id)).length / judged.length,
  };
}
