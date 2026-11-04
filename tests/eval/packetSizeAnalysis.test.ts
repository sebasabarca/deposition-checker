import { describe, expect, it } from "vitest";
import { analyzeRun, binLabel, consistencyIssues, indicatorsOf, mcnemarP, repeatVariance, SIZE_BINS, spearman, TOKEN_BINS, type PairRow, type ReplyRow } from "../../scripts/packet-size-analysis";

const side = (disagreement: string | null = null) => ({ source: "verified", attribution: { disagreement } });
const row = (o: Partial<PairRow>): PairRow => ({ arm: "packet", repeat: false, corpus: "c1", packetId: "p1", request: "p1", pairId: "R1", a: "x", b: "y", status: "answered", outcome: "false_positive", validationFailures: [], sideA: side(), sideB: side(), ...o });
const v1 = { outcome: "false_positive", conflictSource: "none", conflictBasis: "none", falsePositiveReason: "different_event", alternativeExplanation: null, alternativeSupport: null };
const reply = (arm: "packet" | "pairwise", packetId: string, verdicts: object[], tokens = 1000, repeat = false): ReplyRow => ({ arm, corpus: "c1", packetId, repeat, reply: { text: JSON.stringify({ verdicts }), usage: { inputTokens: tokens, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 5 }, stopReason: "end_turn" } });

describe("consistencyIssues", () => {
  it("applies the packet-v1 rules", () => {
    expect(consistencyIssues({ pairId: "R1", ...v1 })).toEqual([]);
    expect(consistencyIssues({ pairId: "R1", ...v1, outcome: "direct", conflictBasis: "explicit" })).toEqual(["ungrounded", "false_positive_reason_on_non_false_positive"]);
  });
  it("applies the packet-v2 rules when there is no falsePositiveReason", () => {
    const base = { pairId: "R1", conflictSource: "cited_exchanges", conflictBasis: "explicit", alternativeExplanation: null, alternativeSupport: null };
    expect(consistencyIssues({ ...base, outcome: "direct", detailsCompared: [{ relation: "different" }] })).toEqual([]);
    expect(consistencyIssues({ ...base, outcome: "direct", detailsCompared: [] })).toEqual(["direct_without_different_detail", "conflict_without_details"]);
    expect(consistencyIssues({ ...base, outcome: "compatible", conflictSource: "none", detailsCompared: [] })).toEqual(["conflict_basis_on_non_conflict"]);
  });
});

describe("indicatorsOf", () => {
  it("counts unanswered apart from citation, consistency and attribution", () => {
    expect(indicatorsOf(row({ status: "missing", validationFailures: ["missing verdict"] }), null)).toEqual({ unanswered: true, invalidCitation: false, consistency: false, attribution: false, anyError: true });
    const f = indicatorsOf(row({ validationFailures: ["B source wrong_reference"], sideB: side("claude_overstates") }), { pairId: "R1", ...v1 });
    expect(f).toEqual({ unanswered: false, invalidCitation: true, consistency: false, attribution: true, anyError: true });
    expect(indicatorsOf(row({ validationFailures: ["both sides cite the same passage"] }), null).invalidCitation).toBe(true);
  });
});

describe("statistics", () => {
  it("bins sizes and tokens", () => {
    expect([1, 2, 3, 5, 8, 9, 40].map((n) => binLabel(n, SIZE_BINS))).toEqual(["1", "2-3", "2-3", "4-5", "6-8", "9+", "9+"]);
    expect(binLabel(5000, TOKEN_BINS)).toBe("5000-5999");
  });
  it("computes Spearman with ties and refuses constant input", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1);
    expect(spearman([1, 2, 2, 3], [1, 2, 3, 4])).toBeCloseTo(0.9487, 3);
    expect(spearman([1, 2, 3], [5, 5, 5])).toBeNull();
  });
  it("gives the exact McNemar p-value", () => {
    expect(mcnemarP(0, 0)).toBe(1);
    expect(mcnemarP(5, 0)).toBeCloseTo(0.0625);
    expect(mcnemarP(3, 3)).toBe(1);
  });
});

describe("analyzeRun", () => {
  // A 2-pair packet (p1) and a 1-pair packet (p2), each pair also sent alone.
  const pairs: PairRow[] = [
    row({ pairId: "R1", a: "x", b: "y", outcome: "direct", validationFailures: ["A source unsupported"] }),
    row({ pairId: "R2", a: "x", b: "z", status: "missing", outcome: null, validationFailures: ["missing verdict"] }),
    row({ packetId: "p2", request: "p2", a: "u", b: "v" }),
    row({ arm: "pairwise", request: "p1/R1", a: "x", b: "y", outcome: "false_positive" }),
    row({ arm: "pairwise", request: "p1/R2", a: "x", b: "z" }),
    row({ arm: "pairwise", packetId: "p2", request: "p2/R1", a: "u", b: "v" }),
    row({ repeat: true, pairId: "R1", a: "x", b: "y", outcome: "false_positive" }),
  ];
  const direct = { ...v1, outcome: "direct", conflictSource: "cited_exchanges", conflictBasis: "explicit", falsePositiveReason: null };
  const replies: ReplyRow[] = [
    reply("packet", "p1", [{ pairId: "R1", ...direct }], 6000),
    reply("packet", "p2", [{ pairId: "R1", ...v1 }]),
    reply("pairwise", "p1/R1", [{ pairId: "R1", ...v1 }]),
    reply("pairwise", "p1/R2", [{ pairId: "R1", ...v1 }]),
    reply("pairwise", "p2/R1", [{ pairId: "R1", ...v1 }]),
    reply("packet", "p1", [{ pairId: "R1", ...v1 }], 6000, true),
  ];
  const r = analyzeRun("t", "packet-v1", pairs, replies);

  it("describes each packet request", () => {
    expect(r.perRequest).toEqual([
      { key: "c1/p1", corpus: "c1", packetId: "p1", pairs: 2, passages: 3, inputTokens: 6010, outputTokens: 10, stopReason: "end_turn" },
      { key: "c1/p2", corpus: "c1", packetId: "p2", pairs: 1, passages: 2, inputTokens: 1010, outputTokens: 10, stopReason: "end_turn" },
    ]);
  });
  it("pairs each packet result with its own pairwise result, by size bin", () => {
    expect(r.pairs).toBe(3);
    const two = r.bySize.find((b) => b.bin === "2-3")!;
    expect(two.pairs).toBe(2);
    expect(two.anyError).toMatchObject({ packet: 2, pairwise: 0, difference: 1, packetOnly: 2, pairwiseOnly: 0 });
    expect(two.outcomeDiffers).toEqual({ n: 1, k: 1, rate: 1 });
    expect(two.conflictDiffers.k).toBe(1);
    expect(r.bySize.find((b) => b.bin === "1")!.anyError).toMatchObject({ packet: 0, pairwise: 0 });
    expect(r.byInputTokens.find((b) => b.bin === "6000-6999")!.pairs).toBe(2);
  });
  it("keeps repeats out of the main tables and reports their variance", () => {
    expect(r.totals.anyError).toEqual({ packet: 2, pairwise: 0 });
    expect(repeatVariance(pairs)).toMatchObject({ packet: { n: 1, outcomeChanged: 1, conflictChanged: 1 } });
  });
});
