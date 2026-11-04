import { describe, expect, it } from "vitest";
import { formatIssuePacket, maxOutputTokensFor, PACKET_SYSTEM_PROMPT, type IssuePacket, type PacketPassage } from "../../server/src/adjudicate/packetPrompt";
import { isAbstention, PACKET_OUTCOMES, PACKET_REPLY_JSON_SCHEMA, parsePacketReply, type PairVerdict } from "../../server/src/adjudicate/packetSchema";

const verdict = (over: Partial<PairVerdict> = {}): PairVerdict => ({
  pairId: "R1", outcome: "direct", evidenceAId: "E1", evidenceBId: "E2", keyPhraseA: "I was home", keyPhraseB: "I went out",
  attributionA: "asserted", attributionB: "asserted", stanceA: "affirms", stanceB: "affirms", sameEvent: "yes", scopeAligned: "yes",
  conflictBasis: "mutually_exclusive", conflictSource: "cited_exchanges", falsePositiveReason: null, explanation: "1:02 against 9:04.",
  alternativeExplanation: null, alternativeSupport: null, contextUsed: [], ...over,
});

const passage = (id: string, witnessName: string, session: string, text: string): PacketPassage => ({
  key: `${session}#1:1-1:2`, id, depositionId: 1, groupId: 1, witnessId: 1, witnessName, session, takenOn: null, partIds: [1], wholeExchange: true,
  lines: [{ id: 1, page: 3, line: 4, text: "Q. Where were you?", role: "question" }, { id: 2, page: 3, line: 5, text: `A. ${text}`, role: "answer" }],
  before: [], after: [{ id: 3, page: 3, line: 6, text: "Q. Next topic." }], gapBefore: false, gapAfter: false,
});

describe("packet reply schema", () => {
  it("accepts one verdict per pair, including the three abstentions", () => {
    const reply = { verdicts: [verdict(), verdict({ pairId: "R2", outcome: "needs_more_context", keyPhraseA: null, keyPhraseB: null, conflictBasis: "none", conflictSource: "none" })] };
    const r = parsePacketReply(JSON.stringify(reply));
    expect(r.ok).toBe(true);
    expect(PACKET_OUTCOMES.filter(isAbstention)).toEqual(["insufficient_evidence", "needs_more_context", "unable_to_assess"]);
  });

  it("rejects a confidence, score or probability anywhere", () => {
    for (const key of ["confidence", "score", "probability"]) {
      expect(parsePacketReply(JSON.stringify({ verdicts: [{ ...verdict(), [key]: 0.9 }] })).ok).toBe(false);
      expect(parsePacketReply(JSON.stringify({ verdicts: [verdict()], [key]: 1 })).ok).toBe(false);
    }
    expect(JSON.stringify(PACKET_REPLY_JSON_SCHEMA)).not.toMatch(/confidence|probability|"score"/);
  });

  it("reports text that isn't JSON or breaks the schema, never a verdict", () => {
    expect(parsePacketReply(null)).toEqual({ ok: false, error: "no structured output" });
    expect(parsePacketReply("not json")).toEqual({ ok: false, error: "reply is not JSON" });
    const bad = parsePacketReply(JSON.stringify({ verdicts: [verdict({ outcome: "maybe" as never })] }));
    expect(bad.ok).toBe(false);
  });
});

describe("packet prompt", () => {
  const packet: IssuePacket = {
    id: "P1",
    passages: [passage("E10", "Faye Resnick", "resnick-1996-02-11-direct", "I was home."), passage("E20", "O.J. Simpson", "simpson-1996-01-23", "I went out.")],
    pairs: [{ pairId: "R1", a: "E10", b: "E20" }],
  };

  it("shows every passage with its witness, session and page:line, then the pairs", () => {
    const text = formatIssuePacket(packet);
    expect(text).toContain('<passage id="E10" witness="Faye Resnick" session="resnick-1996-02-11-direct" taken_on="not stated">');
    expect(text).toContain("Exchange [E20] (3:04 to 3:05):\n  3:04  Q. Where were you?\n  3:05  A. I went out.");
    expect(text).toContain("Context after (not part of the exchange):\n  3:06  Q. Next topic.");
    expect(text).toMatch(/Compare each of these 1 pair, and return exactly one verdict for each:\n\n- R1: \[E10\] with \[E20\]$/);
    expect(text).not.toMatch(/\n\n\n/);
  });

  it("asks for one verdict per listed pair, allows abstaining, and never asks for a number", () => {
    expect(PACKET_SYSTEM_PROMPT).toContain("exactly one verdict for every listed pair");
    expect(PACKET_SYSTEM_PROMPT).toContain("Never force a substantive outcome");
    expect(PACKET_SYSTEM_PROMPT).toContain("never give a confidence, score, rating or probability");
    expect(maxOutputTokensFor(1)).toBe(5_500);
    expect(maxOutputTokensFor(10)).toBe(55_000); // the same allowance per pair as ten single-pair requests
    expect(maxOutputTokensFor(30)).toBe(128_000); // the model's ceiling
  });
});
