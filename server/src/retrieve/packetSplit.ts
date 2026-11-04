// Splits issue packets past the Milestone 2.5 limits (docs/packet-size-analysis.md: at most 8 pairs and about
// 9,000 input tokens per packet) into smaller packets, deterministically. Pure. Every original pair lands in
// exactly one part, in its original order; parts keep the original packet's ID with a suffix (`.1`, `.2`, ...),
// and a packet within the limits is returned unchanged. A single pair whose two passages alone pass the token
// limit becomes a part of its own, flagged `oversize`, never dropped or truncated.

import type { FrozenItem } from "./frozen";
import { INSTRUCTION_TOKENS, itemTokens, type EvidencePacket, type PacketSet } from "./grouping";

export const PACKET_LIMITS = { maxPairs: 8, maxInputTokens: 9_000 } as const;
export type PacketLimits = { maxPairs: number; maxInputTokens: number };
export type SplitPacket = EvidencePacket & { splitFrom: string | null; oversize: boolean };

export function splitPacket(packet: EvidencePacket, tokensOf: (key: string) => number, limits: PacketLimits = PACKET_LIMITS): SplitPacket[] {
  if (packet.pairs.length <= limits.maxPairs && packet.inputTokens <= limits.maxInputTokens) return [{ ...packet, splitFrom: null, oversize: false }];
  const parts: { pairs: [string, string][]; items: Set<string> }[] = [];
  const cost = (items: Set<string>) => INSTRUCTION_TOKENS + [...items].reduce((t, k) => t + tokensOf(k), 0);
  for (const pair of packet.pairs) {
    const last = parts.at(-1);
    const grown = last ? new Set([...last.items, ...pair]) : null;
    if (last && grown && last.pairs.length < limits.maxPairs && cost(grown) <= limits.maxInputTokens) {
      last.pairs.push(pair);
      last.items = grown;
    } else parts.push({ pairs: [pair], items: new Set(pair) });
  }
  // Items keep the original packet's order, so the prompt reads the same passages in the same order.
  return parts.map((p, i) => {
    const items = packet.items.filter((k) => p.items.has(k));
    const inputTokens = cost(p.items);
    return { id: `${packet.id}.${i + 1}`, issue: packet.issue, items, pairs: p.pairs, inputTokens, splitFrom: packet.id, oversize: inputTokens > limits.maxInputTokens };
  });
}

export function splitPacketSet(set: PacketSet, items: readonly FrozenItem[], limits: PacketLimits = PACKET_LIMITS): Omit<PacketSet, "packets"> & { packets: SplitPacket[] } {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const tokensOf = (k: string) => itemTokens(byKey.get(k)!);
  return { ...set, settings: { ...set.settings, split: limits }, packets: set.packets.flatMap((p) => splitPacket(p, tokensOf, limits)) };
}
