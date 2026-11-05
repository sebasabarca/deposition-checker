import { describe, expect, it } from "vitest";
import { assess } from "../../server/src/adjudicate/assess";
import type { Packet, PacketExchange } from "../../server/src/adjudicate/packet";
import { assessPacketPair } from "../../server/src/adjudicate/packetAssess";
import type { IssuePacket, PacketPassage } from "../../server/src/adjudicate/packetPrompt";
import type { PairVerdict } from "../../server/src/adjudicate/packetSchema";
import type { Verdict } from "../../server/src/adjudicate/schema";
import { verifyPacketReply } from "../../server/src/verify/packet";
import { VERIFICATION_VERSION } from "../../server/src/verify/version";

const passage = (id: string, firstLine: number, witnessId: number, answer: string): PacketPassage => ({
  key: `d${id}#1-2`, id, depositionId: witnessId * 10 + firstLine, groupId: firstLine, witnessId, witnessName: `Witness ${witnessId}`, session: `s${id}`, takenOn: null, partIds: [firstLine], wholeExchange: true,
  lines: [
    { id: firstLine, page: 3, line: 4, text: "Q. Where were you on the night of March 3?", role: "question" },
    { id: firstLine + 1, page: 3, line: 5, text: `A. ${answer}`, role: "answer" },
  ],
  before: [{ id: firstLine - 1, page: 3, line: 3, text: "Q. Let's turn to March." }],
  after: [{ id: firstLine + 2, page: 3, line: 6, text: "Q. Next topic." }],
  gapBefore: false, gapAfter: false,
});

const A = passage("E10", 10, 1, "I was at the warehouse all night.");
const B = passage("E20", 20, 1, "I was at home with my wife all night.");
const packetOf = (a: PacketPassage, b: PacketPassage): IssuePacket => ({ id: "P1", passages: [a, b], pairs: [{ pairId: "R1", a: a.id, b: b.id }] });

const verdict = (over: Partial<PairVerdict> = {}): PairVerdict => ({
  pairId: "R1", outcome: "direct", evidenceAId: "E10", evidenceBId: "E20", keyPhraseA: "I was at the warehouse all night", keyPhraseB: "I was at home with my wife all night",
  attributionA: "asserted", attributionB: "asserted", stanceA: "affirms", stanceB: "affirms", sameEvent: "yes", scopeAligned: "yes",
  conflictBasis: "mutually_exclusive", conflictSource: "cited_exchanges", falsePositiveReason: null, explanation: "Two places on one night.",
  alternativeExplanation: null, alternativeSupport: null, contextUsed: [], ...over,
});

const run = (v: PairVerdict | null, packet = packetOf(A, B), reply: Parameters<typeof verifyPacketReply>[1] = { ok: true, reply: { verdicts: v ? [v] : [] } }) =>
  assessPacketPair(packet, verifyPacketReply(packet, reply).pairs[0]);

