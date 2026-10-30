// Path A: candidate pairs from structured claims (DESIGN.md, "Candidate retrieval"). It pairs
// claims of the same witness in different sessions that are about the same kind of fact (the same
// canonical predicate, other than `other`) and the same thing (a shared grounded entity, or objects
// that share meaningful words), and that show a retrieval signal. Matching meaning slots instead of
// words is what lets Path A find paraphrases that Path B misses.
//
// The signals say only that a pair is worth adjudicating, never that it contradicts: Sonnet judges
// meaning and context later. In rank order:
//   opposite_polarity    one side affirms, the other denies, both asserted or qualified
//   different_value      same polarity, but a different time, place or quantity, or (when linked by
//                        an entity) objects with no meaningful word in common
//   recollection_change  asserted or qualified on one side, "don't recall" on the other
//   knowledge_change     asserted or qualified on one side, "don't know" on the other
// Only verified and approximate claims count; hypothetical, reported-by-others and context-dependent
// claims never enter retrieval.

import { sql } from "drizzle-orm";
import { contentWords } from "../claims/verify";
import type { Database } from "../db/client";
import type { LogicalExchange } from "./rank";

export const SIGNALS = ["opposite_polarity", "different_value", "recollection_change", "knowledge_change"] as const;
export type Signal = (typeof SIGNALS)[number];

// Objects overlap when they share at least one meaningful word and the shared words are at least this
// share of the smaller object's words: "software package" and "software" overlap; "the 10% discount"
// and "the board" don't. A retrieval link only, never a finding that the two are the same thing.
export const OBJECT_OVERLAP = 0.5;

export type SignalClaim = {
  polarity: string;
  epistemic: string;
  object: string | null;
  time: string | null;
  place: string | null;
  quantity: string | null;
  entities: readonly string[];
};

const sharedWords = (a: string, b: string) => {
  const y = new Set(contentWords(b));
  return [...new Set(contentWords(a))].filter((w) => y.has(w));
};

export function objectsOverlap(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const smaller = Math.min(new Set(contentWords(a)).size, new Set(contentWords(b)).size);
  const shared = sharedWords(a, b).length;
  return shared > 0 && shared / smaller >= OBJECT_OVERLAP;
}

// Two stated objects with meaningful words and none in common.
const objectsDisjoint = (a: string | null, b: string | null) =>
  !!a && !!b && contentWords(a).length > 0 && contentWords(b).length > 0 && sharedWords(a, b).length === 0;

const stated = (e: string) => e === "asserted" || e === "qualified";
const differs = (a: string | null, b: string | null) => a !== null && b !== null && a.trim().toLowerCase() !== b.trim().toLowerCase();

// Whether two claims (same predicate, different sessions) are linked, and by which signal. Pure.
export function claimSignal(c1: SignalClaim, c2: SignalClaim): { signal: Signal; sharedEntities: string[] } | null {
  const sharedEntities = c1.entities.filter((e) => c2.entities.includes(e)).sort();
  if (sharedEntities.length === 0 && !objectsOverlap(c1.object, c2.object)) return null;

  let signal: Signal | null = null;
  if (stated(c1.epistemic) && stated(c2.epistemic)) {
    if (c1.polarity !== c2.polarity) signal = "opposite_polarity";
    else if (
      differs(c1.time, c2.time) ||
      differs(c1.place, c2.place) ||
      differs(c1.quantity, c2.quantity) ||
      (sharedEntities.length > 0 && objectsDisjoint(c1.object, c2.object))
    ) {
      signal = "different_value";
    }
  } else if (stated(c1.epistemic) || stated(c2.epistemic)) {
    const other = stated(c1.epistemic) ? c2.epistemic : c1.epistemic;
    if (other === "does_not_recall") signal = "recollection_change";
    if (other === "does_not_know") signal = "knowledge_change";
  }
  return signal ? { signal, sharedEntities } : null;
}

