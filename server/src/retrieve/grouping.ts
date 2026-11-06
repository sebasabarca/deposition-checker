// Issue-centered evidence grouping (experimental, retrieval round 2): turns a candidate pool's pairs into
// bounded evidence packets, so one model call can read several related passages instead of one call per
// pair. Pure: no I/O, no model. Every rule is general; nothing here reads labels.
//
// 1. Issue clusters. Items are joined along pool pairs, strongest first, when the pair shares at least
//    `minShared` rare features (names, dates, years, weekdays and content words that few items use), so one
//    common person or place never joins two statements on its own. A merge must keep the packet within
//    `maxItems` and `maxTokens`, and (with `coreShare`) leave one rare feature that most of its items share,
//    which stops chains A–B–C where A and C have nothing in common.
// 2. Residual stars. Every pool pair whose items ended in different clusters is covered by a small packet
//    around its busiest item: that item and the partners the pool retrieved for it, within the same bounds,
//    and (with `starOneSession`) from one other session only: a session belongs to one matter, while a
//    hub's partners from several sessions can come from unrelated matters.
// 3. Whatever still fits nowhere is listed in `uncovered` with the reason, never dropped.
//
// A packet's `issue` names the shared features only: a possible common issue, never a claim that the
// statements describe one event.

import type { CandidatePool, FrozenItem } from "./frozen";
import { anchors, nameVocabulary, tokens } from "./independent";

export type EvidencePacket = { id: string; issue: string; items: string[]; pairs: [string, string][]; inputTokens: number };
export type PacketSet = {
  name: string;
  source: string;
  settings: Record<string, unknown>;
  packets: EvidencePacket[];
  uncovered: { a: string; b: string; reason: string }[];
  tokenAssumption: string;
};

export type GroupingSettings = {
  maxItems: number; // items per packet
  maxTokens: number; // projected input tokens per packet, instructions included
  minShared: number; // rare features a pair must share to join clusters (0: any pool pair joins)
  coreShare: number; // a merged cluster keeps one rare feature held by at least this share of its items (0: off)
  commonShare: number; // a feature in more than this share of items (and more than COMMON_FLOOR) is common
  residual: "star" | "none"; // how pairs between clusters are covered
  starOneSession: boolean; // a residual star holds its hub and partners from one other session only
};

export const DEFAULT_GROUPING: GroupingSettings = { maxItems: 8, maxTokens: 6000, minShared: 2, coreShare: 0.5, commonShare: 0.02, residual: "star", starOneSession: true };

// Planning assumptions, the repo's ~3 characters per token. The overhead is the adjudication instructions
// (adjudicate-v3's system prompt is 7,603 characters, ~2,534 tokens) plus schema and framing, sent with every
// call whether it holds one pair or a packet; no prompt caching assumed.
export const CHARS_PER_TOKEN = 3;
export const INSTRUCTION_TOKENS = 2800;
export const ITEM_HEADER_TOKENS = 30; // witness, session, page:line references per passage
export const COMMON_FLOOR = 10;
export const TOKEN_ASSUMPTION = `ceil((question + answer + context characters) / ${CHARS_PER_TOKEN}) + ${ITEM_HEADER_TOKENS} header tokens per passage, plus ${INSTRUCTION_TOKENS} instruction tokens per call (adjudicate-v3 system prompt ~2,534 tokens + schema and framing); no caching; output tokens not counted`;

export const itemTokens = (item: Pick<FrozenItem, "question" | "answer" | "context">) =>
  Math.ceil((item.question.length + item.answer.length + item.context.length) / CHARS_PER_TOKEN) + ITEM_HEADER_TOKENS;

// Pair-by-pair adjudication of the same pool, for comparison: one call per pair.
export function pairwiseWorkload(pool: CandidatePool, items: readonly FrozenItem[]) {
  const tok = new Map(items.map((i) => [i.key, itemTokens(i)]));
  let tokens = 0;
  for (const c of pool.candidates) tokens += INSTRUCTION_TOKENS + (tok.get(c.a) ?? 0) + (tok.get(c.b) ?? 0);
  return { calls: pool.candidates.length, tokens };
}

const label = (f: string) => f.replace(/^(?:term|name|date|day|year):/, "");

