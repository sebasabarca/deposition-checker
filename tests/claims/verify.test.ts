import { describe, expect, it } from "vitest";
import {
  checkClaim,
  contextReason,
  findHedge,
  groundEntities,
  locate,
  normalizeEntities,
  type ExtractedClaim,
  type PartLine,
} from "../../server/src/claims";

// P3173 51:13-51:15, as stored.
const lines: PartLine[] = [
  { id: 1, role: "question", text: "Q. In your outsourcing service does the" },
  { id: 2, role: "question", text: "customer buy the software?" },
  { id: 3, role: "answer", text: "A. Yes, they do." },
];
const longAnswer: PartLine[] = [
  { id: 10, role: "question", text: "Q. To what degree?" },
  { id: 11, role: "answer", text: "A. I think business process outsourcing had become" },
  { id: 12, role: "answer", text: "a very hot topic, they're not buying any software," },
  { id: 13, role: "answer", text: "they're buying the online service." },
];

const claim = (fields: Partial<ExtractedClaim>): ExtractedClaim => ({
  exchangeId: "E1",
  source: "answer",
  keyPhrase: "",
  answerPhrase: null,
  subject: "customers",
  predicate: "buy",
  object: "software",
  polarity: "affirms",
  epistemic: "asserted",
  time: null,
  place: null,
  quantity: null,
  entities: [],
  dependsOnEarlierExchange: false,
  ...fields,
});
const part = (ls: PartLine[], flags: string[] = []) => ({ lines: ls, flags });

describe("checkClaim: answer claims", () => {
  it("verifies a phrase in the witness's testimony, across lines, and records the lines it sits on", () => {
    const check = checkClaim(claim({ keyPhrase: "they're not buying any software, they're buying the online service", polarity: "denies" }), part(longAnswer));
    expect(check).toMatchObject({ status: "verified", rejectionReason: null, matchScore: 1, answerMatchScore: null, evidenceLineIds: [12, 13] });
  });

  it("accepts a near match as approximate, citing the whole answer", () => {
    const check = checkClaim(claim({ keyPhrase: "business process outsourcing became a hot topic" }), part(longAnswer));
    expect(check.status).toBe("approximate");
    expect(check.evidenceLineIds).toEqual([11, 12, 13]);
  });

  it("rejects a phrase that is only in the attorney's question, or nowhere", () => {
    expect(checkClaim(claim({ keyPhrase: "customer buy the software" }), part(lines)).rejectionReason).toBe("phrase_in_question_not_answer");
    expect(checkClaim(claim({ keyPhrase: "we licensed it to IBM" }), part(lines)).rejectionReason).toBe("phrase_not_in_testimony");
  });
});

describe("checkClaim: adopted_question claims", () => {
  const adopted = (fields: Partial<ExtractedClaim>) =>
    claim({ source: "adopted_question", keyPhrase: "In your outsourcing service does the customer buy the software", answerPhrase: "Yes, they do", ...fields });

  it("verifies the question, the explicit answer, and that the answer's direction is the claim's polarity", () => {
    expect(checkClaim(adopted({}), part(lines))).toMatchObject({
      status: "verified",
      rejectionReason: null,
      matchScore: 1,
      answerMatchScore: 1,
      evidenceLineIds: [1, 2, 3],
    });
  });

  it("rejects a polarity that contradicts the plain answer", () => {
    expect(checkClaim(adopted({ polarity: "denies" }), part(lines)).rejectionReason).toBe("polarity_contradicts_answer");
  });

  it("rejects an answer that isn't a plain yes or no", () => {
    const hedged: PartLine[] = [...lines.slice(0, 2), { id: 3, role: "answer", text: "A. Yes, in a narrow sense." }];
    expect(checkClaim(adopted({ answerPhrase: "Yes, in a narrow sense" }), part(hedged)).rejectionReason).toBe("answer_not_plain_yes_or_no");
  });

  it("rejects a missing or invented adopting answer, a question phrase that isn't there, and a hedged label on a plain answer", () => {
    expect(checkClaim(adopted({ answerPhrase: null }), part(lines)).rejectionReason).toBe("adopting_answer_missing");
    expect(checkClaim(adopted({ answerPhrase: "Absolutely not" }), part(lines)).rejectionReason).toBe("adopting_answer_not_in_testimony");
    expect(checkClaim(adopted({ keyPhrase: "did you approve the merger" }), part(lines)).rejectionReason).toBe("phrase_not_in_question");
    expect(checkClaim(adopted({ epistemic: "qualified" }), part(lines)).rejectionReason).toBe("plain_answer_not_asserted");
  });

  it("rejects any claim from an exchange with no witness answer", () => {
    expect(checkClaim(claim({ keyPhrase: "customer buy" }), part(lines.slice(0, 2))).rejectionReason).toBe("no_witness_answer");
  });
});

