// DESIGN.md's representative scoring cases (rubric v1), run end to end from transcript lines:
// Layer 1, Layer 2, code's checks, score() and prioritize(). Each case asserts the score, band,
// priority, every component's points and the caps, not only the total.

import { describe, expect, it } from "vitest";
import { assess, type TaggedClaim } from "../../server/src/adjudicate/assess";
import type { Packet, PacketExchange } from "../../server/src/adjudicate/packet";
import { Verdict } from "../../server/src/adjudicate/schema";
import { prioritize, RUBRIC_V1, score, type Assessment } from "../../server/src/score";
import type { Level } from "../../server/src/verify";

type Row = ["question" | "answer" | "context", string];
let nextLine = 1;

function side(session: "A" | "B", rows: Row[], { whole = true, context = true } = {}): PacketExchange {
  const id = session === "A" ? "E1" : "E2";
  const line = (text: string) => ({ id: nextLine, page: 10, line: nextLine++ % 25 || 1, text });
  const before = context ? [line("Q. Let's turn to the next topic.")] : [];
  const prefix = { question: "Q. ", answer: "A. ", context: "" };
  const lines = rows.map(([role, text]) => ({ ...line(prefix[role] + text), role }));
  const after = context ? [line("Q. Thank you.")] : [];
  return { id, depositionId: session === "A" ? 1 : 2, groupId: 1, session, takenOn: null, witnessId: 7, partIds: [1], wholeExchange: whole, lines, before, after, gapBefore: false, gapAfter: false };
}

const packet = (a: Row[], b: Row[]): Packet => ({ candidateId: 1, witnessId: 7, witnessName: "W", a: side("A", a), b: side("B", b) });

const verdict = (fields: Partial<Verdict>): Verdict => ({
  classification: "direct",
  evidenceAId: "E1",
  evidenceBId: "E2",
  keyPhraseA: "",
  keyPhraseB: "",
  attributionA: "asserted",
  attributionB: "asserted",
  stanceA: "affirms",
  stanceB: "affirms",
  sameEvent: "yes",
  scopeAligned: "yes",
  conflictBasis: "explicit_negation",
  aboutTimingOfSameEvent: false,
  inferenceSteps: [],
  unestablishedAssumptions: [],
  falsePositiveReason: null,
  explanation: "",
  alternativeExplanation: null,
  needsMoreContext: false,
  ...fields,
});

const components = (a: Assessment) => {
  const sum = (c: string) => a.factors.filter((f) => f.component === c).reduce((t, f) => t + f.points, 0);
  return { A: sum("A"), C: sum("C"), S: sum("S"), K: sum("K"), U: sum("U") };
};
const caps = (a: Assessment) => a.capsApplied.map((c) => `${c.rule}:${c.limit}${c.binding ? "*" : ""}`).sort();

const APPROVE_Q: Row = ["question", "Did you approve the transaction?"];
const steps = [{ statement: "Signing the term sheet is approving the acquisition.", supportingIds: ["E1", "E2"] }];

type Case = {
  name: string;
  packet: Packet;
  verdict: Verdict;
  pathA?: { a: TaggedClaim[]; b: TaggedClaim[] };
  expected: { score: number | null; band: string | null; priority: string; parts?: ReturnType<typeof components>; caps?: string[]; unscored?: string };
};

