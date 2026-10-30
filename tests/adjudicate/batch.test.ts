import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BATCH_LIMITS, BATCH_SYSTEM_PROMPT, candidateRef, formatBatch, planBatches, PROMPTS, readBatch, type Packet } from "../../server/src/adjudicate";
import { assess } from "../../server/src/adjudicate";

const side = (id: number, session: "A" | "B", text: string, page: number) => ({
  id: `E${id}`, depositionId: session === "A" ? 1 : 2, groupId: id, session, takenOn: session === "A" ? "2004-01-20" : null, witnessId: 7, partIds: [id], wholeExchange: true,
  lines: [{ id: id * 10, page, line: 1, text: "Q. Were you there?", role: "question" as const }, { id: id * 10 + 1, page, line: 2, text: `A. ${text}`, role: "answer" as const }],
  before: [{ id: id * 10 - 1, page: page - 1, line: 20, text: "Q. Earlier context." }], after: [], gapBefore: false, gapAfter: false,
});
const packet = (n: number): Packet => ({ candidateId: n, witnessId: 7, witnessName: "Lawrence Ellison", a: side(n * 100, "A", `I went to the meeting number ${n}`, n + 10), b: side(n * 100 + 1, "B", `I never attended session ${n}`, n + 50) });
const verdict = (p: Packet, extra: Record<string, unknown> = {}) => ({
  candidateId: candidateRef(p.candidateId), classification: "false_positive", evidenceAId: p.a.id, evidenceBId: p.b.id, keyPhraseA: p.a.lines[1].text.slice(3), keyPhraseB: p.b.lines[1].text.slice(3),
  attributionA: "asserted", attributionB: "asserted", stanceA: "affirms", stanceB: "affirms", sameEvent: "no", scopeAligned: "no", conflictBasis: "none", aboutTimingOfSameEvent: false,
  inferenceSteps: [], unestablishedAssumptions: [], falsePositiveReason: "different_event", explanation: "These two statements concern different meetings and can both be true.", alternativeExplanation: null, needsMoreContext: false, alternativeSupport: null, conflictSource: "none", contextUsed: [], ...extra,
});
const three = [packet(1), packet(2), packet(3)];
const reply = (items: unknown[]) => JSON.stringify({ verdicts: items });

describe("the batch prompt", () => {
  it("keeps every adjudicate-v3 rule, adds independence rules, and leaves v3 unchanged", () => {
    const v3 = PROMPTS["adjudicate-v3"].system;
    expect(createHash("sha256").update(v3).digest("hex")).toBe("c082071a5efd9814da145ec15f209e0ffee0fb41f69cab9653642c362f697563");
    const body = v3.slice(v3.indexOf("Read carefully:"));
    for (const line of body.split("\n").filter(Boolean)) expect(BATCH_SYSTEM_PROMPT).toContain(line);
    expect(BATCH_SYSTEM_PROMPT).toContain("Never compare evidence across candidates");
    expect(BATCH_SYSTEM_PROMPT).toContain("never omit it");
    expect(BATCH_SYSTEM_PROMPT).toMatch(/never give a confidence, score/);
  });
});

describe("formatBatch", () => {
  it("states witnesses and sessions once and keeps each candidate whole and separate", () => {
    const text = formatBatch(three);
    expect(text.match(/Lawrence Ellison/g)).toHaveLength(1);
    expect(text.match(/deposition 1: taken_on 2004-01-20/g)).toHaveLength(1);
    expect(text).toContain("deposition 2: taken_on not stated");
    expect(text.match(/<candidate id=/g)).toHaveLength(3);
    for (const p of three) {
      const body = text.slice(text.indexOf(`<candidate id="${candidateRef(p.candidateId)}"`));
      expect(body.slice(0, body.indexOf("</candidate>"))).toContain(p.a.lines[1].text);
      expect(body.slice(0, body.indexOf("</candidate>"))).toContain(`[${p.b.id}]`);
      expect(body.slice(0, body.indexOf("</candidate>"))).toContain("Earlier context.");
    }
  });
});

describe("planBatches", () => {
  const many = Array.from({ length: 25 }, (_, i) => packet(i + 1));
  it("keeps every candidate, in order", () => {
    const plan = planBatches(many, 10);
    expect(plan.batches.map((b) => b.packets.length)).toEqual([10, 10, 5]);
    expect(plan.batches.flatMap((b) => b.packets.map((p) => p.candidateId))).toEqual(many.map((p) => p.candidateId));
    expect(plan.batches.every((b) => b.splitReason === null)).toBe(true);
  });
  it("splits early and says why when the output limit is reached", () => {
    const plan = planBatches(many, 20, { ...BATCH_LIMITS, maxOutputTokens: 6_000 });
    expect(plan.batches[0].packets).toHaveLength(5);
    expect(plan.batches[0].splitReason).toContain("closed at 5 of 20");
    expect(plan.batches.flatMap((b) => b.packets)).toHaveLength(25);
  });
  it("fails a candidate too large for any request instead of cutting its evidence", () => {
    const big = packet(1);
    big.a = { ...big.a, before: Array.from({ length: 4000 }, (_, i) => ({ id: i + 9000, page: 1, line: 1, text: "word ".repeat(40) })) };
    const plan = planBatches([big, packet(2)], 10, { ...BATCH_LIMITS, contextWindow: 30_000 });
    expect(plan.oversize.map((o) => o.packet.candidateId)).toEqual([1]);
    expect(plan.oversize[0].reason).toContain("exceeds");
    expect(plan.batches[0].packets.map((p) => p.candidateId)).toEqual([2]);
  });
});

