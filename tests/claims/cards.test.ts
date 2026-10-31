import { describe, expect, it } from "vitest";
import { addressedShare, isNegated, mergeCoverage, readCards, screenNoAssertion, type Chunk, type ChunkExchange } from "../../server/src/claims";

const exchange = (id: number, question: string, answer: string, over: Partial<ChunkExchange> = {}): ChunkExchange => ({
  id, depositionId: 1, witnessId: 7, kind: "qa",
  lines: [{ id: id * 10, role: "question", text: `Q. ${question}` }, { id: id * 10 + 1, role: "answer", text: `A. ${answer}` }],
  ...over,
});
const meeting = exchange(1, "What happened with the agreement?", "We met in March. We discussed pricing in April. We signed the agreement in May.");
const yes = exchange(2, "Did Ms. Catz approve the discount?", "Yes.");
const chunk = (...exchanges: ChunkExchange[]): Chunk => ({ depositionId: 1, witnessId: 7, exchanges });
const card = (over: Record<string, unknown> = {}) => ({
  exchangeId: "E1", sourcePhrase: "We met in March", statement: "Oracle and the other party met in March.", event: "March meeting", subject: "Oracle", entities: ["Oracle"], predicate: "met",
  object: null, time: "March", location: null, amount: null, stance: "asserts", epistemic: "asserted", ...over,
});
const reply = (cards: unknown[], noAssertion: string[] = []) => ({ stopReason: "end_turn", text: JSON.stringify({ cards, noAssertion }) });