const CASES: Case[] = [
  {
    name: "1 verified direct",
    packet: packet([["answer", "I was at the Bellevue office on March 3."]], [["answer", "I was not at the Bellevue office on March 3."]]),
    verdict: verdict({ keyPhraseA: "I was at the Bellevue office on March 3", keyPhraseB: "I was not at the Bellevue office on March 3" }),
    expected: { score: 95, band: "high", priority: "high", parts: { A: 20, C: 10, S: 30, K: 10, U: 25 }, caps: [] },
  },
  {
    name: "2 inferential, different wording",
    packet: packet([["answer", "I never approved the PeopleSoft acquisition."]], [["answer", "I signed the final PeopleSoft term sheet."]]),
    verdict: verdict({
      classification: "inferential",
      keyPhraseA: "I never approved the PeopleSoft acquisition",
      keyPhraseB: "I signed the final PeopleSoft term sheet",
      conflictBasis: "requires_inference",
      inferenceSteps: steps,
      unestablishedAssumptions: ["Signing the term sheet is approval."],
      alternativeExplanation: "He may have signed a sheet someone else approved.",
    }),
    expected: { score: 75, band: "high", priority: "high", parts: { A: 20, C: 10, S: 25, K: 5, U: 15 }, caps: [] },
  },
  {
    name: "3 strong inferential, no lexical corroboration",
    packet: packet([["answer", "I had nothing to do with approving that deal."]], [["answer", "I signed off on it myself."]]),
    verdict: verdict({ classification: "inferential", keyPhraseA: "I had nothing to do with approving that deal", keyPhraseB: "I signed off on it myself", conflictBasis: "requires_inference", inferenceSteps: steps }),
    expected: { score: 85, band: "high", priority: "high", parts: { A: 20, C: 10, S: 30, K: 0, U: 25 }, caps: [] },
  },
  {
    name: "4 compatible approximate times",
    packet: packet([["answer", "I left around 8."]], [["answer", "I left at 8:05."]]),
    verdict: verdict({ keyPhraseA: "I left around 8", keyPhraseB: "I left at 8:05", conflictBasis: "value_conflict", aboutTimingOfSameEvent: true }),
    expected: { score: 60, band: "medium", priority: "medium", parts: { A: 20, C: 10, S: 30, K: 0, U: 20 }, caps: ["times_compatible:60*"] },
  },
  {
    name: "5 a plain Yes adopts the question",
    packet: packet([APPROVE_Q, ["answer", "Yes."]], [["answer", "I never approved that transaction."]]),
    verdict: verdict({ keyPhraseA: "Did you approve the transaction", keyPhraseB: "I never approved that transaction" }),
    expected: { score: 90, band: "high", priority: "high", parts: { A: 20, C: 10, S: 30, K: 5, U: 25 }, caps: [] },
  },
  {
    name: "6a a plain No is a denial",
    packet: packet([APPROVE_Q, ["answer", "No."]], [["answer", "I approved the transaction."]]),
    verdict: verdict({ keyPhraseA: "Did you approve the transaction", keyPhraseB: "I approved the transaction", stanceA: "denies" }),
    expected: { score: 90, band: "high", priority: "high", parts: { A: 20, C: 10, S: 30, K: 5, U: 25 }, caps: [] },
  },
  {
    name: "6b code catches a misread denial",
    packet: packet([APPROVE_Q, ["answer", "No."]], [["answer", "I never approved it."]]),
    verdict: verdict({ keyPhraseA: "Did you approve the transaction", keyPhraseB: "I never approved it", stanceA: "affirms" }),
    expected: { score: 40, band: "low", priority: "medium", parts: { A: 12, C: 10, S: 30, K: 0, U: 25 }, caps: ["side_not_adopted_or_no_recall:40*"] },
  },
  {
    name: "6c an unclear answer is never read as Yes",
    packet: packet([APPROVE_Q, ["answer", "Not exactly. I reviewed the numbers."]], [["answer", "I approved the transaction myself."]]),
    verdict: verdict({ keyPhraseA: "Did you approve the transaction", keyPhraseB: "I approved the transaction myself", stanceA: "unclear", alternativeExplanation: "Reviewing may not be approving." }),
    expected: { score: 67, band: "medium", priority: "medium", parts: { A: 12, C: 10, S: 30, K: 0, U: 15 }, caps: ["side_qualified_or_uncertain:70"] },
  },
  {
    name: "7 qualified testimony cannot reach High",
    packet: packet([["answer", "I think I approved the Hartley contract."]], [["answer", "I never approved the Hartley contract."]]),
    verdict: verdict({ keyPhraseA: "I approved the Hartley contract", keyPhraseB: "I never approved the Hartley contract", attributionA: "qualified", alternativeExplanation: "He was unsure." }),
    expected: { score: 70, band: "medium", priority: "medium", parts: { A: 16, C: 10, S: 30, K: 10, U: 15 }, caps: ["side_qualified_or_uncertain:70*"] },
  },
  {
    name: "8a failing to recall is not an assertion",
    packet: packet([APPROVE_Q, ["answer", "I don't remember."]], [["answer", "I approved the transaction."]]),
    verdict: verdict({ keyPhraseA: "Did you approve the transaction", keyPhraseB: "I approved the transaction", attributionA: "asserted" }),
    pathA: { a: [{ keyPhrase: "Did you approve the transaction", epistemic: "does_not_recall" }], b: [] },
    expected: { score: 40, band: "low", priority: "medium", parts: { A: 12, C: 10, S: 30, K: 0, U: 20 }, caps: ["side_not_adopted_or_no_recall:40*"] },
  },
  {
    name: "8b no recollection supports a false positive",
    packet: packet([APPROVE_Q, ["answer", "I don't remember."]], [["answer", "I approved the transaction."]]),
    verdict: verdict({
      classification: "false_positive",
      keyPhraseA: "Did you approve the transaction",
      keyPhraseB: "I approved the transaction",
      attributionA: "does_not_recall",
      stanceA: "unclear",
      conflictBasis: "none",
      falsePositiveReason: "uncertain_recollection",
    }),
    pathA: { a: [{ keyPhrase: "Did you approve the transaction", epistemic: "does_not_recall" }], b: [] },
    expected: { score: 90, band: "high", priority: "low", parts: { A: 20, C: 10, S: 30, K: 5, U: 25 }, caps: [] },
  },
  {
    name: "9a an attorney's words are not testimony",
    packet: packet([["question", "So you approved the Hartley contract in March."], ["context", "MR. HALE: Objection. Form."]], [["answer", "I never approved the Hartley contract."]]),
    verdict: verdict({ keyPhraseA: "So you approved the Hartley contract in March", keyPhraseB: "I never approved the Hartley contract" }),
    expected: { score: 40, band: "low", priority: "medium", parts: { A: 12, C: 10, S: 30, K: 5, U: 25 }, caps: ["side_not_adopted_or_no_recall:40*"] },
  },
  {
    name: "9b both sides are attorney statements",
    packet: packet([["question", "So you approved the Hartley contract in March."]], [["question", "And you never approved the Hartley contract."]]),
    verdict: verdict({ keyPhraseA: "So you approved the Hartley contract in March", keyPhraseB: "you never approved the Hartley contract", attributionA: "attorney_statement", attributionB: "attorney_statement" }),
    expected: { score: null, band: null, priority: "needs_context", unscored: "no_witness_assertion" },
  },
  {
    name: "10 incorrect exchange reference",
    packet: packet([["answer", "I was at the Bellevue office on March 3."]], [["answer", "I was not at the Bellevue office on March 3."]]),
    verdict: verdict({ keyPhraseA: "I was not at the Bellevue office on March 3", keyPhraseB: "I was not at the Bellevue office on March 3", evidenceAId: "E1" }),
    expected: { score: null, band: null, priority: "low", unscored: "evidence" },
  },
  {
    name: "11 fabricated quotation",
    packet: packet([["answer", "I was at the Bellevue office on March 3."]], [["answer", "I was not at the Bellevue office on March 3."]]),
    verdict: verdict({ keyPhraseA: "I personally signed the Redwood merger papers", keyPhraseB: "I was not at the Bellevue office on March 3" }),
    expected: { score: null, band: null, priority: "low", unscored: "evidence" },
  },
  {
    name: "12 high-confidence false positive",
    packet: packet([["answer", "I got there around 8."]], [["answer", "I arrived at about 8:10."]]),
    verdict: verdict({
      classification: "false_positive",
      keyPhraseA: "I got there around 8",
      keyPhraseB: "I arrived at about 8:10",
      conflictBasis: "none",
      aboutTimingOfSameEvent: true,
      falsePositiveReason: "compatible_approximation",
    }),
    expected: { score: 95, band: "high", priority: "low", parts: { A: 20, C: 10, S: 30, K: 10, U: 25 }, caps: [] },
  },
  {
    name: "13 direct with sameEvent = no",
    packet: packet([["answer", "I went to the meeting."]], [["answer", "I did not go to the conference."]]),
    verdict: verdict({ keyPhraseA: "I went to the meeting", keyPhraseB: "I did not go to the conference", sameEvent: "no" }),
    expected: { score: 25, band: "low", priority: "needs_context", parts: { A: 20, C: 10, S: 18, K: 0, U: 25 }, caps: ["same_event_no:25*"] },
  },
];

