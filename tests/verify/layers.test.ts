// Layer 1 (source) and Layer 2 (attribution) checks on hand-built exchanges. Pure: no database.

import { describe, expect, it } from "vitest";
import { assess, readVerdict, untilGap } from "../../server/src/adjudicate";
import { attributeSide, checkSide, isBareAnswer, matchScore, type EvidenceExchange, type EvidenceLine } from "../../server/src/verify";

let n = 1;
const ex = (id: string, rows: [EvidenceLine["role"], string][], { witnessId = 7, context = ["Q. Moving on."] } = {}): EvidenceExchange => ({
  id,
  witnessId,
  lines: rows.map(([role, text]) => ({ id: n++, role, text })),
  context: context.map((text) => ({ id: n++, text })),
});

const A = ex("E1", [["question", "Q. Did you sign the Hartley contract?"], ["answer", "A. I signed it in March, I believe."]]);
const B = ex("E2", [["question", "Q. Who signed the Hartley contract?"], ["answer", "A. I never signed the Hartley contract."]], { context: ["MR. HALE: Objection. The witness said he was in Paris."] });

describe("Layer 1: source verification", () => {
  it("verifies an exact phrase in the cited exchange, and finds the lines it sits on", () => {
    const s = checkSide("I never signed the Hartley contract", "E2", B, A, 7);
    expect(s).toMatchObject({ status: "verified", location: "answer", matchScore: 1 });
    expect(s.evidenceLineIds).toEqual([B.lines[1].id]);
  });

  it("accepts a close paraphrase as approximate", () => {
    expect(checkSide("never signed Hartley contract myself", "E2", B, A, 7).status).toBe("approximate");
  });

  it("never accepts an approximate match that drops a negation", () => {
    // v1's word-share score alone would pass both at 0.675 and 0.9.
    expect(matchScore("I was not at the Hartley office in March", "I was at the Hartley office in March.")).toBe(0);
    expect(matchScore("I was at the Hartley office in March", "I wasn't at the Hartley office in March.")).toBe(0);
    expect(matchScore("I wasn't at Hartley's office in March", "Q. Well. A. I wasn't at the Hartley office in March.")).toBeGreaterThanOrEqual(0.6);
    const office = ex("E1", [["answer", "A. I was at the Hartley office in March."]]);
    expect(checkSide("I was not at the Hartley office in March", "E1", office, B, 7).status).toBe("unsupported");
  });

  it("calls a phrase found in the other session's exchange a wrong reference", () => {
    expect(checkSide("I never signed the Hartley contract", "E1", A, B, 7)).toMatchObject({ status: "wrong_reference", location: null });
  });

  it("calls citing the other session's exchange ID a wrong reference", () => {
    expect(checkSide("I never signed the Hartley contract", "E1", B, A, 7)).toMatchObject({ status: "wrong_reference", reason: "cites the other session's exchange" });
  });

  it("calls a phrase found only in the context lines a wrong reference", () => {
    expect(checkSide("the witness said he was in Paris", "E2", B, A, 7).status).toBe("wrong_reference");
  });

  it("calls a phrase found nowhere unsupported", () => {
    expect(checkSide("I approved the Redwood merger", "E2", B, A, 7)).toMatchObject({ status: "unsupported", reason: "the phrase is found nowhere in the packet" });
  });

  it("calls an ID outside the packet unsupported, even when the phrase is real", () => {
    expect(checkSide("I never signed the Hartley contract", "E99", B, A, 7)).toMatchObject({ status: "unsupported", reason: "exchange ID E99 is not in the packet" });
  });

  it("calls another witness's exchange unsupported", () => {
    const other = ex("E2", [["answer", "A. I never signed the Hartley contract."]], { witnessId: 8 });
    expect(checkSide("I never signed the Hartley contract", "E2", other, A, 7).status).toBe("unsupported");
  });
});

const sideOf = (rows: [EvidenceLine["role"], string][], phrase: string) => checkSide(phrase, "E1", ex("E1", rows), B, 7);