describe("readCards", () => {
  it("accepts a single grounded card, with its exact lines", () => {
    const r = readCards(chunk(meeting), reply([card()]));
    expect(r.cards[0]).toMatchObject({ status: "usable", exchangeId: 1, firstLineId: 11, lastLineId: 11, rejectionReason: null });
    expect(r.coverage).toEqual([{ exchangeId: 1, status: "carded", cards: 1, error: null }]);
  });

  it("keeps several independent cards from one exchange", () => {
    const r = readCards(chunk(meeting), reply([card(), card({ sourcePhrase: "We discussed pricing in April", statement: "They discussed pricing in April." }), card({ sourcePhrase: "We signed the agreement in May", statement: "They signed the agreement in May." })]));
    expect(r.cards.map((c) => [c.status, c.ordinal])).toEqual([["usable", 0], ["usable", 1], ["usable", 2]]);
    expect(new Set(r.cards.map((c) => c.cardKey)).size).toBe(3);
    expect(r.coverage[0].cards).toBe(3);
  });

  it("tells a valid zero-card result from silence", () => {
    const housekeeping = exchange(1, "Do you see that?", "Yes.");
    const r = readCards(chunk(housekeeping, yes), reply([], ["E1"]));
    expect(r.coverage.map((c) => c.status)).toEqual(["no_assertion", "omitted"]);
  });

  it.each([
    ["no response at all", null, "no response"],
    ["no output", { stopReason: "end_turn", text: null }, "no structured output"],
    ["invalid JSON", { stopReason: "end_turn", text: "{nope" }, "not JSON"],
    ["the wrong shape", { stopReason: "end_turn", text: '{"cards":[]}' }, "no cards or noAssertion"],
    ["a refusal", { stopReason: "refusal", text: null }, "refused"],
    ["a cut-off response", { stopReason: "max_tokens", text: '{"cards":[{' }, "cut off"],
  ])("fails every exchange on %s, never reading it as no claims", (_n, r, reason) => {
    const read = readCards(chunk(meeting, yes), r);
    expect(read.unusable).toContain(reason);
    expect(read.coverage.every((c) => c.status === "failed" && c.error?.includes(reason))).toBe(true);
  });

  it("rejects a card citing an exchange outside the chunk, and keeps it", () => {
    const r = readCards(chunk(meeting), reply([card({ exchangeId: "E999" })]));
    expect(r.cards[0]).toMatchObject({ status: "rejected", rejectionReason: "unknown_exchange", exchangeId: null, citedExchange: "E999" });
    expect(r.coverage[0].status).toBe("omitted");
  });

  it("rejects a source phrase that isn't in the exchange, including an altered one", () => {
    const r = readCards(chunk(meeting), reply([card({ sourcePhrase: "We met in December" }), card({ sourcePhrase: "the board approved the merger", statement: "x" })]));
    expect(r.cards.map((c) => c.rejectionReason)).toEqual(["source_phrase_not_in_exchange", "source_phrase_not_in_exchange"]);
    expect(r.coverage[0]).toMatchObject({ status: "failed" });
    expect(r.coverage[0].error).toContain("source_phrase_not_in_exchange");
  });

  it("rejects an exchange with no testimony lines, or one that isn't q and a", () => {
    const empty = exchange(3, "x", "y", { lines: [] });
    const colloquy = exchange(4, "Did you go?", "We met in March.", { kind: "colloquy" });
    const r = readCards(chunk(empty, colloquy), reply([card({ exchangeId: "E3" }), card({ exchangeId: "E4" })]));
    expect(r.cards.map((c) => c.rejectionReason)).toEqual(["no_witness_answer", "not_a_qa_exchange"]);
  });

  it("rejects a card on an exchange with no witness answer, which is no_assertion, not a failure to retry", () => {
    const noAnswer = exchange(5, "This will be your deposition.", "x", { lines: [{ id: 50, role: "question", text: "Q. This will be your deposition." }] });
    const r = readCards(chunk(noAnswer), reply([card({ exchangeId: "E5", sourcePhrase: "This will be your deposition" })]));
    expect(r.cards[0]).toMatchObject({ status: "rejected", rejectionReason: "no_witness_answer" });
    expect(r.coverage[0]).toEqual({ exchangeId: 5, status: "no_assertion", cards: 0, error: null });
  });

  it("rejects a denial of a negative statement, and counts other negatives without rejecting them", () => {
    const no = exchange(6, "Were there guidelines?", "No.");
    for (const statement of ["The witness has given no guidelines.", "Guidelines weren't given.", "He cannot recall."]) {
      expect(readCards(chunk(no), reply([card({ exchangeId: "E6", sourcePhrase: "Were there guidelines", statement, stance: "denies" })])).cards[0].rejectionReason).toBe("negated_denial");
    }
    const positive = readCards(chunk(no), reply([card({ exchangeId: "E6", sourcePhrase: "Were there guidelines", statement: "Guidelines were given.", stance: "denies" })]));
    expect(positive.cards[0].status).toBe("usable");
    const asserted = readCards(chunk(meeting), reply([card({ statement: "They did not meet in June." })]));
    expect(asserted.cards[0].status).toBe("usable");
    expect(isNegated("They did not meet in June.")).toBe(true);
    expect(isNegated("Nottingham knows the notary.")).toBe(false);
  });

  it("measures how much of a chunk was addressed, counting no_assertion and rejected cards, never omissions", () => {
    expect(addressedShare(readCards(chunk(meeting, yes), reply([card()])))).toBe(0.5);
    const housekeeping = exchange(2, "Do you see that?", "Yes.");
    expect(addressedShare(readCards(chunk(meeting, housekeeping), reply([card()], ["E2"])))).toBe(1);
    expect(addressedShare(readCards(chunk(meeting, housekeeping), reply([card({ sourcePhrase: "not there" })], ["E2"])))).toBe(1);
    expect(addressedShare(readCards(chunk(meeting, yes), reply([card()], ["E2"])))).toBe(0.5); // a doubted noAssertion isn't addressed
    expect(addressedShare(readCards(chunk(meeting, yes), reply([])))).toBe(0);
    expect(addressedShare(readCards(chunk(meeting), null))).toBeNull();
  });

  it("doubts a noAssertion on testimony, and says why, keeping it apart from a confirmed one", () => {
    const long = exchange(8, "Who would be doing that?", "Probably a specialized telesales organization would be calling existing customers and asking about more seats.");
    const r = readCards(chunk(long), reply([], ["E8"]));
    expect(r.coverage[0]).toMatchObject({ status: "suspected_omission", cards: 0, error: null });
    expect(r.coverage[0].signals).toContain("long_answer");
  });

  it.each([
    ["a plain yes adopting a fact", "Has there been a change in your position at the company?", "Yes.", "adopts_or_rejects_question"],
    ["a plain no rejecting a fact", "Did Ms. Catz approve the PeopleSoft discount?", "No.", "adopts_or_rejects_question"],
    ["no memory of a fact", "Did you attend the April board meeting?", "I don't recall.", "recollection_of_proposition"],
    ["a short answer with a figure", "How much was the fee?", "About $2,000 per seat.", "factual_language"],
    ["a name in a short question", "And that would be Mr. Wall?", "Yes.", "adopts_or_rejects_question"],
    ["a fact beside housekeeping words", "Below that is an e-mail you were sent from Mr. Phillips, do you see that?", "Yes.", "adopts_or_rejects_question"],
    ["a figure in a short question", "Was it 40?", "No.", "adopts_or_rejects_question"],
    ["an answer whose question is in an earlier part", "", "Yes.", "answer_without_question"],
    ["a fragment answering a fact", "How long has the PeopleSoft support commitment been planned for?", "Ten years", "short_answer_to_factual_question"],
    ["a short opinion", "He further says that we are not aiming to flout the direction on discounting the suite.", "He wants to win.", "short_answer_to_factual_question"],
  ])("screens short testimony too: %s", (_n, q, a, signal) => {
    expect(screenNoAssertion(q, a)).toContain(signal);
  });

  it.each([
    ["a document check", "Do you see that?", "Yes."],
    ["reading a document", "Would you read through those and tell me when you are finished, and I have a couple of questions?", "Okay."],
    ["a filler question", "All right, sir.", "Okay."],
    ["no answer at all", "This will be your deposition under that demand.", ""],
    ["a request to repeat", "Did you approve the contract?", "Could you repeat that?"],
    ["a clarifying question", "Did Oracle discount the PeopleSoft product line?", "For certain customers?"],
    ["an answer cut off before it starts", "Did Oracle discount the PeopleSoft product line?", "We --"],
    ["filler to a long instruction", "Let me ask you to flip through the document to Exhibit 19.", "Okay."],
  ])("doesn't doubt housekeeping: %s", (_n, q, a) => {
    expect(screenNoAssertion(q, a)).toEqual([]);
  });

  it("a carded exchange stays carded whatever another chunk's noAssertion says", () => {
    const seen = new Set<string>();
    const carded = new Set<number>();
    const first = readCards(chunk(meeting), reply([card()]), seen, carded);
    const second = readCards(chunk(meeting), reply([], ["E1"]), seen, carded);
    expect(mergeCoverage([1], [first, second])[0]).toMatchObject({ status: "carded", cards: 1 });
  });

  it("keeps the earlier chunk's cards on an overlap, however a later chunk words them", () => {
    const seen = new Set<string>();
    const carded = new Set<number>();
    const first = readCards(chunk(meeting), reply([card()]), seen, carded);
    const second = readCards(chunk(meeting), reply([card({ statement: "A meeting took place in March." })]), seen, carded);
    expect(first.cards[0].status).toBe("usable");
    expect(second.cards[0]).toMatchObject({ status: "rejected", rejectionReason: "duplicate_card" });
    expect(second.coverage[0].status).toBe("carded");
  });

  it("an earlier chunk's rejected card doesn't block a later good one", () => {
    const seen = new Set<string>();
    const carded = new Set<number>();
    readCards(chunk(meeting), reply([card({ sourcePhrase: "words not there" })]), seen, carded);
    expect(readCards(chunk(meeting), reply([card()]), seen, carded).cards[0].status).toBe("usable");
  });

  it.each([["witness", { witnessId: 8 }], ["session", { depositionId: 2 }]])("rejects a source from another %s", (_n, over) => {
    const r = readCards(chunk(exchange(1, "x?", "We met in March.", over)), reply([card()]));
    expect(r.cards[0].rejectionReason).toBe("exchange_outside_session");
  });

  it("a bare answer stands for its question, and needs one", () => {
    const r = readCards(chunk(yes), reply([card({ exchangeId: "E2", sourcePhrase: "Yes." })]));
    expect(r.cards[0]).toMatchObject({ status: "usable", firstLineId: 20, lastLineId: 21 });
    const alone = exchange(5, "", "Yes.", { lines: [{ id: 50, role: "answer", text: "A. Yes." }] });
    expect(readCards(chunk(alone), reply([card({ exchangeId: "E5", sourcePhrase: "Yes." })])).cards[0].rejectionReason).toBe("bare_answer_without_question");
  });

  it("sets aside entities the exchange's words don't support, without rejecting the card", () => {
    const r = readCards(chunk(meeting), reply([card({ entities: ["PeopleSoft", "March"] })]));
    expect(r.cards[0].status).toBe("usable");
    expect(r.cards[0].ungroundedEntities).toContain("peoplesoft");
  });

  it("rejects a duplicate in a chunk, and one repeated by the overlapping chunk", () => {
    const seen = new Set<string>();
    const first = readCards(chunk(meeting), reply([card(), card({ statement: "ORACLE and the other party  met in March!" })]), seen);
    expect(first.cards.map((c) => c.rejectionReason)).toEqual([null, "duplicate_card"]);
    const overlap = readCards(chunk(meeting), reply([card()]), seen);
    expect(overlap.cards[0].rejectionReason).toBe("duplicate_card");
    expect(overlap.coverage[0].status).toBe("carded");
  });

  it.each([
    ["epistemic", { epistemic: "certain" }],
    ["polarity", { stance: "maybe" }],
    ["structured", { statement: " " }],
    ["missing", { predicate: undefined }],
    ["extra", { confidence: 0.9 }],
  ])("rejects an invalid %s field, keeping its raw text and its neighbours", (_n, over) => {
    const r = readCards(chunk(meeting), reply([card(over), card({ sourcePhrase: "We signed the agreement in May", statement: "Signed in May." })]));
    expect(r.cards[0].status).toBe("rejected");
    expect(r.cards[0].rejectionReason).toContain("invalid_fields");
    expect(r.cards[0].raw).toBeDefined();
    expect(r.cards[1].status).toBe("usable");
  });

  it("gives the same keys when the same extraction is processed again", () => {
    const run = () => readCards(chunk(meeting), reply([card(), card({ epistemic: "certain" })]));
    expect(run().cards.map((c) => c.cardKey)).toEqual(run().cards.map((c) => c.cardKey));
  });

  it("a partial failure keeps what worked and marks exactly what didn't", () => {
    const r = readCards(chunk(meeting, yes, exchange(3, "Where?", "In Redwood City.")), reply([card(), card({ exchangeId: "E2", sourcePhrase: "invented words" })], ["E9"]));
    expect(r.coverage.map((c) => c.status)).toEqual(["carded", "failed", "omitted"]);
    expect(r.unknownNoAssertion).toEqual(["E9"]);
  });
});

describe("mergeCoverage", () => {
  it("covers every eligible exchange, keeps the best outcome across chunks, and adds card counts", () => {
    const first = readCards(chunk(meeting, yes), reply([card()]));
    const failed = readCards(chunk(yes), null);
    const second = readCards(chunk(meeting), reply([card({ sourcePhrase: "We signed the agreement in May", statement: "Signed in May." })]));
    expect(mergeCoverage([1, 2, 3], [first, failed, second]).map((c) => [c.exchangeId, c.status, c.cards])).toEqual([[1, "carded", 2], [2, "failed", 0], [3, "not_processed", 0]]);
  });
});