describe("rubric v1: DESIGN.md's representative cases", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const { assessment, priority, checks } = assess(c.packet, c.verdict, c.pathA);
      expect({ score: assessment.score, band: assessment.band, priority }).toEqual({ score: c.expected.score, band: c.expected.band, priority: c.expected.priority });
      expect(assessment.rubricVersion).toBe("v1");
      if (c.expected.unscored) {
        expect(assessment.unscoredReason).toBe(c.expected.unscored);
        expect(assessment.factors).toEqual([]);
      } else {
        expect(components(assessment)).toEqual(c.expected.parts);
        expect(caps(assessment)).toEqual(c.expected.caps);
        expect(checks.source.status).toBe("verified");
      }
    });
  }

  it("10 and 11 report the evidence status that put them in the Unverified section", () => {
    expect(assess(CASES[13].packet, CASES[13].verdict).checks.source.status).toBe("wrong_reference");
    expect(assess(CASES[14].packet, CASES[14].verdict).checks.source.status).toBe("unsupported");
  });

  it("14 is deterministic, whatever the order of the verdict's keys", () => {
    for (const c of CASES) {
      const reordered = Object.fromEntries(Object.entries(c.verdict).reverse()) as Verdict;
      expect(assess(c.packet, reordered, c.pathA)).toEqual(assess(c.packet, c.verdict, c.pathA));
    }
  });
});