export type ClaimPair = {
  rank: number; // 1 = strongest signal
  signal: Signal;
  a: LogicalExchange; // sorts first by (deposition, group)
  b: LogicalExchange;
  exchangeA: number; // the parts the representative claims came from: exact source references
  exchangeB: number;
  claimA: number;
  claimB: number;
  predicate: string;
  sharedEntities: string[];
  claimPairs: number; // how many claim pairs link these two logical exchanges
};

type Row = SignalClaim & { id: string; exchange_id: string; deposition_id: string; group_id: number; predicate: string };

const tier = (s: Signal) => SIGNALS.indexOf(s);

export async function findPathA(
  db: Database,
  { witnessId, depositionId, extractorVersion }: { witnessId: number; depositionId: number; extractorVersion: string },
): Promise<ClaimPair[]> {
  // Every usable claim of the witness's ready depositions; pairing happens in code (claimSignal).
  const result = await db.execute<Row>(sql`
    select cl.id, cl.exchange_id, cl.deposition_id, e.group_id, cl.predicate::text as predicate, cl.polarity::text as polarity,
      cl.epistemic::text as epistemic, cl.object, cl.time, cl.place, cl.quantity, cl.entities
    from claims cl
    join exchanges e on e.id = cl.exchange_id
    join depositions d on d.id = cl.deposition_id
    where cl.witness_id = ${witnessId} and cl.extractor_version = ${extractorVersion} and d.status = 'ready'
      and cl.status in ('verified', 'approximate') and not cl.context_dependent
      and cl.epistemic not in ('hypothetical', 'reported_by_other') and cl.predicate <> 'other'
  `);
  const mine = result.rows.filter((r) => Number(r.deposition_id) === depositionId);
  const others = result.rows.filter((r) => Number(r.deposition_id) !== depositionId);

  type Best = Omit<ClaimPair, "rank">;
  const best = new Map<string, Best>();
  for (const c1 of mine) {
    for (const c2 of others) {
      if (c2.predicate !== c1.predicate) continue;
      const link = claimSignal(c1, c2);
      if (!link) continue;
      const one = { side: { depositionId: Number(c1.deposition_id), groupId: c1.group_id }, part: Number(c1.exchange_id), claim: Number(c1.id) };
      const two = { side: { depositionId: Number(c2.deposition_id), groupId: c2.group_id }, part: Number(c2.exchange_id), claim: Number(c2.id) };
      const [x, y] = (one.side.depositionId - two.side.depositionId || one.side.groupId - two.side.groupId) < 0 ? [one, two] : [two, one];
      const key = `${x.side.depositionId}:${x.side.groupId}|${y.side.depositionId}:${y.side.groupId}`;
      const candidate: Best = {
        signal: link.signal,
        a: x.side,
        b: y.side,
        exchangeA: x.part,
        exchangeB: y.part,
        claimA: x.claim,
        claimB: y.claim,
        predicate: c1.predicate,
        sharedEntities: link.sharedEntities,
        claimPairs: 1,
      };
      const seen = best.get(key);
      if (!seen) {
        best.set(key, candidate);
        continue;
      }
      // The strongest signal, then the most shared entities, then the lowest claim IDs.
      const better =
        tier(candidate.signal) - tier(seen.signal) ||
        seen.sharedEntities.length - candidate.sharedEntities.length ||
        candidate.claimA - seen.claimA ||
        candidate.claimB - seen.claimB;
      best.set(key, { ...(better < 0 ? candidate : seen), claimPairs: seen.claimPairs + 1 });
    }
  }

  return [...best.values()]
    .sort(
      (p, q) =>
        tier(p.signal) - tier(q.signal) ||
        q.sharedEntities.length - p.sharedEntities.length ||
        p.a.depositionId - q.a.depositionId ||
        p.a.groupId - q.a.groupId ||
        p.b.depositionId - q.b.depositionId ||
        p.b.groupId - q.b.groupId,
    )
    .map((p, i) => ({ rank: i + 1, ...p }));
}
