import { describe, expect, it } from "vitest";
import type { CrossFinding } from "../../server/src/adjudicate/discoverCrossSchema";
import { CROSS_PROMPTS, CROSS_SYSTEM, CROSS_SYSTEM_V2, crossUserPrompt } from "../../server/src/adjudicate/discoverCrossPrompt";
import { promptHash } from "../../server/src/adjudicate/discoverPrompt";

// discover-cross-v1 as Phase A sent it (data/eval/cross-phase-a-manifest.json): it must never change.
const V1_HASH = "00dc01d4ea13d99726ab07aa774c853d7fc40d1d910817de86b618220a692978";
import { CrossOutput, readCrossOutput } from "../../server/src/adjudicate/discoverCrossSchema";
import { fragmentsInOrder, verifyCrossFinding, type CrossStoredSession } from "../../server/src/verify/cross";
import type { StoredLine } from "../../server/src/verify/direct";

const line = (id: number, n: number, text: string, role: string, page = 0): StoredLine => ({ id, page, line: n, pdfPage: 1, text, role, ocrConfidence: null });
const simpson: CrossStoredSession = { label: "A1", witness: "O.J. Simpson", depositionId: 1, lines: [
  line(1, 1653, "Q: Why did you call Faye?", "attorney"),
  line(2, 1654, "A: Because Nicole was saying she was having a nervous breakdown.", "witness"),
  line(3, 1655, "Q: Did you speak to Faye about it?", "attorney"),
  line(4, 1656, "A: I don't recall that.", "witness"),
] };
const resnick: CrossStoredSession = { label: "B1", witness: "Faye Resnick", depositionId: 2, lines: [
  line(11, 297, "Q: Did Nicole have a nervous breakdown?", "attorney"),
  line(12, 298, "A: I have no knowledge of Nicole ever having anywhere close to a nervous breakdown.", "witness"),
  line(13, 299, "Q: Did you speak to Mr. Simpson in June?", "attorney"),
  line(14, 300, "A: Yes, he called me twice.", "witness"),
] };
const finding = (over: Partial<CrossFinding> = {}): CrossFinding => ({
  finding_id: "f1", subject: "nervous breakdown", classification: "direct_conflict",
  session_a: "A1", citation_a: "0:1654", excerpt_a: "Nicole was saying she was having a nervous breakdown", basis_a: "told_by_someone",
  session_b: "B1", citation_b: "0:298", excerpt_b: "I have no knowledge of Nicole ever having anywhere close to a nervous breakdown", basis_b: "personal_observation",
  explanation: "x", missing_context: "", ...over,
});

describe("cross-witness verification", () => {
  it("holds an archive reference at needs context in the product, and accepts it only in the benchmark", () => {
    expect(verifyCrossFinding(finding(), [simpson, resnick])).toMatchObject({ evidenceStatus: "verified", lane: "needs_context", witnessA: "O.J. Simpson", witnessB: "Faye Resnick" });
    expect(verifyCrossFinding(finding(), [simpson, resnick], { acceptUnofficialLines: true }).lane).toBe("contradictions");
  });

  it("never lets a lack of recollection conflict with another witness's memory, whatever the model says", () => {
    const c = verifyCrossFinding(finding({ citation_a: "0:1656", excerpt_a: "I don't recall that." }), [simpson, resnick], { acceptUnofficialLines: true });
    expect(c.lane).toBe("compatible");
    expect(c.reasons.join(" ")).toMatch(/lack of recollection is not a conflict/);
  });

  it("rejects two passages from one witness, an unknown session, an invented quotation and an attorney's words", () => {
    const sameWitness = { ...resnick, label: "B2", depositionId: 3 };
    expect(verifyCrossFinding(finding({ session_a: "B2", citation_a: "0:300", excerpt_a: "he called me twice" }), [simpson, resnick, sameWitness]).lane).toBe("unverified");
    expect(verifyCrossFinding(finding({ session_a: "A9" }), [simpson, resnick]).lane).toBe("unverified");
    expect(verifyCrossFinding(finding({ excerpt_b: "Nicole was perfectly calm" }), [simpson, resnick]).lane).toBe("unverified");
    expect(verifyCrossFinding(finding({ citation_b: "0:299", excerpt_b: "Did you speak to Mr. Simpson in June?" }), [simpson, resnick]).lane).toBe("unverified");
  });

  it("files the model's own non-conflicts as compatible, never as findings to review", () => {
    expect(verifyCrossFinding(finding({ classification: "compatible" }), [simpson, resnick], { acceptUnofficialLines: true }).lane).toBe("compatible");
    expect(verifyCrossFinding(finding({ classification: "recollection_or_knowledge_difference" }), [simpson, resnick], { acceptUnofficialLines: true }).lane).toBe("compatible");
    expect(verifyCrossFinding(finding({ classification: "possible_conflict_needs_context" }), [simpson, resnick], { acceptUnofficialLines: true }).lane).toBe("needs_context");
  });
});