describe("rubric v1: attribution cap matrix (case 15)", () => {
  const base = assess(CASES[0].packet, CASES[0].verdict);
  const input = (classification: Verdict["classification"], a: Level, b: Level) => ({
    verdict: { ...CASES[0].verdict, classification, falsePositiveReason: classification === "false_positive" ? ("both_can_be_true" as const) : null },
    ...base.checks,
    attribution: { a: { ...base.checks.attribution.a, level: a }, b: { ...base.checks.attribution.b, level: b } },
  });
  const MATRIX: [Level, Level, number | "unscored" | null][] = [
    ["clear", "clear", null],
    ["clear", "qualified", 70],
    ["clear", "uncertain", 70],
    ["qualified", "qualified", 70],
    ["clear", "not_adopted", 40],
    ["qualified", "no_recall", 40],
    ["uncertain", "uncertain", "unscored"],
    ["uncertain", "not_adopted", "unscored"],
    ["not_adopted", "no_recall", "unscored"],
  ];
  for (const classification of ["direct", "inferential"] as const) {
    for (const [a, b, expected] of MATRIX) {
      it(`${classification} (${a}, ${b}): ${expected ?? "no cap"}`, () => {
        const result = score(input(classification, a, b));
        if (expected === "unscored") return expect(result.unscoredReason).toBe("no_witness_assertion");
        const attributionCaps = result.capsApplied.filter((c) => c.rule.startsWith("side_"));
        expect(attributionCaps.length === 0 ? null : Math.min(...attributionCaps.map((c) => c.limit))).toBe(expected);
        if (expected !== null) expect(result.score).toBeLessThanOrEqual(expected);
      });
    }
  }
  it("applies no attribution cap to a false positive", () => {
    for (const [a, b] of MATRIX) {
      const result = score(input("false_positive", a, b));
      expect(result.eligible).toBe(true);
      expect(result.capsApplied.filter((c) => c.rule.startsWith("side_"))).toEqual([]);
    }
  });
});

describe("rubric v1: Claude never supplies a number (case 16)", () => {
  for (const key of ["confidence", "score", "band", "probability", "certainty"]) {
    it(`rejects a verdict carrying "${key}"`, () => {
      expect(Verdict.safeParse({ ...CASES[0].verdict, [key]: 0.9 }).success).toBe(false);
    });
  }
  it("accepts the same verdict without it", () => {
    expect(Verdict.safeParse(CASES[0].verdict).success).toBe(true);
  });
});

