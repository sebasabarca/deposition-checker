import { describe, expect, it } from "vitest";
import { callCost } from "../../server/src/costs";
import { costOf, estimateRequestCost, labelFor, scoreArm, selectPilotSample, type PairResult } from "../../server/src/eval/packetBenchmark";
import type { FrozenPair } from "../../server/src/retrieve/frozen";
import type { EvidencePacket } from "../../server/src/retrieve/grouping";

const labels: FrozenPair[] = [
  { id: "T1", category: "conflict", source: "x", left: ["a1", "a2"], right: ["b1"] },
  { id: "T2", category: "review_worthy", source: "x", left: ["c1"], right: ["d1"] },
  { id: "N1", category: "no_conflict", source: "x", left: ["e1"], right: ["f1"] },
  { id: "X1", category: "exploratory", source: "x", left: ["g1"], right: ["h1"] },
];
const row = (a: string, b: string, over: Partial<PairResult> = {}): PairResult => ({
  corpus: "c2", evidence: "synthetic", packetId: "P1", a, b, pairStatus: "answered", outcome: "direct", sourceStatus: "verified", citationsValid: true, attributionErrors: 0, consistencyIssues: 0, ...over,
});

describe("labels", () => {
  it("joins a candidate pair to its label in either orientation, and leaves the rest unknown", () => {
    expect(labelFor(labels, "b1", "a2")).toMatchObject({ id: "T1", kind: "target", targetClass: "direct" });
    expect(labelFor(labels, "a1", "c1")).toBeNull();
  });
});

describe("scoreArm", () => {
  it("counts each labelled target once, from its best row, and needs valid citations to call it identified", () => {
    const s = scoreArm("packet", [row("a1", "b1", { outcome: "false_positive" }), row("a2", "b1"), row("c1", "d1", { citationsValid: false, sourceStatus: "unsupported" })], labels);
    expect(s.identifiedTargets).toBe(1);
    expect(s.evidence.combined.identifiedTargetsByClass.direct).toEqual(["T1"]);
    expect(s.evidence.combined.flaggedWithoutValidCitations).toEqual(["T2"]);
    expect(s.evidence.combined.missedTargets).toEqual({});
    expect(s.evidence.combined.identifiedClean).toEqual(["T1"]);
    const noisy = scoreArm("packet", [row("a1", "b1", { attributionErrors: 1 })], labels).evidence.combined;
    expect([noisy.identifiedTargets, noisy.identifiedClean]).toEqual([1, []]);
  });

  it("lists every missed target by why, including unanswered ones", () => {
    const s = scoreArm("pairwise", [row("a1", "b1", { pairStatus: "missing", outcome: null, sourceStatus: null, citationsValid: false }), row("c1", "d1", { outcome: "needs_more_context", sourceStatus: "not_cited", citationsValid: false })], labels);
    expect(s.evidence.combined.missedTargets).toEqual({ missing: ["T1:direct"], needs_more_context: ["T2:unclassified"] });
    expect(s.evidence.combined.unanswered).toEqual({ missing: 1 });
    expect(s.evidence.combined.abstentions).toEqual({ needs_more_context: 1 });
  });

  it("reports flagged controls, never scores unlabelled or exploratory pairs, and accounts for every row", () => {
    const rows = [row("e1", "f1"), row("g1", "h1"), row("z1", "z2"), row("z3", "z4", { outcome: "false_positive" }), row("z5", "z6", { pairStatus: "duplicate", outcome: null, sourceStatus: null, citationsValid: false })];
    const c = scoreArm("packet", rows, labels).evidence.combined;
    expect(c.flaggedControls).toEqual(["N1"]);
    expect(c.exploratory).toEqual({ direct: 1 });
    expect(c.unlabelled).toEqual({ direct: 1, false_positive: 1, duplicate: 1 });
    expect(c.identifiedTargets).toBe(0);
    expect(Object.values(c.buckets).reduce((n, x) => n + x, 0)).toBe(rows.length);
    expect(c.total).toBe(rows.length);
  });

  it("keeps real and synthetic evidence apart", () => {
    const s = scoreArm("packet", [row("a1", "b1"), row("c1", "d1", { evidence: "real" })], labels);
    expect(s.evidence.synthetic.identifiedTargets).toBe(1);
    expect(s.evidence.real.identifiedTargets).toBe(1);
    expect(s.evidence.combined.identifiedTargets).toBe(2);
  });
});

describe("selectPilotSample", () => {
  const packets: EvidencePacket[] = [
    { id: "p1", issue: "", items: [], pairs: [["e1", "f1"]], inputTokens: 1 },
    { id: "p2", issue: "", items: [], pairs: [["a1", "b1"], ["c1", "d1"]], inputTokens: 1 },
    { id: "p3", issue: "", items: [], pairs: [["c1", "d1"]], inputTokens: 1 },
    ...Array.from({ length: 6 }, (_, i): EvidencePacket => ({ id: `r${i}`, issue: "", items: [], pairs: [[`u${i}`, `v${i}`]], inputTokens: 1 })),
  ];
  const labelsWithLost = [...labels, { id: "LOST", category: "conflict", source: "x", left: ["q"], right: ["w"] }];

  it("takes target packets first, then controls, then a seeded fill, and reports labels left out", () => {
    const s = selectPilotSample({ corpus: "c", evidence: "synthetic", packets, labels: labelsWithLost, quota: 4, seed: 7 });
    expect(s.reasons).toMatchObject({ p2: "target", p1: "control" });
    expect(s.packetIds).not.toContain("p3"); // its only target is already covered by p2
    expect(s.packetIds).toHaveLength(4);
    expect(Object.values(s.reasons).filter((r) => r === "random")).toHaveLength(2);
    expect(s.labelledInNoPacket).toEqual(expect.arrayContaining(["LOST", "X1"]));
    expect(s.labelledNotInSample).toContain("LOST");
  });

  it("is deterministic for a seed", () => {
    const a = selectPilotSample({ corpus: "c", evidence: "real", packets, labels, quota: 5, seed: 3 });
    const b = selectPilotSample({ corpus: "c", evidence: "real", packets, labels, quota: 5, seed: 3 });
    expect(a).toEqual(b);
  });
});

describe("cost", () => {
  it("never estimates a worst case below the expected cost; the worst case uses bytes, max output and retries", () => {
    const input = { systemChars: 9_000, userChars: 12_000, schemaChars: 4_000, systemBytes: 9_100, userBytes: 12_300, schemaBytes: 4_000, maxOutputTokens: 8_000, retries: 1, pairs: 4, model: "claude-sonnet-5-5" };
    const e = estimateRequestCost(input);
    expect(e.worstCase.usd!).toBeGreaterThan(e.expected.usd!);
    expect(e.worstCase.usd).toBeCloseTo(callCost("claude-sonnet-5-5", { input: 25_400 * 2, output: 16_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 })!.costUsd, 10);
    expect(e.expected.tokens).toBe(Math.ceil(25_000 / 3.5) + 1_500 + 350 * 4);
  });

  it("prices measured usage and divides by identified targets", () => {
    const c = costOf("packet", [{ inputTokens: 1_000_000, outputTokens: 100_000 }], "claude-sonnet-5-5", 4);
    expect(c.costUsd).toBeCloseTo(2 + 1, 6); // $2 per million input, $10 per million output
    expect(c.costPerIdentifiedTarget).toBeCloseTo(0.75, 6);
    expect(costOf("packet", [], "claude-sonnet-5-5", 0).costPerIdentifiedTarget).toBeNull();
  });
});