describe("Layer 2: attribution", () => {
  it("reads a plain Yes as adopting the question, and a plain No as denying it", () => {
    const yes = sideOf([["question", "Q. Did you sign the contract?"], ["answer", "A. Yes, sir."]], "Did you sign the contract");
    const no = sideOf([["question", "Q. Did you sign the contract?"], ["answer", "A. No."]], "Did you sign the contract");
    expect(attributeSide(yes, "Did you sign the contract", "asserted", "affirms")).toMatchObject({ location: "question_affirmed", codeStance: "affirms", level: "clear" });
    expect(attributeSide(no, "Did you sign the contract", "asserted", "denies")).toMatchObject({ location: "question_denied", codeStance: "denies", level: "clear" });
  });

  it("makes a side not_adopted when Claude reads a plain No as affirming", () => {
    const no = sideOf([["question", "Q. Did you sign the contract?"], ["answer", "A. No."]], "Did you sign the contract");
    expect(attributeSide(no, "Did you sign the contract", "asserted", "affirms")).toMatchObject({ stanceMismatch: true, level: "not_adopted" });
  });

  it("never reads a bare answer to a tag question as adoption", () => {
    const s = sideOf([["question", "Q. You didn't sign it, did you?"], ["answer", "A. No."]], "You didn't sign it");
    expect(attributeSide(s, "You didn't sign it", "asserted", "denies")).toMatchObject({ location: "question_other", level: "uncertain" });
  });

  it("makes a no-recall answer no_recall, whatever Claude said", () => {
    const s = sideOf([["question", "Q. Did you sign the contract?"], ["answer", "A. I don't recall."]], "Did you sign the contract");
    expect(attributeSide(s, "Did you sign the contract", "asserted", "affirms")).toMatchObject({ noRecall: true, codeLevel: "no_recall", level: "no_recall" });
  });

  it("makes a hedged answer qualified, and keeps Claude's lower reading", () => {
    const s = sideOf([["answer", "A. I think I signed it in March."]], "I signed it in March");
    expect(attributeSide(s, "I signed it in March", "asserted", "affirms")).toMatchObject({ qualifier: "i think", level: "qualified" });
    expect(attributeSide(s, "I signed it in March", "hypothetical", "affirms").level).toBe("not_adopted");
  });

  it("makes conditional wording uncertain, and finds approximation words", () => {
    const s = sideOf([["answer", "A. If I had signed it, it would have been around 2001."]], "it would have been around 2001");
    expect(attributeSide(s, "it would have been around 2001", "asserted", "affirms")).toMatchObject({ conditional: true, approximation: true, level: "uncertain" });
  });

  it("makes an attorney's words with no answer not_adopted", () => {
    const s = sideOf([["question", "Q. So you signed it in March."], ["context", "MR. HALE: Objection."]], "So you signed it in March");
    expect(attributeSide(s, "So you signed it in March", "asserted", "affirms")).toMatchObject({ location: "attorney_or_colloquy", level: "not_adopted", claudeContradicted: true });
  });

  it("doesn't count finding nothing in a witness's own answer as contradicting Claude's lower label", () => {
    const s = sideOf([["answer", "A. I signed it in March, I believe."]], "I signed it in March");
    expect(attributeSide(s, "I signed it in March", "qualified", "affirms")).toMatchObject({ codeLevel: "clear", level: "qualified", claudeContradicted: false });
  });
});

describe("readVerdict", () => {
  it("classifies each kind of response", () => {
    expect(readVerdict("refusal", null).status).toBe("refused");
    expect(readVerdict("max_tokens", "{").status).toBe("cut_off");
    expect(readVerdict("end_turn", null).status).toBe("schema_invalid");
    expect(readVerdict("end_turn", "{oops").error).toBe("the output is not JSON");
    expect(readVerdict("end_turn", JSON.stringify({ classification: "direct" })).status).toBe("schema_invalid");
  });
});

describe("packet context", () => {
  it("stops context lines at a page skip, nearest first", () => {
    const before = [{ page: 137 }, { page: 136 }, { page: 118 }];
    expect(untilGap({ page: 137 }, before)).toEqual({ lines: [{ page: 137 }, { page: 136 }], gap: true });
    expect(untilGap({ page: 250 }, [{ page: 252 }])).toEqual({ lines: [], gap: true });
    expect(untilGap({ page: 10 }, [{ page: 10 }, { page: 11 }])).toEqual({ lines: [{ page: 10 }, { page: 11 }], gap: false });
  });
});