describe("readBatch", () => {
  it("accepts a complete response", () => {
    const r = readBatch(three, "end_turn", reply(three.map((p) => verdict(p))));
    expect(r.accepted.map((a) => a.packet.candidateId)).toEqual([1, 2, 3]);
    expect([r.rejected, r.missing, r.duplicates, r.unknown, r.unusable]).toEqual([[], [], [], [], null]);
  });
  it("keeps the good verdicts when one is missing, and invents nothing", () => {
    const r = readBatch(three, "end_turn", reply([verdict(three[0]), verdict(three[2])]));
    expect(r.accepted).toHaveLength(2);
    expect(r.missing).toEqual([2]);
  });
  it("keeps no answer of a candidate answered twice", () => {
    const r = readBatch(three, "end_turn", reply([verdict(three[0]), verdict(three[0], { classification: "direct" }), verdict(three[1]), verdict(three[2])]));
    expect(r.duplicates).toEqual([1]);
    expect(r.accepted.map((a) => a.packet.candidateId)).toEqual([2, 3]);
  });
  it("records unknown candidate IDs", () => {
    const r = readBatch(three, "end_turn", reply([...three.map((p) => verdict(p)), verdict(packet(9))]));
    expect(r.unknown).toEqual(["C9"]);
    expect(r.accepted).toHaveLength(3);
  });
  it("rejects a verdict that fails the schema, or adds a score, keeping its raw text", () => {
    const r = readBatch(three, "end_turn", reply([verdict(three[0], { classification: "maybe" }), verdict(three[1], { confidence: 0.9 }), verdict(three[2])]));
    expect(r.rejected.map((x) => x.kind)).toEqual(["invalid", "invalid"]);
    expect(r.rejected[1].raw).toContain("confidence");
    expect(r.accepted).toHaveLength(1);
  });
  it("rejects citing another candidate's exchange as contamination", () => {
    const r = readBatch(three, "end_turn", reply([verdict(three[0], { evidenceBId: three[1].b.id }), verdict(three[1]), verdict(three[2])]));
    expect(r.rejected[0].kind).toBe("contaminated");
  });
  it("rejects another candidate's ID in an inference step or the explanation", () => {
    const step = verdict(three[0], { inferenceSteps: [{ statement: "x", supportingIds: [three[2].a.id] }] });
    const text = verdict(three[1], { explanation: "As in C3, these statements are compatible with each other." });
    const r = readBatch(three, "end_turn", reply([step, text, verdict(three[2])]));
    expect(r.rejected.map((x) => x.kind)).toEqual(["contaminated", "contaminated"]);
  });
  it("rejects a key phrase taken from another candidate", () => {
    const other = packet(2);
    other.b.lines[1].text = "A. The pricing committee rejected that proposal outright";
    const r = readBatch([three[0], other], "end_turn", reply([verdict(three[0], { keyPhraseB: "The pricing committee rejected that proposal outright" }), verdict(other)]));
    expect(r.rejected[0].kind).toBe("contaminated");
    expect(r.rejected[0].reason).toContain("C2");
  });
  it.each(["placeholder", "Placeholder explanation for this candidate, to be filled in later.", "TBD", "Compatible."])("rejects the unreasoned explanation %j, however valid the JSON", (explanation) => {
    const r = readBatch(three, "end_turn", reply([verdict(three[0], { classification: "direct", conflictBasis: "explicit_negation", falsePositiveReason: null, conflictSource: "cited_exchanges", explanation }), verdict(three[1]), verdict(three[2])]));
    expect(r.rejected[0].kind).toBe("invalid");
    expect(r.rejected[0].reason).toContain("not a real one");
    expect(r.accepted).toHaveLength(2);
  });
  it("rejects an exchange ID that is simply wrong", () => {
    const r = readBatch(three, "end_turn", reply([verdict(three[0], { evidenceAId: "E999999" }), verdict(three[1]), verdict(three[2])]));
    expect(r.rejected[0].kind).toBe("wrong_exchange");
  });
  it("only flags a page:line from another candidate, since it may be a time of day", () => {
    const shown = `${three[1].a.lines[0].page}:01`;
    const r = readBatch(three, "end_turn", reply([verdict(three[0], { explanation: `See ${shown} for the statement these two lines concern.` }), verdict(three[1]), verdict(three[2])]));
    expect(r.accepted[0].suspected).toEqual([shown]);
  });
  it.each([
    ["max_tokens", '{"verdicts":[{"candi', "cut off"],
    ["refusal", null, "refused"],
    ["end_turn", "not json", "not JSON"],
    ["end_turn", '{"nothing":[]}', "no verdicts array"],
    ["end_turn", null, "no structured output"],
  ])("treats %s with %s as unusable: every candidate is left without a verdict", (stop, text, reason) => {
    const r = readBatch(three, stop, text);
    expect(r.unusable).toContain(reason);
    expect(r.missing).toEqual([1, 2, 3]);
    expect(r.accepted).toEqual([]);
  });
  it("a batch verdict passes the same pure assessment as a single one", () => {
    const [a] = readBatch(three, "end_turn", reply(three.map((p) => verdict(p)))).accepted;
    const assessed = assess(a.packet, a.verdict);
    expect(assessed.checks.source.status).toBe("verified");
    expect(assessed.consistencyIssues).toEqual([]);
  });
});
