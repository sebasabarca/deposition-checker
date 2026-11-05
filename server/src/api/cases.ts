// Case endpoints: create and list cases, view one with its witnesses, deposition sessions and
// analyses, and add a witness. Requests only read and write rows; nothing here parses or adjudicates.

import { Router } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { analyses, candidates, cases, depositions, findings, orgs, witnesses } from "../db/schema";
import { caseAnalysisView } from "./caseAnalysis";

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

// A finding needing a decision: not yet decided, and neither compatible nor unverified. Only each pair's
// latest report counts, so checking a pair again doesn't count its findings twice.
const NEEDS_REVIEW = sql`
  f.review_state = 'unreviewed' and ${CURRENT} and f.type <> 'false_positive' and f.evidence_status not in ('wrong_reference', 'unsupported')
  and coalesce(f.unscored_reason, '') <> 'attribution_failed'
  and k.job_id = (select max(b.id) from analyses b where b.deposition_a = a.deposition_a and b.deposition_b = a.deposition_b)`;

// orgId limits the list to one organization: always set behind sign-in (server/src/auth.ts).
export async function caseSummaries(db: Database, orgId?: number) {
  const rows = await db.execute<{ id: string; name: string; created_at: string; depositions: number; witnesses: number; witness_names: string[]; reports: number; findings: number; needs_review: number; checking: number; last_activity: string; last_status: string | null; last_analysis: string | null }>(sql`
    select c.id, c.name, c.created_at,
      (select count(*)::int from depositions d where d.case_id = c.id) as depositions,
      (select count(*)::int from witnesses w where w.case_id = c.id) as witnesses,
      (select coalesce(array_agg(w.name order by w.name), '{}') from witnesses w where w.case_id = c.id) as witness_names,
      (select count(*)::int from analyses a where a.case_id = c.id) as reports,
      -- Findings of the case's latest analysis: summing every analysis would count a re-run twice.
      (select count(*)::int from findings f join candidates k on k.id = f.candidate_id
        where k.job_id = (select a.id from analyses a where a.case_id = c.id order by a.id desc limit 1) and ${CURRENT}) as findings,
      (select count(*)::int from findings f join candidates k on k.id = f.candidate_id join analyses a on a.id = k.job_id where a.case_id = c.id and ${NEEDS_REVIEW}) as needs_review,
      (select count(*)::int from analyses a where a.case_id = c.id and a.status in ('queued', 'parsing', 'retrieving', 'adjudicating')) as checking,
      greatest(c.created_at, (select max(a.updated_at) from analyses a where a.case_id = c.id), (select max(d.created_at) from depositions d where d.case_id = c.id)) as last_activity,
      (select a.status::text from analyses a where a.case_id = c.id order by a.id desc limit 1) as last_status,
      (select a.id from analyses a where a.case_id = c.id order by a.id desc limit 1) as last_analysis
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
      scanned: sql<boolean>`(${depositions.validation}->'ocr') is not null and ${depositions.validation}->'ocr' <> 'null'::jsonb`,
    })
    .from(depositions)
    .where(eq(depositions.caseId, id))
    .orderBy(depositions.takenOn, depositions.id);
  const as = await db.select().from(analyses).where(eq(analyses.caseId, id)).orderBy(desc(analyses.id));
  // Findings of the latest analysis (summing every analysis would count a re-run twice).
  const latest = await db.select({ id: analyses.id }).from(analyses).where(eq(analyses.caseId, id)).orderBy(desc(analyses.id)).limit(1);
  const [counts] = latest.length
    ? await db.select({ n: sql<number>`count(*)::int` }).from(findings).innerJoin(candidates, eq(candidates.id, findings.candidateId)).where(eq(candidates.jobId, latest[0].id))
    : [{ n: 0 }];
  return {
    case: { id: kase.id, name: kase.name, createdAt: kase.createdAt, findings: counts.n },
    witnesses: ws.map((w) => ({ id: w.id, name: w.name, depositions: ds.filter((d) => d.witnessId === w.id).map((d) => d.id) })),
    depositions: ds.map((d) => ({ ...d, fileSha256: d.fileSha256.slice(0, 12) })),
    analyses: as.map((a) => ({ id: a.id, kind: a.kind, witnessId: a.witnessId, witnessBId: a.witnessBId, depositionA: a.depositionA, depositionB: a.depositionB, mode: a.mode, status: a.status, progress: a.progress, error: a.error, createdAt: a.createdAt, finishedAt: a.finishedAt })),
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

  // The case's stored whole-case analysis, resolved to stored transcript lines; null when it has none.
  router.get("/cases/:id/case-analysis", async (req, res) => {
    const id = Id.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "The case ID must be a positive number." });
    return res.json({ analysis: await caseAnalysisView(db, id.data) });
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

// Depositions of a case by ID, for validating an analysis request.
export async function depositionsOf(db: Database, caseId: number, ids: number[]) {
  return db.select().from(depositions).where(and(eq(depositions.caseId, caseId), inArray(depositions.id, ids)));
}