describe("Layer 1 and 2: short answers stand for their question", () => {
  const Q = "Q. In your outsourcing service does the customer buy the software?";
  const side = (answer: string, phrase: string, question = Q) => {
    const x = ex("E1", [["question", question], ["answer", `A. ${answer}`]]);
    return { x, s: checkSide(phrase, "E1", x, B, 7) };
  };

  it("recognizes answers that state nothing of their own", () => {
    for (const p of ["Yes.", "Yes, they do.", "No, sir.", "Correct.", "I don't recall.", "Not exactly.", "That's right."]) expect(isBareAnswer(p)).toBe(true);
    for (const p of ["No, I was alone.", "Yes, in March.", "I never signed it."]) expect(isBareAnswer(p)).toBe(false);
  });

  it("reads a bare Yes as adopting the question, and shows the question with it", () => {
    const { x, s } = side("Yes, they do.", "Yes, they do.");
    expect(s).toMatchObject({ status: "verified", bareAnswer: true, location: "question_affirmed", proposition: "In your outsourcing service does the customer buy the software?" });
    expect(s.evidenceLineIds).toEqual(x.lines.map((l) => l.id)); // the question and the answer, never "Yes" alone
    expect(attributeSide(s, "Yes, they do.", "asserted", "affirms").level).toBe("clear");
  });

  it("reads a bare No as denying the question, and a misread No as not adopted", () => {
    const { s } = side("No.", "No.");
    expect(s).toMatchObject({ bareAnswer: true, location: "question_denied" });
    expect(attributeSide(s, "No.", "asserted", "denies").level).toBe("clear");
    expect(attributeSide(s, "No.", "asserted", "affirms")).toMatchObject({ stanceMismatch: true, level: "not_adopted" });
  });

  it("never reads an ambiguous short answer as adoption", () => {
    for (const answer of ["I believe so.", "Not exactly.", "Uh-huh.", "Yes, but only in Europe."]) {
      const { s } = side(answer, answer.split(",")[0]);
      expect(s.location).toBe("question_other");
      expect(attributeSide(s, answer, "asserted", "affirms").level).toBe("uncertain");
    }
  });

  it("reads a bare I don't recall as no recollection of the question", () => {
    const { s } = side("I don't recall.", "I don't recall.");
    expect(s).toMatchObject({ bareAnswer: true, location: "question_other" });
    expect(attributeSide(s, "I don't recall.", "asserted", "affirms").level).toBe("no_recall");
  });

  it("supports no proposition with a bare answer that has no question", () => {
    const x = ex("E1", [["answer", "A. Yes."]]);
    expect(checkSide("Yes.", "E1", x, B, 7)).toMatchObject({ status: "unsupported", reason: "a bare answer, with no question in the exchange to give it meaning" });
  });

  it("doesn't read a No to a compound question as denying each part", () => {
    const question = "Q. Did you approve the contract and sign the term sheet?";
    const part = side("No.", "sign the term sheet", question).s;
    expect(part).toMatchObject({ location: "question_other", compound: "and" });
    expect(attributeSide(part, "sign the term sheet", "asserted", "denies").level).toBe("uncertain");
    // The whole conjunction is denied; a Yes adopts each part.
    expect(side("No.", "Did you approve the contract and sign the term sheet", question).s.location).toBe("question_denied");
    expect(side("Yes.", "sign the term sheet", question).s).toMatchObject({ location: "question_affirmed", compound: null });
  });

  it("doesn't read a Yes to an either-or question as adopting one alternative", () => {
    const question = "Q. Did you meet him in Paris or in London?";
    expect(side("Yes.", "meet him in Paris", question).s).toMatchObject({ location: "question_other", compound: "or" });
    expect(side("No.", "meet him in Paris", question).s.location).toBe("question_denied");
  });

  it("rejects a proposition the question doesn't contain, even with a plain Yes", () => {
    const { s } = side("Yes.", "the customer owns the servers");
    expect(s.status).toBe("unsupported");
  });

  it("checks a bare answer's question, not the word Yes, for corroboration", () => {
    const packet = {
      candidateId: 1,
      witnessId: 7,
      witnessName: "W",
      a: { ...ex("E1", [["answer", "A. Customers don't buy the software, they buy the service."]]), depositionId: 1, groupId: 1, session: "A" as const, takenOn: null, partIds: [1], wholeExchange: true, before: [], after: [], gapBefore: false, gapAfter: false },
      b: { ...ex("E2", [["question", Q], ["answer", "A. Yes, they do."]]), depositionId: 2, groupId: 1, session: "B" as const, takenOn: null, partIds: [2], wholeExchange: true, before: [], after: [], gapBefore: false, gapAfter: false },
    };
    const { checks } = assess(packet as never, {
      classification: "direct", evidenceAId: "E1", evidenceBId: "E2", keyPhraseA: "Customers don't buy the software", keyPhraseB: "Yes, they do.",
      attributionA: "asserted", attributionB: "asserted", stanceA: "affirms", stanceB: "affirms", sameEvent: "yes", scopeAligned: "yes",
      conflictBasis: "explicit_negation", aboutTimingOfSameEvent: false, inferenceSteps: [], unestablishedAssumptions: [], falsePositiveReason: null,
      explanation: "", alternativeExplanation: null, needsMoreContext: false,
    });
    expect(checks.source.b.proposition).toContain("does the customer buy the software");
    expect(checks.corroboration.negationAsymmetry).toBe(true); // "don't buy" against an adopted "does … buy"
  });
});

