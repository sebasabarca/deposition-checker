// Compact packet contracts (packet-c1/c2/c3): schemas, prompts, completeness, and conversion to packet-v1 verdicts
// that verify/packet.ts, packetAssess.ts and the safeguards read unchanged. The frozen real packet-v1 replies (the
// accuracy evaluation's, read-only) are re-encoded as each compact contract would carry the same decisions: this
// checks the plumbing, never what a model would decide under the compact prompt.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkDismissalQuotes, COMPACT_CONTRACTS, isCompactDismissal, readCompactReply, type CompactContractId } from "../../server/src/adjudicate/compactRead";
import { COMPACT_MAX_OUTPUT_TOKENS_PER_PAIR, COMPACT_REPLY_JSON_SCHEMAS, compactReplySchema, encodeCompact } from "../../server/src/adjudicate/compactSchema";
import { assessPacketPair } from "../../server/src/adjudicate/packetAssess";
import { PACKET_PROMPTS, PACKET_SYSTEM_PROMPT, type IssuePacket } from "../../server/src/adjudicate/packetPrompt";
import { PACKET_REPLY_JSON_SCHEMA, PairVerdict, parseVerdictsLenient, VERDICT_SCHEMAS } from "../../server/src/adjudicate/packetSchema";
import { verifyPacketReply } from "../../server/src/verify/packet";

const packet: IssuePacket = {
  id: "P1",
  passages: ["E1", "E2", "E3"].map((id, i) => ({
    key: `k${i}`, id, depositionId: i + 1, groupId: 1, witnessId: 1, witnessName: "W", session: `s${i}`, takenOn: null, partIds: [i + 1], wholeExchange: true,
    lines: [{ id: i * 10 + 1, page: 1, line: 1, text: "Q. Were you home that night?", role: "question" as const }, { id: i * 10 + 2, page: 1, line: 2, text: i === 1 ? "A. No, I was at the club." : "A. Yes, I was home all evening.", role: "answer" as const }],
    before: [], after: [], gapBefore: false, gapAfter: false,
  })),
  pairs: [{ pairId: "R1", a: "E1", b: "E2" }, { pairId: "R2", a: "E1", b: "E3" }],
};
const full = (over: Partial<PairVerdict> = {}): PairVerdict => ({
  pairId: "R1", outcome: "direct", evidenceAId: "E1", evidenceBId: "E2", keyPhraseA: "Yes, I was home all evening.", keyPhraseB: "No, I was at the club.",
  attributionA: "asserted", attributionB: "asserted", stanceA: "affirms", stanceB: "affirms", sameEvent: "yes", scopeAligned: "yes",
  conflictBasis: "explicit_negation", conflictSource: "cited_exchanges", falsePositiveReason: null, explanation: "Home at 1:02; at the club at 1:02. These cannot both be true.",
  alternativeExplanation: null, alternativeSupport: null, contextUsed: [], ...over,
});
const fp = full({ pairId: "R2", outcome: "false_positive", evidenceBId: "E3", keyPhraseB: "Yes, I was home all evening.", conflictBasis: "none", conflictSource: "none", falsePositiveReason: "both_can_be_true", explanation: "Both say home." });
const read = (reply: unknown, contract?: CompactContractId, p = packet) => verifyPacketReply(p, parseVerdictsLenient(JSON.stringify(reply), VERDICT_SCHEMAS["packet-v1"], contract));
const statuses = (reply: unknown, contract: CompactContractId = "packet-c1") => Object.fromEntries(read(reply, "screen" in (reply as object) ? contract : undefined).pairs.map((x) => [x.pairId, x.status]));

