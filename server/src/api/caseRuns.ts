// Whole-case runs (jobs/caseRun.ts). Requests only read and write rows and queue the job; the worker runs it.

import { and, desc, eq, inArray } from "drizzle-orm";
import { Router } from "express";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import type { Database } from "../db/client";
import { caseRuns, cases } from "../db/schema";
import { enqueueCaseRun } from "../jobs/queue";
import { caseRunFindings, caseRunReport, confirmCaseRun, createCaseRun, resumeCaseRun } from "../jobs/caseRun";

const Id = z.coerce.number().int().positive();
const ACTIVE = ["queued", "retrieving", "awaiting_confirmation", "adjudicating"];
const NO_ACCESS = { error: "Paid checks aren't enabled for this account yet. Veridict is in early access; contact us to turn them on.", code: "no_analysis_access" };
const StartCaseRun = z.object({ mode: z.enum(["live", "mock"]) }).strict();
// A whole case is far larger than one pair of sessions (the six-document real fixtures project about $60), so
// case runs have their own ceiling. The budget itself is always the person's explicit confirmation.
export const MAX_CASE_RUN_BUDGET_USD = 250;
const Budget = z.number().positive().max(MAX_CASE_RUN_BUDGET_USD);

export function caseRunRoutes({ db, boss }: { db: Database; boss: PgBoss }): Router {
  const router = Router();

  router.post("/cases/:id/case-runs", async (req, res) => {
    const caseId = Id.safeParse(req.params.id);
    const body = StartCaseRun.safeParse(req.body ?? {});
    if (!caseId.success || !body.success) return res.status(400).json({ error: "Give the mode: live or mock. A live run stops after retrieval with its estimate; confirm it with a budget to start." });
    const [kase] = await db.select({ id: cases.id }).from(cases).where(eq(cases.id, caseId.data));
    if (!kase) return res.status(404).json({ error: "Case not found." });
    const [active] = await db.select({ id: caseRuns.id }).from(caseRuns).where(and(eq(caseRuns.caseId, caseId.data), inArray(caseRuns.status, ACTIVE)));
    if (active) return res.status(409).json({ error: `Case run ${active.id} is still running for this case.`, caseRunId: active.id });
    const run = await createCaseRun(db, caseId.data, { mode: body.data.mode });
    await enqueueCaseRun(boss, { caseRunId: run.id });
    return res.status(202).json({ caseRun: await caseRunReport(db, run.id) });
  });

  router.get("/cases/:id/case-runs", async (req, res) => {
    const caseId = Id.safeParse(req.params.id);
    if (!caseId.success) return res.status(400).json({ error: "The case ID must be a positive number." });
    const ids = await db.select({ id: caseRuns.id }).from(caseRuns).where(eq(caseRuns.caseId, caseId.data)).orderBy(desc(caseRuns.id));
    return res.json({ caseRuns: await Promise.all(ids.map((r) => caseRunReport(db, r.id))) });
  });

  router.get("/case-runs/:id", async (req, res) => {
    const id = Id.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "The case run ID must be a positive number." });
    const report = await caseRunReport(db, id.data);
    return report ? res.json({ caseRun: report }) : res.status(404).json({ error: "Case run not found." });
  });

  router.get("/case-runs/:id/findings", async (req, res) => {
    const id = Id.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "The case run ID must be a positive number." });
    const report = await caseRunReport(db, id.data);
    if (!report) return res.status(404).json({ error: "Case run not found." });
    return res.json({ complete: report.complete, incompleteReasons: report.incompleteReasons, findings: await caseRunFindings(db, id.data) });
  });

  // Confirms a live run's estimate with a budget; the run then starts its paid adjudication.
  router.post("/case-runs/:id/confirm", async (req, res) => {
    const id = Id.safeParse(req.params.id);
    const body = z.object({ budgetUsd: Budget }).strict().safeParse(req.body ?? {});
    if (!id.success || !body.success) return res.status(400).json({ error: `Confirm with a budget in USD (more than 0, at most ${MAX_CASE_RUN_BUDGET_USD}).` });
    const outcome = await confirmCaseRun(db, id.data, body.data);
    if (outcome === "not_found") return res.status(404).json({ error: "Case run not found." });
    if (outcome !== "queued") return res.status(409).json({ error: "Only a live run waiting for confirmation can be confirmed." });
    await enqueueCaseRun(boss, { caseRunId: id.data });
    return res.status(202).json({ caseRun: await caseRunReport(db, id.data) });
  });

  // retryUncertain: also retry packets whose failed request may have been billed (it could be paid twice).
  router.post("/case-runs/:id/resume", async (req, res) => {
    const id = Id.safeParse(req.params.id);
    const body = z.object({ budgetUsd: Budget.optional(), retryUncertain: z.boolean().optional() }).strict().safeParse(req.body ?? {});
    if (!id.success || !body.success) return res.status(400).json({ error: "Invalid resume request." });
    const [run] = await db.select({ mode: caseRuns.mode }).from(caseRuns).where(eq(caseRuns.id, id.data));
    if (!run) return res.status(404).json({ error: "Case run not found." });
    // A live resume may spend: the same analysis-access rule as every paid check. A mock resume never does.
    if (run.mode === "live" && !(res.locals.user as { analysisAccess?: boolean } | undefined)?.analysisAccess) return res.status(403).json(NO_ACCESS);
    const outcome = await resumeCaseRun(db, id.data, body.data);
    if (outcome === "not_found") return res.status(404).json({ error: "Case run not found." });
    if (outcome === "lower_budget") return res.status(400).json({ error: "A budget can only be raised, not lowered." });
    if (outcome !== "queued") return res.status(409).json({ error: `Only a stopped run can be resumed; this one is ${outcome}.` });
    await enqueueCaseRun(boss, { caseRunId: id.data });
    return res.status(202).json({ caseRun: await caseRunReport(db, id.data) });
  });

  // No new packet is started; the one in flight finishes and is kept.
  router.post("/case-runs/:id/cancel", async (req, res) => {
    const id = Id.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "The case run ID must be a positive number." });
    const [run] = await db.select().from(caseRuns).where(eq(caseRuns.id, id.data));
    if (!run) return res.status(404).json({ error: "Case run not found." });
    if (!ACTIVE.includes(run.status)) return res.status(409).json({ error: `Only a running case run can be cancelled; this one is ${run.status}.` });
    await db.update(caseRuns).set({ cancelRequestedAt: new Date(), updatedAt: new Date(), ...(run.runnerId === null ? { status: "cancelled", error: "Cancelled before it started.", finishedAt: new Date() } : {}) }).where(eq(caseRuns.id, run.id));
    return res.status(202).json({ caseRun: await caseRunReport(db, run.id) });
  });

  return router;
}
