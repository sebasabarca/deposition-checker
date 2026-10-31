// Compares arms. Pure. Accuracy needs approved human labels: without them only agreement is reported,
// and AI-proposed labels are never accepted here.
import type { Line } from "./data";
import type { Finding } from "./schemas";
import type { Verification } from "./verify";

export type ArmFinding = { arm: string; finding: Finding; verification: Verification };
export type Cluster = { arms: string[]; members: ArmFinding[] };
const CONTRADICTIONS = ["direct_contradiction", "inferential_contradiction"];
export const isProposedConflict = (f: Finding) => CONTRADICTIONS.includes(f.classification);

const sideKey = (lines: readonly Line[], label: string) => lines.map((l) => `${label}:${l.ref}`);
const meets = (x: ArmFinding, y: ArmFinding) => {
  const lines = (a: ArmFinding, s: "a" | "b") => new Set(sideKey(a.verification[s].lines, s === "a" ? a.finding.session_a : a.finding.session_b));
  const shared = (p: Set<string>, q: Set<string>) => [...p].some((k) => q.has(k));
  const [xa, xb, ya, yb] = [lines(x, "a"), lines(x, "b"), lines(y, "a"), lines(y, "b")];
  return (shared(xa, ya) && shared(xb, yb)) || (shared(xa, yb) && shared(xb, ya));
};

// Two findings are the same when their cited lines overlap on both sides.
export function clusterFindings(items: readonly ArmFinding[]): Cluster[] {
  const clusters: ArmFinding[][] = [];
  for (const item of items) {
    const home = clusters.find((c) => c.some((m) => meets(m, item)));
    if (home) home.push(item);
    else clusters.push([item]);
  }
  return clusters.map((members) => ({ arms: [...new Set(members.map((m) => m.arm))].sort(), members }));
}

export function discoverySummary(items: readonly ArmFinding[]) {
  const proposed = items.filter((i) => isProposedConflict(i.finding));
  const clusters = clusterFindings(proposed);
  const arms = [...new Set(items.map((i) => i.arm))].sort();
  return {
    perArm: Object.fromEntries(arms.map((arm) => {
      const mine = proposed.filter((i) => i.arm === arm);
      return [arm, { proposed: mine.length, verified: mine.filter((i) => i.verification.status === "verified" || i.verification.status === "approximate").length, unique: clusters.filter((c) => c.arms.length === 1 && c.arms[0] === arm).length }];
    })),
    sharedByAtLeastTwoArms: clusters.filter((c) => c.arms.length > 1).length,
    distinctProposed: clusters.length,
  };
}

export type PairRow = { pairId: string; arm: string; classification: string; comparable: string; citationStatus: string };
export function pairAgreement(rows: readonly PairRow[]) {
  const arms = [...new Set(rows.map((r) => r.arm))].sort();
  const of = (arm: string) => new Map(rows.filter((r) => r.arm === arm).map((r) => [r.pairId, r]));
  const out: Record<string, { pairs: number; classification: number; comparable: number; disagreements: string[] }> = {};
  arms.forEach((x, i) => arms.slice(i + 1).forEach((y) => {
    const [p, q] = [of(x), of(y)];
    const both = [...p.keys()].filter((id) => q.has(id));
    const differ = both.filter((id) => p.get(id)!.classification !== q.get(id)!.classification);
    out[`${x}-${y}`] = { pairs: both.length, classification: both.length - differ.length, comparable: both.filter((id) => p.get(id)!.comparable === q.get(id)!.comparable).length, disagreements: differ };
  }));
  return out;
}

export type HumanLabel = { pairId: string; classification: string; comparable: string | null; reviewer: string; aiProposed: boolean };
// Only labels a person approved count; one AI-proposed row refuses the whole file.
export function pairAccuracy(rows: readonly PairRow[], labels: readonly HumanLabel[]) {
  if (labels.some((l) => l.aiProposed || !l.reviewer.trim())) throw new Error("Accuracy needs human-approved labels; AI-proposed labels are not ground truth.");
  const truth = new Map(labels.map((l) => [l.pairId, l]));
  const arms = [...new Set(rows.map((r) => r.arm))].sort();
  const conflict = (c: string) => CONTRADICTIONS.includes(c);
  return Object.fromEntries(arms.map((arm) => {
    const mine = rows.filter((r) => r.arm === arm && truth.has(r.pairId));
    return [arm, {
      labelled: mine.length,
      correct: mine.filter((r) => r.classification === truth.get(r.pairId)!.classification).length,
      falsePositives: mine.filter((r) => conflict(r.classification) && !conflict(truth.get(r.pairId)!.classification)).length,
      falseNegatives: mine.filter((r) => !conflict(r.classification) && conflict(truth.get(r.pairId)!.classification)).length,
    }];
  }));
}

// Known synthetic contradictions a finding recovered: both sides of the finding touch the target's lines.
export type Target = { id: string; a: string[]; b: string[] };
export const recovered = (targets: readonly Target[], items: readonly ArmFinding[]) =>
  targets.filter((t) => items.some((i) => {
    const refs = (s: "a" | "b") => i.verification[s].lines.map((l) => l.ref);
    const [sa, sb] = i.finding.session_a === "A" ? [refs("a"), refs("b")] : [refs("b"), refs("a")];
    return isProposedConflict(i.finding) && sa.some((r) => t.a.includes(r)) && sb.some((r) => t.b.includes(r));
  })).map((t) => t.id);
