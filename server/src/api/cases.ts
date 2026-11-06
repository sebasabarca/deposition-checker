// Case endpoints: create and list cases, view one with its witnesses and deposition sessions, and add a witness.
// A case's analyses are its whole-case runs (api/caseRuns.ts). Requests only read and write rows.

import { Router } from "express";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { caseRuns, cases, depositions, orgs, witnesses } from "../db/schema";

const Id = z.coerce.number().int().positive();
const Name = z.string().trim().min(1).max(200);
export const DEFAULT_ORG = "Default";

async function defaultOrg(db: Database): Promise<number> {
  const [org] = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.name, DEFAULT_ORG)).limit(1);
  if (org) return org.id;
  const [created] = await db.insert(orgs).values({ name: DEFAULT_ORG }).returning({ id: orgs.id });
  return created.id;
}

// A current finding: none that an applied evidence migration quarantined (evidence/correction.ts) is counted.
const CURRENT = sql`not exists (select 1 from evidence_quarantine q join evidence_migrations m on m.id = q.migration_id where q.kind = 'finding' and q.row_id = f.id and m.status = 'applied')`;

// A case's latest analysis: its newest whole-case run that ran (confirmed, or a test-model run), never an estimate.
// Only its findings count, so analyzing a case again doesn't count them twice. Used with the case as `c`.
export const LATEST_ANALYSIS_RUN = sql`(select r.id from case_runs r where r.case_id = c.id and (r.confirmed_at is not null or r.mode = 'mock') order by r.id desc limit 1)`;
const OF_LATEST = sql`k.candidate_set = 'case-run-' || ${LATEST_ANALYSIS_RUN}`;
// A finding waiting for a decision: undecided, current, and in the Potential contradictions or Needs context lane
// (present.ts findingGroup: not unverified, not compatible).
const NEEDS_REVIEW = sql`
  f.review_state = 'unreviewed' and ${CURRENT}
  and f.evidence_status not in ('wrong_reference', 'unsupported') and coalesce(f.unscored_reason, '') <> 'attribution_failed'
  and (f.type <> 'false_positive' or f.score is null or f.priority = 'needs_context' or coalesce(f.unscored_reason, '') = 'insufficient_evidence')`;
const MOVING = sql`r.status in ('queued', 'retrieving', 'adjudicating', 'reconciling') and (r.confirmed_at is not null or r.mode = 'mock')`;

// orgId limits the list to one organization: always set behind sign-in (server/src/auth.ts).
export async function caseSummaries(db: Database, orgId?: number) {
  const rows = await db.execute<{ id: string; name: string; created_at: string; depositions: number; witnesses: number; witness_names: string[]; reports: number; findings: number; needs_review: number; checking: number; last_activity: string; last_status: string | null; last_analysis: string | null }>(sql`
    select c.id, c.name, c.created_at,
      (select count(*)::int from depositions d where d.case_id = c.id) as depositions,
      (select count(*)::int from witnesses w where w.case_id = c.id) as witnesses,
      (select coalesce(array_agg(w.name order by w.name), '{}') from witnesses w where w.case_id = c.id) as witness_names,
      (select count(*)::int from case_runs r where r.case_id = c.id and (r.confirmed_at is not null or r.mode = 'mock')) as reports,
      (select count(*)::int from findings f join candidates k on k.id = f.candidate_id where ${OF_LATEST} and ${CURRENT}) as findings,
      (select count(*)::int from findings f join candidates k on k.id = f.candidate_id where ${OF_LATEST} and ${NEEDS_REVIEW}) as needs_review,
      (select count(*)::int from case_runs r where r.case_id = c.id and ${MOVING}) as checking,
      greatest(c.created_at, (select max(r.updated_at) from case_runs r where r.case_id = c.id), (select max(d.created_at) from depositions d where d.case_id = c.id)) as last_activity,
      (select r.status from case_runs r where r.id = ${LATEST_ANALYSIS_RUN}) as last_status,
      ${LATEST_ANALYSIS_RUN} as last_analysis
    from cases c ${orgId === undefined ? sql`` : sql`where c.org_id = ${orgId}`} order by last_activity desc
  `);
  return rows.rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    createdAt: r.created_at,
    depositions: r.depositions,
    witnesses: r.witnesses,
    witnessNames: r.witness_names,
    reports: r.reports,
    findings: r.findings,
    needsReview: r.needs_review,
    checking: r.checking > 0,
    lastActivity: r.last_activity,
    // The latest whole-case analysis (a case run's id and status).
    lastAnalysis: r.last_analysis === null ? null : { id: Number(r.last_analysis), status: r.last_status },
  }));
}

