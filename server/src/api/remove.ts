// Deleting depositions and cases. A deposition takes with it every analysis that compared it, and
// those analyses' candidates, verdicts, findings and review decisions; nothing is left pointing at a
// deleted row. A deposition being compared right now can't be deleted, so a running job never loses
// its rows underneath it. Model-call cost records (llm_calls, budgets) are kept: money spent stays
// on the books. The stored file goes only when no other deposition uses it.

import { rm } from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { withTransaction, type Database } from "../db/client";
import { adjudicationRequests, analyses, candidates, caseRuns, cases, depositions, exchanges, findings, lines, screeningEntries, screeningRuns, witnesses } from "../db/schema";
import { UPLOADS_DIR } from "../ingest";

const ACTIVE = ["queued", "parsing", "retrieving", "adjudicating"] as const;

export type Removal = { outcome: "deleted"; depositions: number; analyses: number } | { outcome: "running"; analyses: number[] } | { outcome: "not_found" };

type Tx = Parameters<Parameters<typeof withTransaction>[1]>[0];

export async function removeDepositions(tx: Tx, ids: number[]): Promise<{ analyses: number; storageKeys: string[] } | { running: number[] }> {
  if (ids.length === 0) return { analyses: 0, storageKeys: [] };
  const rows = await tx.select({ id: depositions.id, storageKey: depositions.storageKey, witnessId: depositions.witnessId }).from(depositions).where(inArray(depositions.id, ids)).for("update");
  const used = await tx
    .select({ id: analyses.id, status: analyses.status })
    .from(analyses)
    .where(or(inArray(analyses.depositionA, ids), inArray(analyses.depositionB, ids)))
    .for("update");
  const running = used.filter((a) => (ACTIVE as readonly string[]).includes(a.status)).map((a) => a.id);
  if (running.length > 0) return { running };
  // A whole-case run reading these depositions right now keeps them too.
  const caseIds = [...new Set((await tx.select({ caseId: depositions.caseId }).from(depositions).where(inArray(depositions.id, ids))).map((d) => d.caseId))];
  const caseRunning = caseIds.length ? await tx.select({ id: caseRuns.id }).from(caseRuns).where(and(inArray(caseRuns.caseId, caseIds), inArray(caseRuns.status, ["queued", "retrieving", "adjudicating"]))) : [];
  if (caseRunning.length > 0) return { running: caseRunning.map((r) => r.id) };

  const analysisIds = used.map((a) => a.id);
  // Candidates first: their verdicts, findings and topic links go with them (cascade), and a verdict
  // may point at an adjudication request, so the requests go after.
  await tx.delete(candidates).where(or(inArray(candidates.depositionA, ids), inArray(candidates.depositionB, ids), ...(analysisIds.length ? [inArray(candidates.jobId, analysisIds)] : [])));
  if (analysisIds.length) {
    await tx.delete(adjudicationRequests).where(inArray(adjudicationRequests.analysisId, analysisIds));
    await tx.delete(analyses).where(inArray(analyses.id, analysisIds)); // discovery runs cascade
  }
  // Exchanges point at lines, so they go first, as in a re-ingestion (ingest/store.ts).
  await tx.delete(exchanges).where(inArray(exchanges.depositionId, ids));
  await tx.delete(lines).where(inArray(lines.depositionId, ids));
  // Copies kept as duplicates of a removed one: the earliest becomes the copy that counts, the rest its duplicates.
  const list = sql.join(ids.map((x) => sql`${x}`), sql`, `);
  await tx.execute(sql`
    with o as (select id, min(id) over (partition by duplicate_of) as first from depositions where duplicate_of in (${list}) and id not in (${list}))
    update depositions d set excluded_reason = case when o.id = o.first then null else 'duplicate' end, duplicate_of = case when o.id = o.first then null else o.first end
    from o where d.id = o.id`);
  await tx.delete(depositions).where(inArray(depositions.id, ids));
  // A witness left with no session and no analysis goes too, so it stops being offered for uploads.
  const witnessIds = [...new Set(rows.map((r) => r.witnessId))];
  if (witnessIds.length) {
    await tx.delete(witnesses).where(and(
      inArray(witnesses.id, witnessIds),
      sql`not exists (select 1 from depositions d where d.witness_id = ${witnesses.id})`,
      sql`not exists (select 1 from analyses a where a.witness_id = ${witnesses.id} or a.witness_b_id = ${witnesses.id})`,
    ));
  }
  return { analyses: analysisIds.length, storageKeys: rows.map((r) => r.storageKey) };
}