describe("Layer 2: code overrides Claude only where a rule establishes the attribution", () => {
  const Q = "Q. Did you sign the contract?";
  const at = (rows: [EvidenceLine["role"], string][], phrase: string, attribution: Parameters<typeof attributeSide>[2], stance: Parameters<typeof attributeSide>[3] = "affirms") =>
    attributeSide(checkSide(phrase, "E1", ex("E1", rows), B, 7), phrase, attribution, stance);

  it("corrects Claude overstating: asserted where the witness doesn't recall", () => {
    expect(at([["question", Q], ["answer", "A. I don't recall."]], "Did you sign the contract", "asserted")).toMatchObject({ codeBound: "exact", level: "no_recall", disagreement: "claude_overstates" });
  });

  it("corrects Claude understating: unclear where the witness plainly said yes", () => {
    expect(at([["question", Q], ["answer", "A. Yes, sir."]], "Did you sign the contract", "unclear")).toMatchObject({ codeBound: "exact", level: "clear", disagreement: "claude_understates" });
    expect(at([["question", Q], ["answer", "A. No, never."]], "Did you sign the contract", "attorney_statement", "denies")).toMatchObject({ level: "clear", disagreement: "claude_understates" });
  });

  it("caps Claude at a hedge, but accepts a more cautious reading without calling it a disagreement", () => {
    const rows: [EvidenceLine["role"], string][] = [["answer", "A. I think I signed it in March."]];
    expect(at(rows, "I signed it in March", "asserted")).toMatchObject({ codeBound: "upper", level: "qualified", disagreement: "claude_overstates" });
    expect(at(rows, "I signed it in March", "hypothetical")).toMatchObject({ level: "not_adopted", disagreement: null });
  });

  it("keeps uncertainty where the answer isn't plain, without overriding a no-recall reading", () => {
    const rows: [EvidenceLine["role"], string][] = [["question", "Q. You ordered pizza. Now you're saying groceries?"], ["answer", "A. I might have done both. I don't remember exactly."]];
    expect(at(rows, "I don't remember exactly", "does_not_recall", "unclear")).toMatchObject({ codeBound: "upper", level: "no_recall", disagreement: null });
    expect(at(rows, "I don't remember exactly", "asserted", "unclear")).toMatchObject({ level: "uncertain", disagreement: "claude_overstates" });
  });

  it("lets Claude's reading stand where code found nothing in the witness's own words", () => {
    const rows: [EvidenceLine["role"], string][] = [["answer", "A. Safra signed it, she told me."]];
    expect(at(rows, "Safra signed it", "reported_by_other")).toMatchObject({ codeBound: "none", level: "not_adopted", disagreement: null });
    expect(at(rows, "Safra signed it", "asserted")).toMatchObject({ codeBound: "none", level: "clear", disagreement: null });
  });

  it("records a stance conflict on a plain answer", () => {
    expect(at([["question", Q], ["answer", "A. No."]], "Did you sign the contract", "asserted", "affirms")).toMatchObject({ level: "not_adopted", disagreement: "stance_conflict" });
  });
});