describe("locate", () => {
  it("returns every given line when the phrase isn't found exactly", () => {
    expect(locate("nothing like this", longAnswer)).toEqual([10, 11, 12, 13]);
  });
});

describe("normalizeEntities", () => {
  it("writes the same name one way, dropping honorifics, possessives, a leading 'the' and duplicates", () => {
    expect(normalizeEntities(["Ms. Safra Catz", "safra catz", "Oracle's", "The PeopleSoft Board", "R&D", ""])).toEqual([
      "oracle",
      "peoplesoft board",
      "r&d",
      "safra catz",
    ]);
  });
});

describe("checkClaim: plain \"I don't know\" and \"I don't recall\" answers", () => {
  const q: PartLine[] = [
    { id: 1, role: "question", text: "Q. Will the enhanced Oracle product operate on anything other than Oracle's database?" },
    { id: 2, role: "answer", text: "A. I don't know." },
  ];
  const noRecall = (fields: Partial<ExtractedClaim>) =>
    claim({
      source: "adopted_question",
      keyPhrase: "Will the enhanced Oracle product operate on anything other than Oracle's database",
      answerPhrase: "I don't know",
      predicate: "support",
      epistemic: "does_not_know",
      ...fields,
    });

  it("accepts the question's proposition, as asked, held without knowledge: never a denial", () => {
    expect(checkClaim(noRecall({}), part(q))).toMatchObject({ status: "verified", rejectionReason: null, evidenceLineIds: [1, 2] });
    expect(checkClaim(noRecall({ polarity: "denies" }), part(q)).rejectionReason).toBe("no_recall_claim_not_stated_as_asked");
  });

  it("keeps not knowing and not remembering apart", () => {
    expect(checkClaim(noRecall({ epistemic: "does_not_recall" }), part(q)).rejectionReason).toBe("epistemic_contradicts_answer");
    const recall: PartLine[] = [q[0], { id: 2, role: "answer", text: "A. I don't recall." }];
    expect(checkClaim(noRecall({ epistemic: "does_not_recall", answerPhrase: "I don't recall" }), part(recall)).status).toBe("verified");
  });

  it("rejects an adopted claim when the attorney's line isn't a question", () => {
    const notQuestion: PartLine[] = [
      { id: 1, role: "question", text: "Q. I'll take that." },
      { id: 2, role: "answer", text: "A. I don't know the answer." },
    ];
    expect(checkClaim(noRecall({ keyPhrase: "I'll take that", answerPhrase: "I don't know the answer" }), part(notQuestion)).rejectionReason).toBe(
      "not_a_question",
    );
  });
});

describe("findHedge: only a hedge governing the phrase's own clause", () => {
  it("finds a hedge in the phrase's clause, and a bare disclaimer introducing it", () => {
    expect(findHedge("business process outsourcing had become a very hot topic", "I think business process outsourcing had become a very hot topic, probably a hotter topic.")).toBe("i think");
    expect(findHedge("it has to go to Safra Catz for approval", "I don't know that for a fact, but it has to go to Safra Catz for approval.")).toBe(
      "i don t know that for a fact",
    );
  });

  it("doesn't let a hedge in another sentence or clause qualify the phrase", () => {
    const p299 = "Well, I'm sure I've seen something similar to it in terms of the overall plan for the acquisition, but I don't think I've ever seen this specific presentation.";
    expect(findHedge("I'm sure I've seen something similar to it", p299)).toBeNull();
    expect(findHedge("I don't think I've ever seen this specific presentation", p299)).toBe("i don t think");
    expect(findHedge("It is integration software", "It is integration software. Again, I'm not sure what I have already mentioned.")).toBeNull();
    // P3171 35:03: the "I believe" belongs to the later conjunct; the disclaimer governs this phrase.
    const p22 = "I don't know that for a fact, but it has to go to Safra Catz for approval and HQ -- and I believe it likely to goes through HQ Apps.";
    expect(findHedge("it has to go to Safra Catz for approval", p22)).toBe("i don t know that for a fact");
    expect(findHedge("I believe it likely to goes through HQ Apps", p22)).toBe("i believe");
  });

  it("finds possibility and recollection hedges governing the phrase", () => {
    expect(findHedge("Tom, might have seen me", "My neighbor, Tom, might have seen me. We waved or something.")).toBe("might have");
    expect(findHedge("Around 10, maybe 10:30", "Around 10, maybe 10:30. I had work the next morning.")).toBe("maybe");
    expect(findHedge("it was in March", "As far as I recall, it was in March.")).toBe("as far as i recall");
    expect(findHedge("we signed it", "Perhaps we signed it that week.")).toBe("perhaps");
  });

  it("ignores a hedge that is negated, quoted, or in someone else's reported words", () => {
    expect(findHedge("I was home", "There's no maybe about it, I was home.")).toBeNull();
    expect(findHedge("the memo said that", 'The memo said that "we may have to cut prices."')).toBeNull();
    expect(findHedge("he might have signed it", "Safra told me he might have signed it.")).toBeNull();
    expect(findHedge("she might have signed it", "They said she might have signed it.")).toBeNull();
    // A hedge in a later sentence still doesn't reach back.
    expect(findHedge("I signed it", "I signed it. Maybe in March.")).toBeNull();
  });
});

