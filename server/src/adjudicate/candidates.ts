// Saves a hybrid pool of candidate pairs into a named candidate set, with their source references and
// every path's evidence as retrieval returned it. Every candidate is stored, so none is silently dropped.

import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { candidates, candidateTopics } from "../db/schema";
import type { Pool } from "../retrieve";

// Saves a hybrid pool as one candidate set: every candidate with its status, provenance and the topics
// it was found through. Refuses a name already used.
export async function persistPool(
  db: Database,
  { set, witnessId, pool, retrievalVersion, mapVersion, jobId = null }: { set: string; witnessId: number; pool: Pool; retrievalVersion: string; mapVersion: number | null; jobId?: number | null },
): Promise<void> {
  const [existing] = await db.select({ id: candidates.id }).from(candidates).where(eq(candidates.candidateSet, set)).limit(1);
  if (existing) throw new Error(`Candidate set "${set}" already exists; use a new name.`);
  const rows = pool.candidates.map((c) => ({
    candidateSet: set, jobId, witnessId, depositionA: c.a.depositionId, groupA: c.a.groupId, depositionB: c.b.depositionId, groupB: c.b.groupId,
    exchangeA: c.evidence[0].exchangeA, exchangeB: c.evidence[0].exchangeB, sources: c.sources, rankTopics: c.ranks.topics ?? null, rankFulltext: c.ranks.fulltext ?? null,
    rrfScore: 0, // no fusion across paths: rank is selection order
    mergedRank: c.rank, evidence: c.evidence, status: c.status, deferredReason: c.deferredReason, exclusionReason: c.exclusionReason, retrievalVersion, mapVersion, selectedBy: c.selectedBy,
  }));
  await db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += 500) {
      const slice = rows.slice(i, i + 500);
      const ids = await tx.insert(candidates).values(slice).returning({ id: candidates.id });
      // Postgres returns inserted rows in the order of the VALUES list.
      const links = ids.flatMap((r, n) => pool.candidates[i + n].topicIds.map((topicId) => ({ candidateId: r.id, topicId })));
      if (links.length > 0) await tx.insert(candidateTopics).values(links);
    }
  });
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