describe("quotations of fragments joined by an ellipsis", () => {
  const cited = "A: I buzzed and Faye came out. Q: She came all the way out to the front gate? A: Yes. A: The dog ran out.";
  it("counts them exact only when every fragment is in the cited lines, in order", () => {
    expect(fragmentsInOrder("I buzzed and Faye came out ... The dog ran out", cited)).toBe(true);
    expect(fragmentsInOrder("I buzzed and Faye came out … the front gate", cited)).toBe(true);
    expect(fragmentsInOrder("The dog ran out ... I buzzed and Faye", cited)).toBe(false); // out of order
    expect(fragmentsInOrder("I buzzed and Faye came out ... the back garage", cited)).toBe(false); // a fragment isn't there
    expect(fragmentsInOrder("I buzzed ... Yes", cited)).toBe(false); // a one-word fragment proves nothing
    expect(fragmentsInOrder("I buzzed and Faye came out", cited)).toBe(false); // a single piece isn't fragments
  });

  it("lets verification accept such a quotation, and records that it did", () => {
    const c = verifyCrossFinding(finding({ excerpt_a: "Because Nicole ... she was having a nervous breakdown" }), [simpson, resnick], { acceptUnofficialLines: true });
    expect([c.a.quote, c.quotes.a.form, c.lane]).toEqual(["fragments", "fragments", "contradictions"]);
    // Rebuilt from the stored text, piece by piece, with the lines they come from.
    expect(c.quotes.a).toEqual({ form: "fragments", stored: ["Because Nicole", "she was having a nervous breakdown"], lineIds: [2] });
    expect(c.quotes.b).toEqual({ form: "continuous", stored: ["I have no knowledge of Nicole ever having anywhere close to a nervous breakdown"], lineIds: [12] });
    // Fragments spanning the attorney's question too are exact, but the speaker is then mixed: held for review.
    const mixed = verifyCrossFinding(finding({ citation_a: "0:1653-0:1654", excerpt_a: "Why did you call Faye? ... Nicole was saying she was having a nervous breakdown" }), [simpson, resnick], { acceptUnofficialLines: true });
    expect([mixed.a.quote, mixed.lane]).toEqual(["fragments", "needs_context"]);
  });
});

describe("cross-witness prompt and output", () => {
  it("sends every line of every session, labelled with its witness and date", () => {
    const user = crossUserPrompt("O.J. Simpson", "Faye Resnick", [
      { label: "A1", witness: "O.J. Simpson", takenOn: "1996-02-27", description: "Feb 27, 1996 (Day 9)", lines: simpson.lines },
      { label: "B1", witness: "Faye Resnick", takenOn: "1996-02-11", description: "Feb 11, 1996, direct", lines: resnick.lines },
    ]);
    expect(user).toContain('<session label="A1" witness="O.J. Simpson" date="1996-02-27"');
    for (const l of [...simpson.lines, ...resnick.lines]) expect(user).toContain(`0:${l.line} ${l.text}`);
    expect(CROSS_SYSTEM).toMatch(/never conflicts with another witness's specific memory/);
  });

  it("keeps v1 frozen, and gives v2 a systematic method, calibrated classifications and the stricter quotation rule", () => {
    expect(Object.keys(CROSS_PROMPTS)).toEqual(["discover-cross-v1", "discover-cross-v2"]);
    expect(promptHash(CROSS_SYSTEM)).toBe(V1_HASH);
    for (const rule of [/Work systematically/, /search all of the other witness's sessions/, /Do not stop after the most prominent conflicts/, /misremember is an explanation of a conflict, not a reason to classify it lower/, /Quote the witness's own words, one continuous span/, /never conflicts with another witness's specific memory/, /Do not give a number, score, percentage or probability/]) expect(CROSS_SYSTEM_V2).toMatch(rule);
  });

  it("rejects a score or confidence in the model's answer, and accepts an empty result", () => {
    expect(readCrossOutput(JSON.stringify({ summary: { completion_status: "complete", limitations: [] }, findings: [] })).output).not.toBeNull();
    expect(CrossOutput.safeParse({ summary: { completion_status: "complete", limitations: [] }, findings: [{ ...finding(), confidence: 0.9 }] }).success).toBe(false);
  });
});