export async function caseDetail(db: Database, id: number) {
  const [kase] = await db.select().from(cases).where(eq(cases.id, id));
  if (!kase) return null;
  const ws = await db.select().from(witnesses).where(eq(witnesses.caseId, id)).orderBy(witnesses.name);
  const ds = await db
    .select({
      id: depositions.id,
      witnessId: depositions.witnessId,
      takenOn: depositions.takenOn,
      status: depositions.status,
      error: depositions.ingestError,
      pageCount: depositions.pageCount,
      needsOcrPages: depositions.needsOcrPages,
      originalFilename: depositions.originalFilename,
      fileSha256: depositions.fileSha256,
      createdAt: depositions.createdAt,
      dateFound: sql<{ date: string; ref: string; text: string } | null>`${depositions.validation}->'dateFound'`,
      dateConfirmed: sql<string | null>`${depositions.validation}->>'dateConfirmed'`,
      scanned: sql<boolean>`(${depositions.validation}->'ocr') is not null and ${depositions.validation}->'ocr' <> 'null'::jsonb`,
    })
    .from(depositions)
    .where(eq(depositions.caseId, id))
    .orderBy(depositions.takenOn, depositions.id);
  // The case's whole-case analyses (runs that ran: confirmed or test-model, never an unconfirmed estimate), newest
  // first, for the screens that list what happened (Overview activity, the running pill). The full report is
  // GET /cases/:id/case-runs.
  const runs = await db.select({ id: caseRuns.id, status: caseRuns.status, config: caseRuns.config, mode: caseRuns.mode, createdAt: caseRuns.createdAt, finishedAt: caseRuns.finishedAt }).from(caseRuns)
    .where(sql`${caseRuns.caseId} = ${id} and (${caseRuns.confirmedAt} is not null or ${caseRuns.mode} = 'mock')`).orderBy(desc(caseRuns.id));
  // Findings of the latest analysis (summing every analysis would count a re-run twice).
  const [counts] = (await db.execute<{ n: number }>(sql`select count(*)::int as n from findings f join candidates k on k.id = f.candidate_id, cases c where c.id = ${id} and ${OF_LATEST}`)).rows;
  return {
    case: { id: kase.id, name: kase.name, createdAt: kase.createdAt, findings: counts.n },
    witnesses: ws.map((w) => ({ id: w.id, name: w.name, depositions: ds.filter((d) => d.witnessId === w.id).map((d) => d.id) })),
    depositions: ds.map((d) => ({ ...d, fileSha256: d.fileSha256.slice(0, 12) })),
    runs: runs.map((r) => ({ id: r.id, name: (r.config as { name?: string }).name ?? null, status: r.status, mode: r.mode, createdAt: r.createdAt, finishedAt: r.finishedAt })),
  };
}

export function caseRoutes({ db }: { db: Database }): Router {
  const router = Router();

  router.get("/cases", async (_req, res) => {
    res.json({ cases: await caseSummaries(db, res.locals.user?.orgId) });
  });

  router.post("/cases", async (req, res) => {
    const body = z.object({ name: Name, witness: Name.optional() }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "A case name (up to 200 characters) is required." });
    const orgId: number = res.locals.user?.orgId ?? (await defaultOrg(db));
    const [kase] = await db.insert(cases).values({ orgId, name: body.data.name }).returning();
    if (body.data.witness) await db.insert(witnesses).values({ caseId: kase.id, name: body.data.witness });
    return res.status(201).json(await caseDetail(db, kase.id));
  });

  router.get("/cases/:id", async (req, res) => {
    const id = Id.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "The case ID must be a positive number." });
    const detail = await caseDetail(db, id.data);
    if (!detail) return res.status(404).json({ error: "Case not found." });
    return res.json(detail);
  });

  router.post("/cases/:id/witnesses", async (req, res) => {
    const id = Id.safeParse(req.params.id);
    const body = z.object({ name: Name }).safeParse(req.body);
    if (!id.success) return res.status(400).json({ error: "The case ID must be a positive number." });
    if (!body.success) return res.status(400).json({ error: "A witness name (up to 200 characters) is required." });
    const [kase] = await db.select({ id: cases.id }).from(cases).where(eq(cases.id, id.data));
    if (!kase) return res.status(404).json({ error: "Case not found." });
    const inserted = await db.insert(witnesses).values({ caseId: kase.id, name: body.data.name }).onConflictDoNothing().returning();
    if (inserted.length === 0) return res.status(409).json({ error: "This case already has a witness with that name." });
    return res.status(201).json({ witness: { id: inserted[0].id, name: inserted[0].name } });
  });

  return router;
}