describe("compact contracts: schema and prompt", () => {
  it("accept their own encoding and reject any extra key, unknown disposition or score-like field", () => {
    for (const c of COMPACT_CONTRACTS) {
      const reply = encodeCompact(c, [full(), fp]);
      expect(compactReplySchema(c).safeParse(reply).success).toBe(true);
      expect(compactReplySchema(c).safeParse({ ...reply, screen: [{ ...reply.screen[0], confidence: 0.9 }] }).success).toBe(false);
      expect(compactReplySchema(c).safeParse({ ...reply, screen: [{ ...reply.screen[0], disposition: "compatible" }] }).success).toBe(false);
      expect(compactReplySchema(c).safeParse({ ...reply, verdicts: [{ ...reply.verdicts[0], score: 3 }] }).success).toBe(false);
      const schema = JSON.stringify(COMPACT_REPLY_JSON_SCHEMAS[c]);
      expect(schema).toContain('"additionalProperties":false');
      expect(schema).not.toMatch(/confidence|probability|"score"|"band"/);
    }
    // Rows of different contracts are not interchangeable.
    expect(compactReplySchema("packet-c1").safeParse(encodeCompact("packet-c2", [fp])).success).toBe(false);
  });
  it("keep packet-v1's prompt, schema and rules: only the reply shape changes", () => {
    expect(PACKET_PROMPTS["packet-v1"].system).toBe(PACKET_SYSTEM_PROMPT);
    expect(PACKET_PROMPTS["packet-v1"].jsonSchema).toBe(PACKET_REPLY_JSON_SCHEMA);
    for (const c of COMPACT_CONTRACTS) {
      const s = PACKET_PROMPTS[c].system;
      expect(s).not.toContain("Return exactly one verdict for every listed pair");
      for (const rule of ["Read carefully:", "Outcomes. Judge what was said", "Never force a substantive outcome", "Evidence grounding:", "keyPhraseA / keyPhraseB", "contextUsed:"]) expect(s).toContain(rule);
      expect(s).toContain('When in doubt, write "verdict"');
      expect(PACKET_PROMPTS[c].format).toBe(PACKET_PROMPTS["packet-v1"].format);
      expect(COMPACT_MAX_OUTPUT_TOKENS_PER_PAIR[c]).toBeGreaterThan(1066);
    }
    expect(PACKET_PROMPTS["packet-c2"].system).toContain("compared, at most twelve words");
    expect(PACKET_PROMPTS["packet-c3"].system).toContain("quoteA and quoteB");
  });
});