describe("assessPacketPair", () => {
  it("scores a verified direct pair and gives it a priority", () => {
    const f = run(verdict())!;
    expect(f.type).toBe("direct");
    expect(f.outcome).toBe("direct");
    expect(f.evidenceStatus).toBe("verified");
    expect(f.attributionA).toBe("clear");
    expect(f.score).toBeGreaterThan(0);
    expect(f.band).not.toBeNull();
    expect(["high", "medium"]).toContain(f.priority);
    expect(f.contextRequested).toBe(false);
  });

  it("gives a false positive its low priority", () => {
    const f = run(verdict({ outcome: "false_positive", conflictBasis: "none", conflictSource: "none", falsePositiveReason: "different_event", sameEvent: "no" }))!;
    expect(f.type).toBe("false_positive");
    expect(f.unscoredReason).toBeNull();
    expect(f.band).toBe("high");
    expect(f.priority).toBe("low");
  });

  it("keeps needs_more_context as an unscored abstention with its context request", () => {
    const f = run(verdict({ outcome: "needs_more_context", conflictBasis: "none", conflictSource: "none" }))!;
    expect(f.outcome).toBe("needs_more_context");
    expect(f.type).toBe("insufficient_evidence");
    expect(f.score).toBeNull();
    expect(f.unscoredReason).toBe("insufficient_evidence");
    expect(f.contextRequested).toBe(true);
    expect(f.priority).toBe("needs_context");
  });

  it("marks an unfound quote unsupported, unscored and low priority", () => {
    const f = run(verdict({ keyPhraseB: "I flew to Paris that evening" }))!;
    expect(f.evidenceStatus).toBe("unsupported");
    expect(f.score).toBeNull();
    expect(f.unscoredReason).toBe("evidence");
    expect(f.priority).toBe("low");
    expect(f.attributionB).toBeNull();
    expect((f.checks.source as { b: { diagnosis?: string } }).b.diagnosis).toBe("unsupported_quotation");
  });

  it("verifies and scores a cross-witness pair against each side's own witness", () => {
    const f = run(verdict(), packetOf(A, passage("E20", 20, 2, "I was at home with my wife all night.")))!;
    expect(f.evidenceStatus).toBe("verified");
    expect(f.score).not.toBeNull();
  });

  it("leaves a verdict with a deterministic consistency issue unscored", () => {
    const f = run(verdict({ falsePositiveReason: "different_event" }))!;
    expect((f.checks.consistencyIssues as string[])).toContain("false_positive_reason_on_non_false_positive");
    expect(f.score).toBeNull();
    expect(f.unscoredReason).toBe("inconsistent_verdict");
    expect(f.priority).toBe("needs_context");
  });

  it("returns no finding for a missing, malformed, duplicate or failed pair", () => {
    expect(run(null)).toBeNull();
    expect(run(null, packetOf(A, B), { ok: true, verdicts: [], malformed: [{ pairId: "R1", error: "bad" } as never] })).toBeNull();
    expect(run(null, packetOf(A, B), { ok: true, reply: { verdicts: [verdict(), verdict()] } })).toBeNull();
    expect(run(null, packetOf(A, B), { ok: false, error: "timeout" })).toBeNull();
  });

  it("records the verification version and the contract", () => {
    const f = run(verdict())!;
    expect(f.checks.verificationVersion).toBe(VERIFICATION_VERSION);
    expect(f.checks.contract).toBe("packet-v1");
    for (const k of ["source", "attribution", "context", "corroboration", "timeCheck", "reviewFlags", "requiresReview", "notCorroborated", "reasons"]) expect(f.checks).toHaveProperty(k);
    expect((f.checks.source as { a: { cited?: string } }).a.cited).toBe("exchange");
  });

  it("agrees with assess() on the equivalent single-witness pairwise verdict", () => {
    const exchange = (p: PacketPassage, session: "A" | "B"): PacketExchange => ({ id: p.id, depositionId: p.depositionId, groupId: p.groupId, session, takenOn: null, witnessId: p.witnessId, partIds: p.partIds, wholeExchange: p.wholeExchange, lines: p.lines, before: p.before, after: p.after, gapBefore: p.gapBefore, gapAfter: p.gapAfter });
    const pairwise: Packet = { candidateId: 1, witnessId: 1, witnessName: "Witness 1", a: exchange(A, "A"), b: exchange(B, "B") };
    for (const over of [{}, { outcome: "false_positive", conflictBasis: "none", conflictSource: "none", falsePositiveReason: "different_event", sameEvent: "no" }] as Partial<PairVerdict>[]) {
      const v = verdict(over);
      const { pairId: _p, outcome, conflictSource: _c, contextUsed: _u, alternativeSupport: _s, ...rest } = v;
      const single: Verdict = { ...rest, classification: outcome as Verdict["classification"], keyPhraseA: v.keyPhraseA!, keyPhraseB: v.keyPhraseB!, aboutTimingOfSameEvent: false, inferenceSteps: [], unestablishedAssumptions: [], needsMoreContext: false };
      const expected = assess(pairwise, single);
      const f = run(v)!;
      expect({ score: f.score, band: f.band, priority: f.priority, evidenceStatus: f.evidenceStatus }).toEqual({ score: expected.assessment.score, band: expected.assessment.band, priority: expected.priority, evidenceStatus: expected.checks.source.status });
      expect(f.factors).toEqual(expected.assessment.factors);
    }
  });
});

describe("assessPacketPair safeguards (verify/safeguards.ts)", () => {
  const safeguardsOf = (f: NonNullable<ReturnType<typeof run>>) => (f.checks.safeguards as { rule: string }[]).map((s) => s.rule);

  it("publishes a plain verified contradiction unchanged, with no safeguard", () => {
    const f = run(verdict())!;
    expect(f.type).toBe("direct");
    expect(safeguardsOf(f)).toEqual([]);
  });

  it("publishes reported speech as needs context: kept, model outcome and explanation preserved, never deleted", () => {
    const f = run(verdict({ attributionB: "reported_by_other", alternativeExplanation: "She may be repeating what she was told.", alternativeSupport: "plausible" }))!;
    expect(f).not.toBeNull();
    expect(f.outcome).toBe("direct"); // what the model said
    expect(f.type).toBe("insufficient_evidence"); // what is published
    expect(f.priority).toBe("needs_context");
    expect(f.contextRequested).toBe(true);
    expect(safeguardsOf(f)).toContain("not_own_knowledge");
  });

  it("publishes a verdict whose own explanation concedes both can be true as needs context", () => {
    const f = run(verdict({ outcome: "inferential", conflictBasis: "requires_inference", explanation: "Both can be true if these were different nights." }))!;
    expect(f.type).toBe("insufficient_evidence");
    expect(safeguardsOf(f)).toEqual(["says_compatible"]);
  });

  it("publishes a no-recall answer against an assertion as needs context", () => {
    const f = run(verdict({ keyPhraseB: "I don't recall" }), packetOf(A, passage("E20", 20, 1, "I don't recall.")))!;
    expect(f.type).toBe("insufficient_evidence");
    expect(safeguardsOf(f)).toContain("no_recall");
  });

  it("publishes the examiner's words quoted as the witness's as needs context", () => {
    const f = run(verdict({ keyPhraseB: "Where were you on the night of March 3" }))!;
    expect(safeguardsOf(f)).toContain("examiner_words");
    expect(f.type).toBe("insufficient_evidence");
  });
});