// Files are stored once per content, so two cases can share one. Removed only when nothing uses it.
async function removeUnusedFiles(db: Database, keys: string[], uploadsDir: string) {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return;
  const still = new Set((await db.select({ key: depositions.storageKey }).from(depositions).where(inArray(depositions.storageKey, unique))).map((r) => r.key));
  await Promise.all(unique.filter((k) => !still.has(k)).map((k) => rm(path.join(uploadsDir, k), { force: true })));
}

type Step = { kind: "not_found" } | { kind: "running"; ids: number[] } | { kind: "done"; depositions: number; analyses: number; storageKeys: string[] };

async function finish(db: Database, step: Step, uploadsDir: string): Promise<Removal> {
  if (step.kind === "not_found") return { outcome: "not_found" };
  if (step.kind === "running") return { outcome: "running", analyses: step.ids };
  await removeUnusedFiles(db, step.storageKeys, uploadsDir);
  return { outcome: "deleted", depositions: step.depositions, analyses: step.analyses };
}

export async function deleteDeposition(db: Database, pool: Pool, id: number, uploadsDir = UPLOADS_DIR): Promise<Removal> {
  const step = await withTransaction(pool, async (tx): Promise<Step> => {
    const [row] = await tx.select({ id: depositions.id }).from(depositions).where(eq(depositions.id, id));
    if (!row) return { kind: "not_found" };
    const removed = await removeDepositions(tx, [id]);
    return "running" in removed ? { kind: "running", ids: removed.running } : { kind: "done", depositions: 1, ...removed };
  });
  return finish(db, step, uploadsDir);
}

export async function deleteCase(db: Database, pool: Pool, id: number, uploadsDir = UPLOADS_DIR): Promise<Removal> {
  const step = await withTransaction(pool, async (tx): Promise<Step> => {
    const [kase] = await tx.select({ id: cases.id }).from(cases).where(eq(cases.id, id)).for("update");
    if (!kase) return { kind: "not_found" };
    const ids = (await tx.select({ id: depositions.id }).from(depositions).where(eq(depositions.caseId, id))).map((d) => d.id);
    const removed = await removeDepositions(tx, ids);
    if ("running" in removed) return { kind: "running", ids: removed.running };
    // Anything still tied to the case by case_id alone (an analysis or finding without a deposition).
    const left = (await tx.select({ id: analyses.id }).from(analyses).where(eq(analyses.caseId, id))).map((a) => a.id);
    if (left.length) {
      await tx.delete(candidates).where(inArray(candidates.jobId, left));
      await tx.delete(adjudicationRequests).where(inArray(adjudicationRequests.analysisId, left));
      await tx.delete(analyses).where(inArray(analyses.id, left));
    }
    // Whole-case runs: their ledger, requests and rows (their candidates went with the depositions).
    const runIds = (await tx.select({ id: caseRuns.id }).from(caseRuns).where(eq(caseRuns.caseId, id))).map((r) => r.id);
    if (runIds.length) {
      const ledgers = (await tx.select({ id: screeningRuns.id }).from(screeningRuns).where(inArray(screeningRuns.caseRunId, runIds))).map((r) => r.id);
      if (ledgers.length) {
        await tx.delete(screeningEntries).where(inArray(screeningEntries.runId, ledgers));
        await tx.delete(screeningRuns).where(inArray(screeningRuns.id, ledgers));
      }
      await tx.delete(candidates).where(inArray(candidates.candidateSet, runIds.map((r) => `case-run-${r}`)));
      await tx.delete(adjudicationRequests).where(inArray(adjudicationRequests.candidateSet, runIds.map((r) => `case-run-${r}`)));
      await tx.delete(caseRuns).where(inArray(caseRuns.id, runIds));
    }
    await tx.delete(findings).where(eq(findings.caseId, id));
    await tx.delete(witnesses).where(eq(witnesses.caseId, id));
    await tx.delete(cases).where(eq(cases.id, id));
    return { kind: "done", depositions: ids.length, ...removed };
  });
  return finish(db, step, uploadsDir);
}