describe("rubric v1: properties", () => {
  const all = CASES.map((c) => ({ c, r: assess(c.packet, c.verdict, c.pathA) }));

  it("keeps every score between 0 and 100, and traces it to its factors and caps", () => {
    for (const { r } of all) {
      if (r.assessment.score === null) continue;
      expect(r.assessment.score).toBeGreaterThanOrEqual(0);
      expect(r.assessment.score).toBeLessThanOrEqual(100);
      const sum = r.assessment.factors.reduce((t, f) => t + f.points, 0);
      const binding = r.assessment.capsApplied.find((x) => x.binding);
      expect(r.assessment.score).toBe(binding ? binding.limit : sum);
    }
  });

  it("never raises a score when a corroboration signal is removed", () => {
    for (const { c, r } of all) {
      if (r.assessment.score === null) continue;
      for (const key of ["negationAsymmetry", "conflictingValues", "sharedAnchor", "dateConflict"] as const) {
        const without = score({ verdict: c.verdict, ...r.checks, corroboration: { ...r.checks.corroboration, [key]: false } });
        expect(without.score!).toBeLessThanOrEqual(r.assessment.score);
      }
    }
  });

  it("never raises a direct or inferential score when a side's level is lowered", () => {
    const order: Level[] = ["clear", "qualified", "uncertain", "not_adopted"];
    for (const { c, r } of all) {
      if (r.assessment.score === null || c.verdict.classification === "false_positive") continue;
      for (const s of ["a", "b"] as const) {
        let previous = r.assessment.score;
        const from = order.indexOf(r.checks.attribution[s].level);
        if (from < 0) continue; // no_recall is already the lowest level
        for (const level of order.slice(from + 1)) {
          const lowered = score({ verdict: c.verdict, ...r.checks, attribution: { ...r.checks.attribution, [s]: { ...r.checks.attribution[s], level } } });
          const value = lowered.score ?? 0;
          expect(value).toBeLessThanOrEqual(previous);
          previous = value;
        }
      }
    }
  });

  it("gives no step points to an inference step citing an ID outside the packet", () => {
    const c = CASES[2];
    const verdict = { ...c.verdict, inferenceSteps: [{ statement: "x", supportingIds: ["E1", "E2", "E999"] }] };
    const outside = score({ verdict, ...assess(c.packet, c.verdict).checks });
    expect(outside.factors.find((f) => f.label.startsWith("Inference steps"))!.points).toBe(0);
    // A step citing an unknown ID, or steps that never reach one exchange, fail the consistency check
    // first and aren't scored at all.
    const one = assess(c.packet, { ...c.verdict, inferenceSteps: [{ statement: "x", supportingIds: ["E1", "E999"] }] });
    expect(one).toMatchObject({ consistencyIssues: ["inference_step_unverified_evidence", "inference_not_grounded_in_both"], assessment: { unscoredReason: "inconsistent_verdict" } });
    // Steps that each cite one exchange, together covering both, are a grounded chain.
    const chain = assess(c.packet, { ...c.verdict, inferenceSteps: [{ statement: "x", supportingIds: ["E1"] }, { statement: "y", supportingIds: ["E2"] }] });
    expect(chain.consistencyIssues).toEqual([]);
    expect(chain.assessment.score).not.toBeNull();
  });

  it("uses only the frozen rubric", () => {
    expect(Object.isFrozen(RUBRIC_V1)).toBe(true);
    expect(Object.isFrozen(RUBRIC_V1.caps)).toBe(true);
  });
});

describe("review priority: context requests (approved October 29)", () => {
  const run = (c: Case, change: Partial<Verdict>) => assess(c.packet, { ...c.verdict, ...change }, c.pathA);

  it("keeps a valid false positive's score-based priority when Claude asks for context", () => {
    const high = run(CASES[15], { needsMoreContext: true }); // case 12, 95 without the request
    expect(high.assessment.band).toBe("high");
    expect(high.priority).toBe("low");
    // A weakly supported false positive still goes to medium, as DESIGN's table says.
    const weak = { ...high.assessment, score: 40, band: "low" as const };
    expect(prioritize("false_positive", "verified", weak, "unreviewed", true)).toBe("medium");
  });

  it("still sends a direct or inferential verdict that needs context to needs_context", () => {
    expect(run(CASES[0], { needsMoreContext: true }).priority).toBe("needs_context");
    expect(run(CASES[2], { needsMoreContext: true }).priority).toBe("needs_context");
  });

  it("still sends insufficient evidence and unscored findings to needs_context", () => {
    expect(run(CASES[0], { classification: "insufficient_evidence" }).priority).toBe("needs_context");
    expect(assess(CASES[12].packet, CASES[12].verdict).priority).toBe("needs_context"); // case 9b
  });
});
