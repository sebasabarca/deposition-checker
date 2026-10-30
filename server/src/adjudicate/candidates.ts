// Persists merged candidate pairs (retrieve/merge.ts) into a named candidate set, with their source
// references and every path's evidence as retrieval returned it. Selected and deferred candidates are
// both stored, so none is silently dropped. Retrieval itself is unchanged: this only saves its output.

import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { candidates } from "../db/schema";
import type { Candidate, Deferred } from "../retrieve";

const row = (set: string, witnessId: number, c: Candidate, status: "selected" | "deferred", deferredReason: string | null, jobId: number | null) => ({
  candidateSet: set,
  jobId,
  witnessId,
  depositionA: c.a.depositionId,
  groupA: c.a.groupId,
  depositionB: c.b.depositionId,
  groupB: c.b.groupId,
  // The parts the strongest path's evidence came from: exact source references for display.
  exchangeA: c.evidence[0].exchangeA,
  exchangeB: c.evidence[0].exchangeB,
  sources: c.sources,
  rankClaims: c.ranks.claims ?? null,
  rankFulltext: c.ranks.fulltext ?? null,
  rrfScore: c.rrfScore,
  mergedRank: c.rank,
  evidence: c.evidence,
  status,
  deferredReason,
});

// Writes a set once. Re-running with the same name refuses rather than mixing two retrieval runs.
export async function persistCandidates(
  db: Database,
  { set, witnessId, selected, deferred, jobId = null }: { set: string; witnessId: number; selected: readonly Candidate[]; deferred: readonly Deferred[]; jobId?: number | null },
): Promise<{ selected: number; deferred: number }> {
  const [existing] = await db.select({ id: candidates.id }).from(candidates).where(eq(candidates.candidateSet, set)).limit(1);
  if (existing) throw new Error(`Candidate set "${set}" already exists; use a new name.`);
  const rows = [...selected.map((c) => row(set, witnessId, c, "selected", null, jobId)), ...deferred.map((c) => row(set, witnessId, c, "deferred", c.reason, jobId))];
  await db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += 500) await tx.insert(candidates).values(rows.slice(i, i + 500));
  });
  return { selected: selected.length, deferred: deferred.length };
}

export async function findCandidate(db: Database, set: string, pair: { depositionA: number; groupA: number; depositionB: number; groupB: number }) {
  const [c] = await db
    .select()
    .from(candidates)
    .where(
      and(
        eq(candidates.candidateSet, set),
        eq(candidates.depositionA, pair.depositionA),
        eq(candidates.groupA, pair.groupA),
        eq(candidates.depositionB, pair.depositionB),
        eq(candidates.groupB, pair.groupB),
      ),
    );
  return c ?? null;
}
