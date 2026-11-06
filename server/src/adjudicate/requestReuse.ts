// Exact-request reuse: the cache key (DESIGN.md, "Implementation note: exact-request reuse"). Pure: no I/O, clock
// or randomness. A recorded response may be reused only for the same request: what the provider would see, byte for
// byte, from the same evidence. Equivalence is never inferred from similar testimony or unchanged pairs.

import { createHash } from "node:crypto";
import { packetRequestParams } from "./packetModel";
import { PACKET_PROMPTS, type ContractId, type IssuePacket } from "./packetPrompt";

export const REQUEST_REUSE_VERSION = "exact-request-v1";

// JSON with every object's keys sorted, so the same request always serialises the same way.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// The provider-visible request, as both transports send it (packetRequestParams: model, max_tokens, system prompt
// with cache control, effort, output schema, the packet text), plus the adjudicator that would send it (a test or
// stand-in model with another id or effort never shares a key with the real one) and the contract.
export function requestFingerprint(contract: ContractId, packet: IssuePacket, adjudicator: { model: string; effort: string }): string {
  const text = PACKET_PROMPTS[contract].format(packet);
  const params = packetRequestParams(text, packet.pairs.length, contract);
  return sha(canonicalJson({ v: REQUEST_REUSE_VERSION, contract, adjudicator: { model: adjudicator.model, effort: adjudicator.effort }, params }));
}

// The evidence the request was built from: each shown deposition with its witness, parser version and evidence epoch,
// and each passage's stored line ids, in order. Identical text from re-ingested, corrected, re-attributed or re-parsed
// evidence gets another key.
export type DepositionEvidence = { witnessId: number; parserVersion: string; evidenceEpoch: number };
export function evidenceKey(packet: IssuePacket, depositions: ReadonlyMap<number, DepositionEvidence>): string | null {
  const ids = [...new Set(packet.passages.map((p) => p.depositionId))].sort((a, b) => a - b);
  if (ids.some((id) => !depositions.has(id))) return null; // unknown provenance: never reusable
  return sha(canonicalJson({
    v: REQUEST_REUSE_VERSION,
    depositions: ids.map((id) => ({ id, ...depositions.get(id)! })),
    passages: packet.passages.map((p) => ({ id: p.id, depositionId: p.depositionId, witnessId: p.witnessId, lines: p.lines.map((l) => l.id), before: p.before.map((l) => l.id), after: p.after.map((l) => l.id) })),
  }));
}

// What a reused request is estimated to have avoided: the source call's recorded cost, converted between standard and
// batch prices when the two runs differ. An estimate (a re-sent request's output would vary), never a charge.
export function avoidedCostEstimate(sourceCostUsd: number, sourceWasBatch: boolean, thisRunIsBatch: boolean, batchMultiplier: number): number {
  if (sourceWasBatch === thisRunIsBatch) return sourceCostUsd;
  return sourceWasBatch ? sourceCostUsd / batchMultiplier : sourceCostUsd * batchMultiplier;
}
