import { describe, expect, it } from "vitest";
import { mergeCoverage, readCards, type Chunk, type ChunkExchange } from "../../server/src/claims";

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
    const r = readCards(chunk(meeting, yes), reply([], ["E1"]));
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
    expect(r.cards.map((c) => c.rejectionReason)).toEqual(["span_unresolved", "not_a_qa_exchange"]);
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