describe("compact contracts: completeness and conversion", () => {
  it("a full verdict reads exactly as in packet-v1, and a dismissal becomes a marked, uncited false_positive with no finding", () => {
    const v1 = read({ verdicts: [full(), fp] });
    const c2 = read(encodeCompact("packet-c2", [full(), fp]), "packet-c2");
    expect(c2.pairs[0]).toEqual(v1.pairs[0]);
    expect(assessPacketPair(packet, c2.pairs[0])).toEqual(assessPacketPair(packet, v1.pairs[0]));
    const d = c2.pairs[1];
    expect(d.status).toBe("answered");
    expect(d.verdict && isCompactDismissal(d.verdict)).toBe(true);
    expect(d.verdict).toMatchObject({ outcome: "false_positive", falsePositiveReason: "both_can_be_true", keyPhraseA: null, keyPhraseB: null, compactDismissal: { disposition: "both_can_be_true", compared: "Both say home." } });
    expect(d.semantic?.consistencyIssues).toEqual([]);
    expect(assessPacketPair(packet, d)).toBeNull(); // never a verified finding, never "compatible"
    expect(assessPacketPair(packet, v1.pairs[1])?.type).toBe("false_positive"); // packet-v1 keeps its compatible finding
  });
  it("leave a pair unanswered when its full verdict is missing, it is both dismissed and judged, or its row is malformed", () => {
    const rowsFor = (d1: string, d2: string) => [{ pairId: "R1", disposition: d1 }, { pairId: "R2", disposition: d2 }];
    expect(statuses({ screen: rowsFor("verdict", "both_can_be_true"), verdicts: [] })).toEqual({ R1: "missing", R2: "answered" });
    expect(statuses({ screen: rowsFor("different_event", "both_can_be_true"), verdicts: [full()] })).toEqual({ R1: "answered", R2: "answered" }); // dismissed and judged: the full verdict is kept
    expect(read({ screen: rowsFor("different_event", "both_can_be_true"), verdicts: [full()] }, "packet-c1").pairs[0].verdict).toMatchObject({ outcome: "direct" });
    expect(statuses({ screen: [{ pairId: "R1", disposition: "verdict" }, { pairId: "R2", disposition: "maybe" }], verdicts: [full()] })).toEqual({ R1: "answered", R2: "malformed" });
    expect(statuses({ screen: rowsFor("verdict", "verdict"), verdicts: [full(), { ...full({ pairId: "R2" }), confidence: 1 }] })).toEqual({ R1: "answered", R2: "malformed" });
    expect(statuses({ screen: [{ pairId: "R1", disposition: "verdict" }], verdicts: [full()] })).toEqual({ R1: "answered", R2: "missing" });
    expect(statuses({ screen: [...rowsFor("verdict", "both_can_be_true"), { pairId: "R2", disposition: "different_event" }], verdicts: [full()] })).toEqual({ R1: "answered", R2: "duplicate" });
    expect(read({ screen: rowsFor("verdict", "verdict"), verdicts: [], extra: 1 }, "packet-c1").pairs.every((p) => p.status === "request_failed")).toBe(true);
    expect(read({ screen: rowsFor("verdict", "verdict") }, "packet-c1").pairs.every((p) => p.status === "request_failed")).toBe(true);
  });
  it("read packet-v1 replies exactly as before, and only for the packet-v1 schema", () => {
    expect(readCompactReply({ verdicts: [] }, PairVerdict, "packet-c1")).toBeNull();
    // Read by the run's contract, not the reply's shape: a compact reply to a packet-v1 run is rejected whole, and a
    // c1 row (no quotes) inside a c3 reply is malformed.
    expect(parseVerdictsLenient(JSON.stringify(encodeCompact("packet-c1", [fp])), VERDICT_SCHEMAS["packet-v1"])).toEqual({ ok: false, error: "schema: unexpected keys screen" });
    expect(statuses({ screen: [{ pairId: "R1", quoteA: "x", quoteB: "y", disposition: "verdict" }, { pairId: "R2", disposition: "both_can_be_true" }], verdicts: [full()] }, "packet-c3")).toEqual({ R1: "answered", R2: "malformed" });
    expect(statuses({ verdicts: [full(), fp] })).toEqual({ R1: "answered", R2: "answered" });
    expect(parseVerdictsLenient(JSON.stringify(encodeCompact("packet-c1", [fp])), VERDICT_SCHEMAS["packet-v2"])).toEqual({ ok: false, error: "schema: unexpected keys screen" });
  });
});

