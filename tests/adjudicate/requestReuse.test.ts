import { describe, expect, it } from "vitest";
import { avoidedCostEstimate, canonicalJson, evidenceKey, requestFingerprint, REUSE_COMPATIBILITY_VERSION, type DepositionEvidence } from "../../server/src/adjudicate/requestReuse";
import type { IssuePacket } from "../../server/src/adjudicate/packetPrompt";
import { freshOf, reuseAllowed, reuseApplies } from "../../server/src/jobs/requestReuse";

const passage = (id: string, depositionId: number, page: number, answer: string, lineBase = page * 10): IssuePacket["passages"][number] => ({
  key: `doc${depositionId}#1-2`, id, depositionId, groupId: 1, witnessId: depositionId, witnessName: "W", session: `s${depositionId}`, takenOn: null, partIds: [1], wholeExchange: true,
  lines: [{ id: lineBase, page, line: 4, text: "Q. Was it red?", role: "question" }, { id: lineBase + 1, page, line: 5, text: answer, role: "answer" }],
  before: [], after: [], gapBefore: false, gapAfter: false,
});
const packet: IssuePacket = { id: "pk-1", passages: [passage("E1", 1, 3, "A. Yes."), passage("E2", 2, 9, "A. No, blue.")], pairs: [{ pairId: "P1", a: "E1", b: "E2" }] };
const real = { model: "claude-sonnet-5-5", effort: "medium" };
const evidence = new Map<number, DepositionEvidence>([[1, { witnessId: 1, parserVersion: "r12", evidenceEpoch: 0 }], [2, { witnessId: 2, parserVersion: "r12", evidenceEpoch: 0 }]]);

describe("the request fingerprint", () => {
  it("is stable for the same request, and canonical JSON ignores key order", () => {
    expect(requestFingerprint("packet-v1", packet, real)).toBe(requestFingerprint("packet-v1", structuredClone(packet), real));
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe('{"a":{"d":[1,{"x":1,"y":2}]},"b":1}');
  });
  it("changes with one character of evidence text, the packet id shown, the pair count (output cap), contract, model or effort", () => {
    const base = requestFingerprint("packet-v1", packet, real);
    const variants = [
      requestFingerprint("packet-v1", { ...packet, passages: [packet.passages[0], passage("E2", 2, 9, "A. No, blue!")] }, real),
      requestFingerprint("packet-v1", { ...packet, passages: [packet.passages[0], passage("E3", 2, 9, "A. No, blue.")], pairs: [{ pairId: "P1", a: "E1", b: "E3" }] }, real),
      requestFingerprint("packet-v1", { ...packet, passages: [...packet.passages, passage("E4", 2, 11, "A. Maybe.")], pairs: [...packet.pairs, { pairId: "P2", a: "E1", b: "E4" }] }, real),
      requestFingerprint("stretch-v2", packet, real),
      requestFingerprint("packet-v1", packet, { ...real, model: "claude-haiku-5-5" }),
      requestFingerprint("packet-v1", packet, { ...real, effort: "low" }),
    ];
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });
  it("changes with the output cap actually sent (max_tokens); the default cap keys exactly as before", () => {
    const base = requestFingerprint("packet-v1", packet, real);
    expect(requestFingerprint("packet-v1", packet, real, undefined, 5_500)).toBe(base); // the default for one pair
    expect(requestFingerprint("packet-v1", packet, real, undefined, 1_200)).not.toBe(base);
    expect(requestFingerprint("packet-v1", packet, real, undefined, 1_200)).not.toBe(requestFingerprint("packet-v1", packet, real, undefined, 1_100));
  });
  it("changes with the cache-compatibility version, so bumping it retires every earlier response", () => {
    expect(requestFingerprint("packet-v1", packet, real)).toBe(requestFingerprint("packet-v1", packet, real, REUSE_COMPATIBILITY_VERSION));
    expect(requestFingerprint("packet-v1", packet, real, `${REUSE_COMPATIBILITY_VERSION}-next`)).not.toBe(requestFingerprint("packet-v1", packet, real));
  });
});

describe("the evidence key", () => {
  it("changes with a deposition's parser version, evidence epoch or witness, and with the stored line ids shown", () => {
    const base = evidenceKey(packet, evidence)!;
    const changed = (id: number, o: Partial<DepositionEvidence>) => evidenceKey(packet, new Map([...evidence, [id, { ...evidence.get(id)!, ...o }]]));
    const keys = [changed(1, { parserVersion: "r13" }), changed(2, { evidenceEpoch: 1 }), changed(2, { witnessId: 9 }), evidenceKey({ ...packet, passages: [packet.passages[0], passage("E2", 2, 9, "A. No, blue.", 500)] }, evidence)];
    expect(new Set([base, ...keys]).size).toBe(keys.length + 1);
    expect(evidenceKey(packet, evidence)).toBe(base);
  });
  it("is null when a shown deposition's provenance is unknown, so the request is never reusable", () => {
    expect(evidenceKey(packet, new Map([[1, evidence.get(1)!]]))).toBeNull();
  });
});

describe("reuse switches and the avoided-cost estimate", () => {
  it("applies only to live runs that ask for it; the server switch is on unless REQUEST_REUSE=off", () => {
    expect(reuseApplies({ mode: "live" }, true)).toBe(true);
    expect(reuseApplies({ mode: "live" }, undefined)).toBe(false);
    expect(reuseApplies({ mode: "mock" }, true)).toBe(false);
    expect([reuseAllowed({}), reuseAllowed({ REQUEST_REUSE: "" }), reuseAllowed({ REQUEST_REUSE: "off" })]).toEqual([true, true, false]);
    expect(reuseApplies({ mode: "live", config: { reuse: "fresh" } }, true)).toBe(false); // a fresh analysis reuses nothing
    expect(reuseApplies({ mode: "live", config: { reuse: "automatic" } }, true)).toBe(true);
    expect([freshOf({ config: { reuse: "fresh" } }), freshOf({ config: {} }), freshOf({ config: null })]).toEqual([true, false, false]);
  });
  it("prices the avoided request in this run's mode", () => {
    expect(avoidedCostEstimate(0.02, false, false, 0.5)).toBe(0.02);
    expect(avoidedCostEstimate(0.02, false, true, 0.5)).toBe(0.01);
    expect(avoidedCostEstimate(0.01, true, false, 0.5)).toBe(0.02);
  });
});
