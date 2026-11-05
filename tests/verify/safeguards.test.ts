import { describe, expect, it } from "vitest";
import type { SideAttribution } from "../../server/src/verify/attribution";
import { safeguardsFor } from "../../server/src/verify/safeguards";

const side = (over: Partial<SideAttribution> = {}): SideAttribution => ({
  location: "answer", codeStance: "affirms", noRecall: false, qualifier: null, conditional: false, approximation: false,
  codeLevel: "clear", claudeLevel: "clear", codeBound: "none", codeRule: "", stanceMismatch: false, level: "clear", disagreement: null, claudeContradicted: false, ...over,
});
const verdict = (over: Partial<Parameters<typeof safeguardsFor>[0]> = {}) => ({ outcome: "direct", attributionA: "asserted", attributionB: "asserted", explanation: "He says the front gate; she says the back alley. These cannot both be true.", alternativeSupport: "speculative", ...over });
const rules = (v: Parameters<typeof safeguardsFor>[0], a = side(), b = side()) => safeguardsFor(v, { a, b }).map((s) => `${s.rule}${s.side ? `:${s.side}` : ""}`);

describe("safeguards", () => {
  it("leave a plain, own-knowledge contradiction alone (the negative control for every rule)", () => {
    expect(rules(verdict())).toEqual([]);
  });
  it("never touch a non-conflict verdict", () => {
    for (const outcome of ["false_positive", "needs_more_context", "insufficient_evidence"]) expect(rules(verdict({ outcome, attributionB: "reported_by_other", explanation: "Both can be true." }), side({ location: "attorney_or_colloquy" }))).toEqual([]);
  });

  describe("examiner_words", () => {
    it("fires when the quoted words are only the examiner's", () => {
      expect(rules(verdict(), side({ location: "attorney_or_colloquy" }))).toEqual(["examiner_words:a"]);
      expect(rules(verdict(), side(), side({ location: "question_other" }))).toEqual(["examiner_words:b"]);
    });
    it("does not fire on a plain yes to the question (the witness adopts it: 'Out of the gate?' 'Yes.')", () => {
      expect(rules(verdict(), side({ location: "question_affirmed" }), side({ location: "question_denied" }))).toEqual([]);
    });
  });

  describe("not_own_knowledge", () => {
    it("fires on reported speech, hypotheticals and attorney statements", () => {
      expect(rules(verdict({ attributionB: "reported_by_other" }))).toEqual(["not_own_knowledge:b"]);
      expect(rules(verdict({ attributionA: "hypothetical" }))).toEqual(["not_own_knowledge:a"]);
      expect(rules(verdict({ attributionA: "attorney_statement" }))).toEqual(["not_own_knowledge:a"]);
    });
    it("does not fire on the witness's own assertion, even a qualified or unclear one", () => {
      expect(rules(verdict({ attributionA: "qualified", attributionB: "unclear" }))).toEqual([]);
    });
  });

  describe("no_recall", () => {
    it("fires when code reads a no-recall answer, or the model says the witness does not recall", () => {
      expect(rules(verdict(), side(), side({ noRecall: true }))).toEqual(["no_recall:b"]);
      expect(rules(verdict({ attributionA: "does_not_recall" }))).toEqual(["no_recall:a"]);
    });
    it("fires on a cited answer with a no-recall clause, even with a trailing denial (C03: 'I don't recall seeing Faye, but no.')", () => {
      expect(safeguardsFor(verdict(), { a: side(), b: side() }, { a: "I don't recall seeing Faye, but no.", b: "He said he loved her too much." }).map((x) => x.rule)).toEqual(["no_recall"]);
      expect(safeguardsFor(verdict(), { a: side(), b: side() }, { a: "I have no recollection of that.", b: "Yes." }).map((x) => x.rule)).toEqual(["no_recall"]);
    });
    it("does not fire on answers that recall, or deny, without a no-recall clause", () => {
      for (const a of ["No.", "I recall it clearly: I was at home.", "I remember the gate was open.", "I never said that."]) expect(safeguardsFor(verdict(), { a: side(), b: side() }, { a, b: "Yes, he did." })).toEqual([]);
    });
    it("does not fire on a plain denial", () => {
      expect(rules(verdict(), side({ location: "question_denied", codeStance: "denies" }))).toEqual([]);
    });
  });

  describe("says_compatible", () => {
    it.each([
      "Both can be true, since he was in Puerto Rico and she was in Los Angeles. The pair is not clearly inconsistent.", // NC-001, stretch-v2 r1
      "The two accounts could both be true if they describe different visits.",
      "These statements are not necessarily inconsistent.",
      "Both statements may be accurate.",
    ])("fires on a concession: %s", (explanation) => {
      expect(rules(verdict({ explanation }))).toEqual(["says_compatible"]);
    });
    it.each([
      "These cannot both be true.",
      "They can't both be true: one says front gate, the other back alley.",
      "The accounts are not compatible.",
      "Her account is not consistent with his; they are inconsistent on whether he entered.",
      "He says he could not have been there; she says he was. They are directly contradictory.",
      "His testimony is consistent with his earlier answer but contradicts hers.",
    ])("does not fire on wording that asserts a conflict: %s", (explanation) => {
      expect(rules(verdict({ explanation }))).toEqual([]);
    });
  });

  describe("established_alternative", () => {
    it("fires only when the verdict rates its own alternative as established", () => {
      expect(rules(verdict({ alternativeSupport: "established" }))).toEqual(["established_alternative"]);
      expect(rules(verdict({ alternativeSupport: "plausible" }))).toEqual([]);
      expect(rules(verdict({ alternativeSupport: null }))).toEqual([]);
    });
  });
});