// The frozen real packet-v1 replies of the accuracy evaluation (git-ignored data; skipped when absent).
const ROOT = ["data/raw/accuracy-eval", "../deposition-checker/data/raw/accuracy-eval"].find((r) => existsSync(path.join(r, "frozen/requests.jsonl")));
const jsonl = (f: string) => readFileSync(path.join(ROOT!, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

describe.skipIf(!ROOT)("compact contracts on the frozen real packet-v1 replies", () => {
  it("every full verdict verifies, scores and trips the same safeguards as in packet-v1, and every false positive is a finding-less dismissal (C01, C07, NC-001 included)", () => {
    const requests = new Map(jsonl("frozen/requests.jsonl").map((r: { id: string; packet: IssuePacket; labelPairs: { label: string; pairId: string }[] }) => [r.id, r]));
    const seen = new Set<string>();
    let pairs = 0;
    for (const run of ["labelled-packet-v1-r1", "labelled-packet-v1-r2"]) for (const reply of jsonl(`runs/${run}/replies.jsonl`) as { id: string; text: string }[]) {
      const req = requests.get(reply.id)!;
      const parsed = parseVerdictsLenient(reply.text, VERDICT_SCHEMAS["packet-v1"]);
      if (!parsed.ok) throw new Error(parsed.error);
      const v1 = verifyPacketReply(req.packet, parsed);
      for (const c of COMPACT_CONTRACTS) {
        const cv = verifyPacketReply(req.packet, parseVerdictsLenient(JSON.stringify(encodeCompact(c, parsed.verdicts)), VERDICT_SCHEMAS["packet-v1"], c));
        for (const [i, p] of v1.pairs.entries()) {
          const q = cv.pairs[i];
          expect(q.status).toBe(p.status);
          if (p.verdict?.outcome === "false_positive") {
            expect(assessPacketPair(req.packet, q)).toBeNull();
            expect(q.verdict).toMatchObject({ outcome: "false_positive", falsePositiveReason: (p.verdict as PairVerdict).falsePositiveReason });
          } else {
            expect(q).toEqual(p);
            expect(assessPacketPair(req.packet, q)).toEqual(assessPacketPair(req.packet, p));
          }
          pairs++;
        }
      }
      for (const l of req.labelPairs) seen.add(l.label);
    }
    expect(pairs).toBe(326 * 3);
    for (const label of ["C01", "C07", "NC-001"]) expect(seen.has(label)).toBe(true);
  });
});

describe("packet-c3 dismissal quotes are checked against the pair's own exchanges", () => {
  const rows = (qa: string, qb: string) => ({ screen: [{ pairId: "R1", quoteA: "x", quoteB: "y", disposition: "verdict" }, { pairId: "R2", quoteA: qa, quoteB: qb, disposition: "both_can_be_true" }], verdicts: [full()] });
  const check = (reply: unknown) => { const p = parseVerdictsLenient(JSON.stringify(reply), VERDICT_SCHEMAS["packet-v1"], "packet-c3"); if (!p.ok) throw new Error(p.error); return checkDismissalQuotes(p, packet); };
  it("accepts a dismissal quoting both exchanges, and rejects an invented or empty quote so the pair is recovered, not dismissed", () => {
    const words = (id: string) => packet.passages.find((x) => x.id === id)!.lines.map((l) => l.text).join(" ").split(/\s+/).slice(0, 4).join(" ");
    const r2 = packet.pairs.find((x) => x.pairId === "R2")!;
    const ok = check(rows(words(r2.a), words(r2.b)));
    expect(ok.verdicts.map((v: PairVerdict) => v.pairId).sort()).toEqual(["R1", "R2"]);
    const bad = check(rows(words(r2.a), "the defendant confessed everything"));
    expect(bad.verdicts.map((v: PairVerdict) => v.pairId)).toEqual(["R1"]);
    expect(bad.malformed).toEqual([{ index: -1, pairId: "R2", error: "dismissal quote not found in exchange B or its context" }]);
    expect(check(rows("", "")).malformed[0].error).toBe("dismissal quotes not found in exchange A and B or its context");
    expect(verifyPacketReply(packet, bad).pairs.find((x) => x.pairId === "R2")!.status).toBe("malformed");
  });

  it("accepts a quote from the context lines shown around an exchange, and records that side; text shown nowhere stays rejected", () => {
    // The fixture with context shown around E1 (side A of R2): a line before and one after its exchange.
    const line = (id: number, text: string) => ({ id, page: 1, line: id, text, role: "answer" as const });
    const shown: IssuePacket = { ...packet, passages: packet.passages.map((x) => (x.id === "E1" ? { ...x, before: [line(90, "A. I drove back from the office around six.")], after: [line(91, "A. My sister stayed with me until midnight.")] } : x)) };
    const checkIn = (reply: unknown) => { const r = parseVerdictsLenient(JSON.stringify(reply), VERDICT_SCHEMAS["packet-v1"], "packet-c3"); if (!r.ok) throw new Error(r.error); return checkDismissalQuotes(r, shown); };
    const dismissal = (out: ReturnType<typeof checkIn>) => (out.verdicts.find((v: PairVerdict) => v.pairId === "R2") as (PairVerdict & { compactDismissal: { contextQuote?: string[] } }) | undefined)?.compactDismissal;
    const ok = checkIn(rows("My sister stayed with me until midnight", "Yes, I was home all evening"));
    expect(ok.malformed).toEqual([]);
    expect(dismissal(ok)!.contextQuote).toEqual(["A"]);
    expect(dismissal(checkIn(rows("Yes, I was home all evening", "Yes, I was home all evening")))!.contextQuote).toBeUndefined();
    // E3 has no context shown, and the same words aren't in its exchange: side B is still rejected.
    const bad = checkIn(rows("Yes, I was home all evening", "My sister stayed with me until midnight"));
    expect(dismissal(bad)).toBeUndefined();
    expect(bad.malformed).toEqual([{ index: -1, pairId: "R2", error: "dismissal quote not found in exchange B or its context" }]);
  });
});