// Each item's rare features: anchors (from independent.ts) and content words, keeping those used by at
// least two items and at most the common threshold.
export function rareFeatures(items: readonly FrozenItem[], commonShare: number): Map<string, string[]> {
  const names = nameVocabulary(items.map((i) => `${i.question} ${i.answer}`));
  const raw = items.map((i) => {
    const text = `${i.question} ${i.answer}`;
    const own = anchors(text, names);
    const anchored = new Set(own.flatMap((f) => label(f).split(" ")));
    // A name or date is also a content word ("Oduya", "January"): count it once, as the anchor.
    return [...new Set([...own, ...tokens(text).filter((t) => !anchored.has(t)).map((t) => `term:${t}`)])];
  });
  const df = new Map<string, number>();
  for (const f of raw) for (const x of f) df.set(x, (df.get(x) ?? 0) + 1);
  const common = Math.max(COMMON_FLOOR, commonShare * items.length);
  return new Map(items.map((i, d) => [i.key, raw[d].filter((x) => df.get(x)! >= 2 && df.get(x)! <= common)]));
}

export function groupPool(pool: CandidatePool, items: readonly FrozenItem[], name: string, source: string, settings: Partial<GroupingSettings> = {}): PacketSet {
  const s = { ...DEFAULT_GROUPING, ...settings };
  if (!(s.maxItems >= 2) || !(s.maxTokens > INSTRUCTION_TOKENS)) throw new Error(`a packet needs room for two items and the ${INSTRUCTION_TOKENS} instruction tokens`);
  const byKey = new Map(items.map((i) => [i.key, i]));
  const tok = new Map(items.map((i) => [i.key, itemTokens(i)]));
  const features = rareFeatures(items, s.commonShare);
  const uncovered: PacketSet["uncovered"] = [];
  const fits = (n: number, t: number) => n <= s.maxItems && INSTRUCTION_TOKENS + t <= s.maxTokens;

  // Pairs that cannot be in any packet.
  const pairs: { a: string; b: string; shared: string[] }[] = [];
  for (const c of pool.candidates) {
    const a = byKey.get(c.a), b = byKey.get(c.b);
    if (!a || !b) { uncovered.push({ a: c.a, b: c.b, reason: "item missing from the corpus" }); continue; }
    if (a.session === b.session) { uncovered.push({ a: c.a, b: c.b, reason: "same session" }); continue; }
    if (!fits(2, tok.get(c.a)! + tok.get(c.b)!)) { uncovered.push({ a: c.a, b: c.b, reason: `the two passages alone exceed ${s.maxTokens} tokens` }); continue; }
    const fb = new Set(features.get(c.b));
    pairs.push({ a: c.a, b: c.b, shared: features.get(c.a)!.filter((x) => fb.has(x)) });
  }

  // 1. Issue clusters: union-find over strong pairs, strongest first (pool order breaks ties).
  type Cluster = { keys: string[]; tokens: number; counts: Map<string, number> };
  const clusterOf = new Map<string, Cluster>();
  const get = (k: string) => clusterOf.get(k) ?? (clusterOf.set(k, { keys: [k], tokens: tok.get(k)!, counts: new Map(features.get(k)!.map((x) => [x, 1])) }), clusterOf.get(k)!);
  const strong = pairs.map((p, i) => ({ p, i })).filter(({ p }) => p.shared.length >= s.minShared).sort((x, y) => y.p.shared.length - x.p.shared.length || x.i - y.i);
  for (const { p } of strong) {
    const x = get(p.a), y = get(p.b);
    if (x === y || !fits(x.keys.length + y.keys.length, x.tokens + y.tokens)) continue;
    const counts = new Map(x.counts);
    for (const [f, n] of y.counts) counts.set(f, (counts.get(f) ?? 0) + n);
    const size = x.keys.length + y.keys.length;
    // The core feature must come from both sides, so a merge never hangs one cluster on another by a side word.
    const core = Math.max(2, Math.ceil(s.coreShare * size));
    if (s.coreShare > 0 && size > 2 && ![...x.counts].some(([f, n]) => y.counts.has(f) && n + y.counts.get(f)! >= core)) continue;
    const merged: Cluster = { keys: [...x.keys, ...y.keys], tokens: x.tokens + y.tokens, counts };
    for (const k of merged.keys) clusterOf.set(k, merged);
  }

  const packets: EvidencePacket[] = [];
  const covered = new Set<number>();
  const pairsOf = new Map<string, number[]>();
  pairs.forEach((p, i) => { for (const k of [p.a, p.b]) (pairsOf.get(k) ?? pairsOf.set(k, []).get(k)!).push(i); });
  const emit = (keys: string[], kind: "issue" | "star") => {
    const set = new Set(keys);
    const inside = [...new Set(keys.flatMap((k) => pairsOf.get(k) ?? []))].filter((i) => !covered.has(i) && set.has(pairs[i].a) && set.has(pairs[i].b)).sort((x, y) => x - y);
    if (!inside.length) return;
    for (const i of inside) covered.add(i);
    const counts = new Map<string, number>();
    for (const k of keys) for (const f of features.get(k)!) counts.set(f, (counts.get(f) ?? 0) + 1);
    const top = [...counts].filter(([, n]) => n >= 2).sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1)).map(([f]) => label(f)).filter((f, i, all) => all.indexOf(f) === i).slice(0, 8);
    if (new Set(keys.map((k) => byKey.get(k)!.session)).size < 2) throw new Error("packet with one session");
    packets.push({
      id: `${kind}-${packets.length + 1}`,
      issue: `Possible common issue (${kind === "issue" ? "shared rare terms" : "passages retrieved for one statement"}): ${top.length ? top.join(", ") : "no shared rare term"}`,
      items: [...keys].sort(),
      pairs: inside.map((i) => [pairs[i].a, pairs[i].b]),
      inputTokens: INSTRUCTION_TOKENS + keys.reduce((t, k) => t + tok.get(k)!, 0),
    });
  };
  const clusters = [...new Set(clusterOf.values())].filter((c) => c.keys.length > 1).sort((x, y) => (x.keys[0] < y.keys[0] ? -1 : 1));
  for (const c of clusters) emit(c.keys, "issue");

  // 2. Residual stars around the item with the most uncovered pairs; partners in pool order (best first).
  if (s.residual === "star") {
    const adj = new Map<string, Map<string, number>>();
    const link = (u: string, v: string, i: number) => (adj.get(u) ?? adj.set(u, new Map()).get(u)!).set(v, i);
    pairs.forEach((p, i) => { if (!covered.has(i)) { link(p.a, p.b, i); link(p.b, p.a, i); } });
    // The hub (most uncovered pairs, then the smallest key) comes from a max-heap of [size, key] entries; a node's size
    // only shrinks and every change pushes a new entry, so an entry whose size is stale is skipped.
    const heap: [number, string][] = [];
    const above = (x: [number, string], y: [number, string]) => x[0] > y[0] || (x[0] === y[0] && x[1] < y[1]);
    const push = (e: [number, string]) => { heap.push(e); for (let i = heap.length - 1; i > 0;) { const p = (i - 1) >> 1; if (!above(heap[i], heap[p])) break; [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; } };
    const pop = () => {
      const top = heap[0], last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        for (let i = 0; ;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && above(heap[l], heap[m])) m = l; if (r < heap.length && above(heap[r], heap[m])) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; }
      }
      return top;
    };
    for (const [k, n] of adj) push([n.size, k]);
    for (;;) {
      let hub: string | undefined;
      while (heap.length) { const [size, k] = pop(); if (size > 0 && adj.get(k)!.size === size) { hub = k; break; } }
      if (!hub) break;
      const keys = [hub];
      let t = tok.get(hub)!;
      const partners = [...adj.get(hub)!].sort((x, y) => x[1] - y[1]).map(([v]) => v);
      const session = byKey.get(partners[0])!.session;
      for (const v of partners) if ((!s.starOneSession || byKey.get(v)!.session === session) && fits(keys.length + 1, t + tok.get(v)!)) { keys.push(v); t += tok.get(v)!; }
      if (keys.length < 2) throw new Error("a residual pair that fits alone found no room"); // fits(2, …) was checked above
      emit(keys, "star");
      for (const u of keys) for (const v of keys) adj.get(u)?.delete(v);
      for (const u of keys) { const n = adj.get(u); if (n?.size) push([n.size, u]); }
    }
  }
  pairs.forEach((p, i) => { if (!covered.has(i)) uncovered.push({ a: p.a, b: p.b, reason: s.residual === "none" ? "items in different issue clusters (residual packing off)" : "not covered" }); });

  return { name, source, settings: s, packets, uncovered, tokenAssumption: TOKEN_ASSUMPTION };
}

// Workload of a packet set: packets, items and tokens per packet, totals.
export function workload(set: PacketSet) {
  const n = set.packets.length;
  const sizes = set.packets.map((p) => p.items.length);
  const toks = set.packets.map((p) => p.inputTokens);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return {
    packets: n, calls: n, tokens: sum(toks),
    avgItems: n ? sum(sizes) / n : 0, maxItems: Math.max(0, ...sizes),
    avgTokens: n ? sum(toks) / n : 0, maxTokens: Math.max(0, ...toks),
    pairsCovered: sum(set.packets.map((p) => p.pairs.length)), uncovered: set.uncovered.length,
  };
}

// Whether some packet holds an item of each side of a labelled pair (evaluation only).
export const coPacketed = (set: PacketSet, left: readonly string[], right: readonly string[]) =>
  set.packets.some((p) => p.items.some((k) => left.includes(k)) && p.items.some((k) => right.includes(k)));