describe("contextReason", () => {
  const q = (text: string): PartLine[] => [
    { id: 1, role: "question", text },
    { id: 2, role: "answer", text: "A. Yes." },
  ];
  const adopted = (keyPhrase: string) => claim({ source: "adopted_question", keyPhrase, answerPhrase: "Yes" });

  it("marks claims whose meaning comes from an earlier exchange", () => {
    expect(contextReason(adopted("to the customer, I mean"), part(q("Q. -- to the customer, I mean?")), "-- to the customer, I mean?")).toBe(
      "question_continues_earlier_exchange",
    );
    expect(contextReason(adopted("In the applications area"), part(q("Q. In the applications area?")), "In the applications area?")).toBe(
      "question_too_short_to_stand_alone",
    );
    expect(contextReason(claim({ keyPhrase: "More customers" }), part(q("Q. You define scale as meaning what?")), "")).toBe("phrase_too_short_to_stand_alone");
    expect(contextReason(claim({ keyPhrase: "we sold the database to IBM" }), part([], ["starts_mid_turn"]), "")).toBe("exchange_starts_mid_turn");
  });

  it("keeps the model's flag as metadata only: alone, it never excludes a claim", () => {
    expect(contextReason(claim({ keyPhrase: "it will make it a lot harder", dependsOnEarlierExchange: true }), part([]), "")).toBeNull();
  });

  it("leaves a self-contained claim alone, however short its question", () => {
    expect(contextReason(claim({ keyPhrase: "they're not buying any software, they're buying the online service" }), part(q("Q. To what degree?")), "To what degree?")).toBeNull();
  });
});

describe("groundEntities", () => {
  it("keeps names the exchange's words support, by full name or a capitalized alias, and sets aside the rest", () => {
    const text = "Q. Who approved it? A. Ms. Catz did, through the e-business suite, as Oracle E-Business Suite users do.";
    expect(groundEntities(["Safra Catz", "Oracle", "Oracle E-Business Suite", "PeopleSoft"], text)).toEqual({
      entities: ["oracle", "oracle e business suite", "safra catz"],
      ungrounded: ["peoplesoft"],
    });
  });

  it("doesn't ground a name on lowercase common words alone, or add the company the exchange doesn't name", () => {
    const text = "Q. And the systems? A. Our e-business suite runs on those systems.";
    expect(groundEntities(["Siebel Systems", "Oracle E-Business Suite", "Oracle"], text)).toEqual({
      entities: [],
      ungrounded: ["oracle", "oracle e business suite", "siebel systems"],
    });
  });
});

describe("regression fixture: the outsourcing statement the first pilot missed (P3171 249:13-20)", () => {
  // The stored lines of exchange 376, up to the statement.
  const p376: PartLine[] = [
    { id: 1, role: "question", text: "Q. To what degree?" },
    { id: 2, role: "answer", text: "A. I think business process outsourcing had become" },
    { id: 3, role: "answer", text: "a very hot topic, probably a hotter topic than actually" },
    { id: 4, role: "answer", text: "people signing big deals, but everyone was talking about" },
    { id: 5, role: "answer", text: "it. And that was a concern because if people outsource" },
    { id: 6, role: "answer", text: "their H.R., if they outsource purchasing, if they" },
    { id: 7, role: "answer", text: "outsource accounts payable, they're not buying any" },
    { id: 8, role: "answer", text: "software, they're buying the online service." },
  ];
  const expected = claim({
    keyPhrase: "they're not buying any software, they're buying the online service",
    subject: "customers who outsource",
    predicate: "buy",
    object: "software",
    polarity: "denies",
  });

  it("verifies on its own lines, unhedged (the 'I think' is in the previous sentence) and self-contained", () => {
    expect(checkClaim(expected, part(p376))).toMatchObject({
      status: "verified",
      hedge: null,
      contextDependent: false,
      evidenceLineIds: [7, 8],
    });
  });
});

describe("normalizeEntities (unchanged)", () => {
  it("still normalizes", () => {
    expect(normalizeEntities(["The Board"])).toEqual(["board"]);
  });
});
