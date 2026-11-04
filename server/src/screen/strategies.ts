// Screening strategies (Milestone 3, experimental): order a packet set's issue packets for strong-model
// adjudication with cheap local signals, and mark the first `budget` prioritized and the rest deferred.
// Pure: no I/O, clock or randomness. Nothing here reads labels. Every weight was fixed before any
// benchmark run and must not be tuned against the four known real targets.
//
//   baseline       grouping's own packet order (the unscreened reference)
//   fused          the packet's best fused retrieval score (retrieval alone)
//   minilm         the packet's best local MiniLM rank, either direction (semantic similarity alone)
//   deterministic  per pair: retrieval-path agreement, mutual retrieval, shared rare features, and the
//                  numeric/polarity disagreement score of retrieve/factual.ts; a packet takes its best pair
//   coverage       deterministic, then round-robin over session pairs (no session pair waits for another's
//                  whole queue) and, within one, preferring packets whose passages no earlier packet holds
//
// `consolidate` then folds a later packet into an earlier open one of the same sessions when they share at
// least half the smaller packet's passages and the union still fits the packet bounds: the same testimony,
// not just the same people. The folded packet keeps every original pair, listed under its own id.

import type { Candidate, CandidatePool, FrozenItem } from "../retrieve/frozen";
import { pairKey } from "../retrieve/frozen";
import { indexItems, pairScore } from "../retrieve/factual";
import { DEFAULT_GROUPING, INSTRUCTION_TOKENS, itemTokens, rareFeatures, type EvidencePacket, type PacketSet } from "../retrieve/grouping";
import { itemRef, SCREENING_CONTRACT_VERSION, type ScreeningResult } from "./contract";

export const STRATEGIES = ["baseline", "fused", "minilm", "deterministic", "coverage"] as const;
export type Strategy = (typeof STRATEGIES)[number];
export const STRATEGY_VERSION = "screen-v1";
export const MINILM_PATH = "E_minilm_qac_s";
// deterministic-v1 weights, fixed a priori: each signal is scaled to 0..1 and counts once.
export const WEIGHTS = { paths: 1, mutual: 0.5, shared: 1, factual: 1 } as const;
export const SHARED_CAP = 4; // rare features shared by a pair, beyond which more adds nothing

export type ScreenOptions = { strategy: Strategy; budget: number; consolidate: boolean; maxItems?: number; maxTokens?: number };
export type PairSignals = { paths: number; mutualPaths: number; bestRank: number; minilmRank: number; fused: number; sharedRare: number; factual: number; crossWitness: boolean; score: number };

// Per pair signals for every pool pair a packet lists. `pathCount` is the number of distinct retrieval paths.
export function pairSignals(pool: CandidatePool, items: readonly FrozenItem[], pairs: readonly (readonly [string, string])[]): Map<string, PairSignals> {
  const byKey = new Map(items.map((i, n) => [i.key, n]));
  const cand = new Map<string, Candidate>(pool.candidates.map((c) => [pairKey(c.a, c.b), c]));
  const paths = [...new Set(pool.paths)];
  const features = rareFeatures(items, DEFAULT_GROUPING.commonShare);
  const factual = indexItems(items);
  const out = new Map<string, PairSignals>();
  for (const [a, b] of pairs) {
    const key = pairKey(a, b);
    const c = cand.get(key);
    if (!c) throw new Error(`packet pair ${key} is not in the pool`);
    const ranks = paths.map((p) => c.ranks[p] ?? [null, null]);
    const found = ranks.filter(([x, y]) => x !== null || y !== null).length;
    const mutual = ranks.filter(([x, y]) => x !== null && y !== null).length;
    const flat = ranks.flat().filter((r): r is number => r !== null);
    const mini = (c.ranks[MINILM_PATH] ?? [null, null]).filter((r): r is number => r !== null);
    const fb = new Set(features.get(b) ?? []);
    const shared = (features.get(a) ?? []).filter((f) => fb.has(f)).length;
    const ia = byKey.get(a)!, ib = byKey.get(b)!;
    const fact = Math.max(pairScore(factual, ia, ib), pairScore(factual, ib, ia));
    const score = WEIGHTS.paths * (found / paths.length) + WEIGHTS.mutual * (mutual / paths.length) + WEIGHTS.shared * (Math.min(shared, SHARED_CAP) / SHARED_CAP) + WEIGHTS.factual * Math.min(fact, 1);
    out.set(key, {
      paths: found, mutualPaths: mutual, bestRank: flat.length ? Math.min(...flat) : Infinity, minilmRank: mini.length ? Math.min(...mini) : Infinity,
      fused: c.fused, sharedRare: shared, factual: Math.round(fact * 1e6) / 1e6, crossWitness: items[ia].witness !== items[ib].witness, score: Math.round(score * 1e6) / 1e6,
    });
  }
  return out;
}

