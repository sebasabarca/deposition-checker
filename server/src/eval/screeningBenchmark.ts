// Offline screening benchmark (Milestone 3, experimental): what a screening order prioritizes and defers at
// several packet budgets, measured against the frozen labels, which screening itself never reads. Pure.
//
// A labelled pair is "reached" at budget k when some packet within the first k open ranks holds an item of
// each side (a consolidated packet counts at its target's rank). Unlabelled pairs are unknown, never
// counted as correct or incorrect. Cost is projected from the packets' serialized size and the Milestone 2
// calibration's measured output; it is an estimate, not a measurement of these packets.

import { PRICES } from "../costs/pricing";
import type { FrozenItem, FrozenPair } from "../retrieve/frozen";
import { INSTRUCTION_TOKENS, itemTokens } from "../retrieve/grouping";
import type { ScreeningResult } from "../screen/contract";
import { kindOf } from "./retrievalEval";

// Measured in the Milestone 2 calibration (data/raw/packet-pilot/calibration-run, 12 packet requests, 37
// listed pairs, Sonnet 5.5, 0 retries): 13,961 output tokens, so about 377 per listed pair; a cached prefix of
// 3,518 tokens (system prompt and schema). Small sample: the full pilot should replace these.
export const COST_ASSUMPTIONS = {
  model: "claude-sonnet-5-5",
  outputTokensPerPair: 377,
  cachedPrefixTokens: 3518,
  retryAllowance: 0.05, // assumed: the calibration had no retries
  source: "Milestone 2 calibration-run (12 packets, 37 pairs), measured November 4, 2026",
} as const;

export type BudgetRow = {
  budget: number; packets: number; listedPairs: number; distinctItems: number; itemReads: number; inputTokens: number;
  expectedUsd: number; noCacheUsd: number;
  targets: { reached: number; of: number }; controls: { reached: number; of: number };
  sessionPairs: Record<string, [prioritized: number, of: number]>; witnesses: Record<string, [prioritized: number, of: number]>;
  sessionsWithNone: string[];
};
export type LabelOutcome = { id: string; kind: string; category: string; firstRank: number | null; packets: number };
export type ScreeningReport = { strategy: string; strategyVersion: string; openPackets: number; consolidated: number; labels: LabelOutcome[]; budgets: BudgetRow[]; problems: string[] };

// Cost of reading a set of packets: passages at the input rate, one cached prefix written once and read
// after, output per listed pair, plus the retry allowance.
export function projectCost(packets: readonly { passageTokens: number; pairs: number }[], cache = true) {
  const r = PRICES[COST_ASSUMPTIONS.model][0].rates;
  const a = COST_ASSUMPTIONS;
  let usd = 0;
  packets.forEach((p, i) => {
    const prefix = cache ? a.cachedPrefixTokens * (i === 0 ? r.cacheWrite5m : r.cacheRead) : a.cachedPrefixTokens * r.input;
    usd += (prefix + p.passageTokens * r.input + p.pairs * a.outputTokensPerPair * r.output) / 1e6;
  });
  return usd * (1 + a.retryAllowance);
}

export function evaluateScreening(results: readonly ScreeningResult[], labels: readonly FrozenPair[], items: ReadonlyMap<string, FrozenItem>, budgets: readonly number[]): ScreeningReport {
  const problems: string[] = [];
  for (const r of results) for (const i of r.items) {
    const it = items.get(i.key);
    if (!it) problems.push(`${r.packetId}: item ${i.key} not in the corpus`);
    else if (it.sourceHash !== i.sourceHash || it.session !== i.session) problems.push(`${r.packetId}: item ${i.key} provenance differs from the corpus`);
  }
  for (const r of results) { const own = new Set(r.items.map((i) => i.key)); if (r.pairs.some(([a, b]) => !own.has(a) || !own.has(b))) problems.push(`${r.packetId}: lists a pair outside its items`); }

  const open = results.filter((r) => r.rank !== null).sort((x, y) => x.rank! - y.rank!);
  const membersOf = new Map<string, ScreeningResult[]>();
  for (const r of results) if (r.consolidatedInto) (membersOf.get(r.consolidatedInto) ?? membersOf.set(r.consolidatedInto, []).get(r.consolidatedInto)!).push(r);

  // A packet is read together with the packets folded into it, so a label is reached when that union holds both sides.
  const readTogether = open.map((r) => ({ rank: r.rank!, keys: new Set([r, ...(membersOf.get(r.packetId) ?? [])].flatMap((x) => x.items.map((i) => i.key))) }));
  const outcomes: LabelOutcome[] = labels.map((l) => {
    const holding = readTogether.filter((g) => l.left.some((k) => g.keys.has(k)) && l.right.some((k) => g.keys.has(k)));
    return { id: l.id, kind: kindOf(l.category), category: l.category, firstRank: holding.length ? Math.min(...holding.map((g) => g.rank)) : null, packets: holding.length };
  });

  const bucket = (r: ScreeningResult) => r.sessions.join(" + ");
  const allSessions = [...new Set(results.flatMap((r) => r.sessions))].sort();
  const rows = budgets.map((k) => {
    const chosen = open.slice(0, k);
    const groups = chosen.map((r) => [r, ...(membersOf.get(r.packetId) ?? [])]);
    const tally = (f: (r: ScreeningResult) => string[]) => {
      const t: Record<string, [number, number]> = {};
      for (const r of open) for (const x of f(r)) (t[x] ??= [0, 0])[1]++;
      for (const r of chosen) for (const x of f(r)) t[x][0]++;
      return t;
    };
    const reads = groups.map((g) => [...new Set(g.flatMap((r) => r.items.map((i) => i.key)))]);
    const costInput = groups.map((g, n) => ({ passageTokens: reads[n].reduce((t, key) => t + itemTokens(items.get(key)!), 0), pairs: g.reduce((s, r) => s + r.pairs.length, 0) }));
    const reached = (kind: string) => ({ reached: outcomes.filter((o) => o.kind === kind && o.firstRank !== null && o.firstRank <= k).length, of: outcomes.filter((o) => o.kind === kind).length });
    const covered = new Set(chosen.flatMap((r) => r.sessions));
    return {
      budget: k, packets: chosen.length, listedPairs: costInput.reduce((s, p) => s + p.pairs, 0),
      distinctItems: new Set(reads.flat()).size, itemReads: reads.reduce((s, r) => s + r.length, 0),
      inputTokens: costInput.reduce((s, p) => s + p.passageTokens + INSTRUCTION_TOKENS, 0),
      expectedUsd: Math.round(projectCost(costInput) * 100) / 100, noCacheUsd: Math.round(projectCost(costInput, false) * 100) / 100,
      targets: reached("target"), controls: reached("control"),
      sessionPairs: tally((r) => [bucket(r)]), witnesses: tally((r) => r.witnesses),
      sessionsWithNone: allSessions.filter((s) => !covered.has(s)),
    } satisfies BudgetRow;
  });
  return { strategy: results[0]?.strategy ?? "", strategyVersion: results[0]?.strategyVersion ?? "", openPackets: open.length, consolidated: results.length - open.length, labels: outcomes, budgets: rows, problems };
}
