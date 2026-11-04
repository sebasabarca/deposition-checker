// Evidence screening contract (Milestone 3, experimental): what a screening strategy says about each issue
// packet (retrieve/grouping.ts) before strong-model adjudication. Pure: no I/O, no model.
//
// Screening only orders work. `priority` is an ordering key, not a probability or a confidence that the
// packet holds a contradiction, so the schema has no such field and rejects unknown keys. A `deferred`
// packet is unread, never "compatible" or "no contradiction". Adjudication state is kept in its own field,
// apart from the screening status, and verdicts never live here.

import { z } from "zod";
import type { CandidatePool, FrozenItem } from "../retrieve/frozen";
import { pairKey } from "../retrieve/frozen";
import type { PacketSet } from "../retrieve/grouping";

export const SCREENING_CONTRACT_VERSION = "screen-contract-v1";

export const SCREEN_STATUSES = ["prioritized", "deferred", "consolidated"] as const;
// incomplete: adjudicated in part; the pairs left without a verdict are listed on the entry and stay unread.
export const ADJUDICATION_STATES = ["not_started", "in_progress", "adjudicated", "incomplete", "failed"] as const;
export type ScreenStatus = (typeof SCREEN_STATUSES)[number];
export type AdjudicationState = (typeof ADJUDICATION_STATES)[number];

const ItemRef = z.object({ key: z.string().min(1), sourceHash: z.string().min(1), session: z.string().min(1), witness: z.string() }).strict();
// Named signals only, numbers or flags: never a verdict, a band or a probability.
const FORBIDDEN_SIGNAL = /probab|confiden|likel|verdict|contradict|band/i;
const Signals = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/).refine((k) => !FORBIDDEN_SIGNAL.test(k), "signal names must not suggest a verdict or probability"), z.union([z.number().finite(), z.boolean()]));

export const ScreeningResultSchema = z
  .object({
    contract: z.literal(SCREENING_CONTRACT_VERSION),
    packetId: z.string().min(1),
    status: z.enum(SCREEN_STATUSES),
    rank: z.number().int().positive().nullable(), // queue position; null only when consolidated
    priority: z.number().finite(), // ordering key within this strategy only
    signals: Signals,
    reason: z.string().min(1),
    strategy: z.string().min(1),
    strategyVersion: z.string().min(1),
    sessions: z.array(z.string()).min(2),
    witnesses: z.array(z.string()).min(1),
    items: z.array(ItemRef).min(2),
    pairs: z.array(z.tuple([z.string(), z.string()])).min(1), // the original pool pairs this packet answers for
    consolidatedInto: z.string().nullable(),
    adjudication: z.enum(ADJUDICATION_STATES),
  })
  .strict()
  .superRefine((r, ctx) => {
    if ((r.status === "consolidated") !== (r.consolidatedInto !== null)) ctx.addIssue({ code: "custom", message: "consolidatedInto is set exactly when status is consolidated" });
    if ((r.status === "consolidated") !== (r.rank === null)) ctx.addIssue({ code: "custom", message: "rank is null exactly when status is consolidated" });
  });
export type ScreeningResult = z.infer<typeof ScreeningResultSchema>;

export const isPending = (r: Pick<ScreeningResult, "adjudication">) => r.adjudication !== "adjudicated";

export type Accounting = {
  poolPairs: number; // retrieved candidate pairs
  packetedPairs: number; // listed in exactly one packet
  uncoveredPairs: number; // in the packet set's `uncovered` list, with reasons
  packets: number;
  prioritized: number;
  deferred: number;
  consolidated: number;
  problems: string[]; // empty when every pair and packet is accounted for exactly once
};

// Every pool pair must end in exactly one packet or in `uncovered`, and every packet in exactly one result
// whose pairs and items match the packet: nothing screened away silently.
export function accountFor(pool: CandidatePool, set: PacketSet, results: readonly ScreeningResult[]): Accounting {
  const problems: string[] = [];
  const seen = new Map<string, number>();
  for (const p of set.packets) for (const [a, b] of p.pairs) seen.set(pairKey(a, b), (seen.get(pairKey(a, b)) ?? 0) + 1);
  for (const u of set.uncovered) seen.set(pairKey(u.a, u.b), (seen.get(pairKey(u.a, u.b)) ?? 0) + 1);
  for (const c of pool.candidates) {
    const n = seen.get(pairKey(c.a, c.b)) ?? 0;
    if (n !== 1) problems.push(`pool pair ${c.a} | ${c.b} accounted ${n} times`);
  }
  if (seen.size !== pool.candidates.length) problems.push(`${seen.size} pairs in packets and uncovered, ${pool.candidates.length} in the pool`);
  const byId = new Map(results.map((r) => [r.packetId, r]));
  if (byId.size !== results.length) problems.push("a packet has more than one screening result");
  for (const p of set.packets) {
    const r = byId.get(p.id);
    if (!r) { problems.push(`packet ${p.id} has no screening result`); continue; }
    const same = (x: readonly string[], y: readonly string[]) => x.length === y.length && [...x].sort().every((v, i) => v === [...y].sort()[i]);
    if (!same(r.items.map((i) => i.key), p.items)) problems.push(`packet ${p.id}: result items differ from the packet`);
    if (!same(r.pairs.map(([a, b]) => pairKey(a, b)), p.pairs.map(([a, b]) => pairKey(a, b)))) problems.push(`packet ${p.id}: result pairs differ from the packet`);
    if (r.consolidatedInto !== null && byId.get(r.consolidatedInto)?.status !== "prioritized" && byId.get(r.consolidatedInto)?.status !== "deferred") problems.push(`packet ${p.id}: consolidated into ${r.consolidatedInto}, which is not an open packet`);
  }
  if (results.length !== set.packets.length) problems.push(`${results.length} results for ${set.packets.length} packets`);
  const ranks = results.filter((r) => r.rank !== null).map((r) => r.rank!).sort((a, b) => a - b);
  if (ranks.some((r, i) => r !== i + 1)) problems.push("ranks are not 1..n without gaps");
  const count = (s: ScreenStatus) => results.filter((r) => r.status === s).length;
  return {
    poolPairs: pool.candidates.length,
    packetedPairs: set.packets.reduce((n, p) => n + p.pairs.length, 0),
    uncoveredPairs: set.uncovered.length,
    packets: set.packets.length,
    prioritized: count("prioritized"), deferred: count("deferred"), consolidated: count("consolidated"),
    problems,
  };
}

export const itemRef = (i: FrozenItem) => ({ key: i.key, sourceHash: i.sourceHash, session: i.session, witness: i.witness });