const best = <T>(xs: readonly T[], f: (x: T) => number) => xs.reduce((m, x) => Math.max(m, f(x)), -Infinity);
const sessionsOf = (p: EvidencePacket, byKey: Map<string, FrozenItem>) => [...new Set(p.items.map((k) => byKey.get(k)!.session))].sort();

// Packet priority under a strategy (higher first) and the signals recorded for it.
function packetPriority(strategy: Strategy, p: EvidencePacket, index: number, sig: Map<string, PairSignals>) {
  const s = p.pairs.map(([a, b]) => sig.get(pairKey(a, b))!);
  const top = s.reduce((m, x) => (x.score > m.score ? x : m));
  const signals = {
    pairs: p.pairs.length, items: p.items.length, inputTokens: p.inputTokens,
    bestPairScore: top.score, bestPaths: best(s, (x) => x.paths), bestMutualPaths: best(s, (x) => x.mutualPaths),
    bestSharedRare: best(s, (x) => x.sharedRare), bestFactual: best(s, (x) => x.factual), bestFused: Math.round(best(s, (x) => x.fused) * 1e6) / 1e6,
    bestMinilmRank: Math.min(...s.map((x) => x.minilmRank)) === Infinity ? 0 : Math.min(...s.map((x) => x.minilmRank)), // 0: no MiniLM rank
    crossWitnessPairs: s.filter((x) => x.crossWitness).length, groupingOrder: index + 1,
  };
  const priority =
    strategy === "baseline" ? -index
    : strategy === "fused" ? signals.bestFused
    : strategy === "minilm" ? (signals.bestMinilmRank ? 1 / signals.bestMinilmRank : 0)
    : top.score;
  return { priority, signals };
}

// Round-robin over session pairs; within one, priority times the share of passages no earlier packet holds.
export function coverageOrder(entries: readonly { id: string; items: readonly string[]; bucket: string; priority: number }[]): string[] {
  const buckets = new Map<string, typeof entries[number][]>();
  for (const e of entries) (buckets.get(e.bucket) ?? buckets.set(e.bucket, []).get(e.bucket)!).push(e);
  const seen = new Set<string>();
  const out: string[] = [];
  const eff = (e: typeof entries[number]) => e.priority * (e.items.filter((k) => !seen.has(k)).length / e.items.length);
  const pick = (list: typeof entries[number][]) => {
    let bi = 0;
    for (let i = 1; i < list.length; i++) { const d = eff(list[i]) - eff(list[bi]); if (d > 0 || (d === 0 && list[i].id < list[bi].id)) bi = i; }
    return bi;
  };
  while (out.length < entries.length) {
    const open = [...buckets].filter(([, l]) => l.length).sort((x, y) => eff(y[1][pick(y[1])]) - eff(x[1][pick(x[1])]) || (x[0] < y[0] ? -1 : 1));
    for (const [, list] of open) {
      const [e] = list.splice(pick(list), 1);
      out.push(e.id);
      for (const k of e.items) seen.add(k);
    }
  }
  return out;
}

export function screen(set: PacketSet, pool: CandidatePool, items: readonly FrozenItem[], options: ScreenOptions): ScreeningResult[] {
  const { strategy, budget, consolidate } = options;
  if (!Number.isInteger(budget) || budget < 0) throw new Error("budget must be a whole number of packets");
  const maxItems = options.maxItems ?? DEFAULT_GROUPING.maxItems, maxTokens = options.maxTokens ?? DEFAULT_GROUPING.maxTokens;
  const byKey = new Map(items.map((i) => [i.key, i]));
  for (const p of set.packets) for (const k of p.items) if (!byKey.has(k)) throw new Error(`packet ${p.id}: item ${k} is not in the corpus`);
  const sig = pairSignals(pool, items, set.packets.flatMap((p) => p.pairs));
  const scored = set.packets.map((p, i) => ({ p, ...packetPriority(strategy, p, i, sig), bucket: sessionsOf(p, byKey).join(" + ") }));
  const byId = new Map(scored.map((s) => [s.p.id, s]));

  let order: string[];
  if (strategy === "coverage") order = coverageOrder(scored.map((s) => ({ id: s.p.id, items: s.p.items, bucket: s.bucket, priority: s.priority })));
  else order = [...scored].sort((x, y) => y.priority - x.priority || y.p.pairs.length - x.p.pairs.length || (x.p.id < y.p.id ? -1 : 1)).map((s) => s.p.id);

  // Consolidation, in queue order: a later packet joins the earliest open packet it overlaps enough.
  const into = new Map<string, string>();
  if (consolidate) {
    const union = new Map<string, Set<string>>();
    const holders = new Map<string, string[]>(); // item → open packets holding it, queue order
    for (const id of order) {
      const s = byId.get(id)!;
      let target: string | undefined;
      for (const h of [...new Set(s.p.items.flatMap((k) => holders.get(k) ?? []))]) {
        const hs = byId.get(h)!, u = union.get(h)!;
        if (hs.bucket !== s.bucket) continue;
        const overlap = s.p.items.filter((k) => hs.p.items.includes(k)).length;
        const merged = new Set([...u, ...s.p.items]);
        const tokens = INSTRUCTION_TOKENS + [...merged].reduce((t, k) => t + itemTokens(byKey.get(k)!), 0);
        if (overlap * 2 >= Math.min(hs.p.items.length, s.p.items.length) && merged.size <= maxItems && tokens <= maxTokens) { target = h; union.set(h, merged); break; }
      }
      if (target) { into.set(id, target); continue; }
      union.set(id, new Set(s.p.items));
      for (const k of s.p.items) (holders.get(k) ?? holders.set(k, []).get(k)!).push(id);
    }
  }

  const open = order.filter((id) => !into.has(id));
  const rankOf = new Map(open.map((id, i) => [id, i + 1]));
  const members = new Map<string, number>();
  for (const t of into.values()) members.set(t, (members.get(t) ?? 0) + 1);
  return order.map((id) => {
    const s = byId.get(id)!;
    const rank = rankOf.get(id) ?? null;
    const target = into.get(id) ?? null;
    const status = target ? "consolidated" : rank! <= budget ? "prioritized" : "deferred";
    const why = `bestPairScore ${s.signals.bestPairScore}, paths ${s.signals.bestPaths}, shared rare ${s.signals.bestSharedRare}, factual ${s.signals.bestFactual}`;
    const reason =
      status === "consolidated" ? `consolidated into ${target}: same sessions, shares at least half its passages, union fits the packet bounds; its pairs are read when that packet is adjudicated, and stay pending until then`
      : status === "prioritized" ? `rank ${rank} of ${open.length} by ${strategy}, within the budget of ${budget} packets (${why})`
      : `deferred unread: rank ${rank} of ${open.length} by ${strategy}, beyond the budget of ${budget} packets (${why}); not assessed, not a finding of no contradiction`;
    return {
      contract: SCREENING_CONTRACT_VERSION, packetId: id, status, rank, priority: Math.round(s.priority * 1e9) / 1e9,
      signals: { ...s.signals, consolidatedMembers: members.get(id) ?? 0 },
      reason, strategy, strategyVersion: `${STRATEGY_VERSION}${consolidate ? "+consolidate" : ""}`,
      sessions: sessionsOf(s.p, byKey), witnesses: [...new Set(s.p.items.map((k) => byKey.get(k)!.witness))].sort(),
      items: [...s.p.items].sort().map((k) => itemRef(byKey.get(k)!)), pairs: s.p.pairs.map(([a, b]) => [a, b] as [string, string]),
      consolidatedInto: target, adjudication: "not_started",
    } satisfies ScreeningResult;
  });
}
