// Whole-case runs (jobs/caseRun.ts). Requests only read and write rows and queue the job; the worker runs it.

import { and, desc, eq, inArray } from "drizzle-orm";
import { Router } from "express";
import type { PgBoss } from "pg-boss";
import { z } from "zod";
import type { Database } from "../db/client";
import { caseRuns, cases, depositions } from "../db/schema";
import { enqueueCaseRun } from "../jobs/queue";
import { CASE_RUN_CONTRACTS, caseRunFindings, caseRunReport, confirmCaseRun, createCaseRun, resumeCaseRun, stretchAllowed } from "../jobs/caseRun";
import { analysisKeySet } from "../jobs/analysis";

const Id = z.coerce.number().int().positive();
const ACTIVE = ["queued", "retrieving", "awaiting_confirmation", "adjudicating"];
const NO_ACCESS = { error: "Paid checks aren't enabled for this account yet. Veridict is in early access; contact us to turn them on.", code: "no_analysis_access" };
const Execution = z.enum(["standard", "batch"]);
// execution: a test-model run picks its transport at start (it needs no confirmation); a live run picks it when
// it is confirmed, after its estimate.
// contract: packet-v1 by default; the experimental whole-stretch contract only where the server allows it
// (ALLOW_STRETCH_V2=true). A live stretch run is then estimated and confirmed like any other.
// depositionIds: analyze only these depositions (at least two sessions, all ready, all in this case); absent = the whole case.
const StartCaseRun = z.object({ mode: z.enum(["live", "mock"]), execution: Execution.optional(), contract: z.enum(CASE_RUN_CONTRACTS).optional(), depositionIds: z.array(Id).min(2).max(1000).optional() }).strict();
// A whole case is far larger than one pair of sessions (the six-document real fixtures project about $60), so
// case runs have their own ceiling. The budget itself is always the person's explicit confirmation.
export const MAX_CASE_RUN_BUDGET_USD = 250;
const Budget = z.number().positive().max(MAX_CASE_RUN_BUDGET_USD);

// env: where the analysis key is looked for (process.env; tests pass their own).
// What this server can actually run, so the screen never offers a mode that would stop at once. Fast and Economy
// (the Message Batches API) both need only the server's ANTHROPIC_API_KEY; each run still needs confirmation.
//   paidAvailable / economyAvailable  the key is set
//   economyBlocked                    "paid_off" without a key, else null
export const capabilities = (env: Record<string, string | undefined>) => {
  const paid = analysisKeySet(env);
  return { paidAvailable: paid, economyAvailable: paid, economyBlocked: paid ? null : ("paid_off" as const) };
};

export function caseRunRoutes({ db, boss, env = process.env }: { db: Database; boss: PgBoss; env?: Record<string, string | undefined> }): Router {
  const router = Router();
  // Every report says whether paid economy runs can be confirmed here, so the UI offers the choice only then.
  const reportOf = async (id: number) => {
    const r = await caseRunReport(db, id);
    return r && { ...r, ...capabilities(env), stretchAvailable: stretchAllowed(env) };
  };

  router.post("/cases/:id/case-runs", async (req, res) => {
    const caseId = Id.safeParse(req.params.id);
    const body = StartCaseRun.safeParse(req.body ?? {});
    if (!caseId.success || !body.success) return res.status(400).json({ error: "Give the mode: live or mock. A live run stops after retrieval with its estimate; confirm it with a budget to start." });
    if (body.data.contract === "stretch-v2" && !stretchAllowed(env)) return res.status(409).json({ error: "Whole-stretch reading is experimental and isn't enabled on this server.", code: "stretch_disabled" });
    // Test-model runs are a developer tool (the CLI and tests create them directly); people never start one here
    // unless the server allows it (ALLOW_TEST_RUNS=true).
    if (body.data.mode === "mock" && env.ALLOW_TEST_RUNS !== "true") return res.status(403).json({ error: "Test-model runs aren't available here.", code: "test_runs_disabled" });
    const [kase] = await db.select({ id: cases.id }).from(cases).where(eq(cases.id, caseId.data));
    if (!kase) return res.status(404).json({ error: "Case not found." });
    const chosen = body.data.depositionIds;
    if (chosen) {
      const rows = await db.select({ id: depositions.id, status: depositions.status, sessionId: depositions.sessionId, excludedReason: depositions.excludedReason }).from(depositions).where(and(eq(depositions.caseId, caseId.data), inArray(depositions.id, chosen)));
      if (rows.length !== new Set(chosen).size) return res.status(400).json({ error: "Every selected deposition must belong to this case.", code: "scope_invalid" });
      if (rows.some((r) => r.status !== "ready" || r.excludedReason !== null)) return res.status(400).json({ error: "Every selected deposition must have finished reading and be included in analyses.", code: "scope_not_ready" });
      if (new Set(rows.map((r) => r.sessionId)).size < 2) return res.status(400).json({ error: "Select depositions from at least two different sessions: testimony is compared across sessions.", code: "scope_one_session" });
    }
    const [active] = await db.select({ id: caseRuns.id }).from(caseRuns).where(and(eq(caseRuns.caseId, caseId.data), inArray(caseRuns.status, ACTIVE)));
    if (active) return res.status(409).json({ error: `Case run ${active.id} is still running for this case.`, caseRunId: active.id });
    const run = await createCaseRun(db, caseId.data, { mode: body.data.mode, execution: body.data.mode === "mock" ? (body.data.execution ?? "standard") : "standard", contract: body.data.contract, depositionIds: chosen });
    await enqueueCaseRun(boss, { caseRunId: run.id });
    return res.status(202).json({ caseRun: await reportOf(run.id) });
  });

  router.get("/cases/:id/case-runs", async (req, res) => {
    const caseId = Id.safeParse(req.params.id);
    if (!caseId.success) return res.status(400).json({ error: "The case ID must be a positive number." });
    const ids = await db.select({ id: caseRuns.id }).from(caseRuns).where(eq(caseRuns.caseId, caseId.data)).orderBy(desc(caseRuns.id));
    // stretchAvailable at the top too: a case with no run yet still needs to know whether to offer the option.
    return res.json({ caseRuns: await Promise.all(ids.map((r) => reportOf(r.id))), stretchAvailable: stretchAllowed(env), ...capabilities(env) });
  });

  router.get("/case-runs/:id", async (req, res) => {
    const id = Id.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "The case run ID must be a positive number." });
    const report = await reportOf(id.data);
    return report ? res.json({ caseRun: report }) : res.status(404).json({ error: "Case run not found." });
  });

  router.get("/case-runs/:id/findings", async (req, res) => {
    const id = Id.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "The case run ID must be a positive number." });
    const report = await reportOf(id.data);
    if (!report) return res.status(404).json({ error: "Case run not found." });
    return res.json({ complete: report.complete, incompleteReasons: report.incompleteReasons, findings: await caseRunFindings(db, id.data) });
  });

  // Confirms a live run's estimate with a budget and an execution mode (standard, the default, or batch); the run
  // then starts its paid adjudication. Batch needs retentionAcknowledged: the provider keeps batch data 29 days.
  router.post("/case-runs/:id/confirm", async (req, res) => {
    const id = Id.safeParse(req.params.id);
    // fresh: a fresh analysis, which reuses no earlier response and pays for every request (exact-request reuse).
    const body = z.object({ budgetUsd: Budget, execution: Execution.optional(), retentionAcknowledged: z.boolean().optional(), name: z.string().trim().min(1).max(120).optional(), fresh: z.boolean().optional() }).strict().safeParse(req.body ?? {});
    if (!id.success || !body.success) return res.status(400).json({ error: `Confirm with a budget in USD (more than 0, at most ${MAX_CASE_RUN_BUDGET_USD}).` });
    if (!analysisKeySet(env)) return res.status(409).json({ error: "Paid analysis isn't set up on this server: add the API key to the server's .env (see .env.example) and restart. Nothing was sent.", code: "paid_unavailable" });
    const outcome = await confirmCaseRun(db, id.data, body.data);
    if (outcome === "not_found") return res.status(404).json({ error: "Case run not found." });
    if (outcome === "no_acknowledgement") return res.status(400).json({ error: "Economy analysis stores the testimony with the AI provider for up to 29 days. Confirm that you understand this to use it.", code: "retention_not_acknowledged" });
    if (outcome !== "queued") return res.status(409).json({ error: "Only a live run waiting for confirmation can be confirmed." });
    await enqueueCaseRun(boss, { caseRunId: id.data });
    return res.status(202).json({ caseRun: await reportOf(id.data) });
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
    return res.status(202).json({ caseRun: await reportOf(id.data) });
  });

  // No new packet is started; the one in flight finishes and is kept.
  router.post("/case-runs/:id/cancel", async (req, res) => {
    const id = Id.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "The case run ID must be a positive number." });
    const [run] = await db.select().from(caseRuns).where(eq(caseRuns.id, id.data));
    if (!run) return res.status(404).json({ error: "Case run not found." });
    if (!ACTIVE.includes(run.status)) return res.status(409).json({ error: `Only a running case run can be cancelled; this one is ${run.status}.` });
    // An economy run between checks has no runner but has batches at the provider: its next check cancels them,
    // imports what finished, and only then ends the run.
    if (run.execution === "batch" && run.status === "adjudicating") {
      await db.update(caseRuns).set({ cancelRequestedAt: new Date(), updatedAt: new Date() }).where(eq(caseRuns.id, run.id));
      await enqueueCaseRun(boss, { caseRunId: run.id });
      return res.status(202).json({ caseRun: await reportOf(run.id) });
    }
    await db.update(caseRuns).set({ cancelRequestedAt: new Date(), updatedAt: new Date(), ...(run.runnerId === null ? { status: "cancelled", error: "Cancelled before it started.", finishedAt: new Date() } : {}) }).where(eq(caseRuns.id, run.id));
    return res.status(202).json({ caseRun: await reportOf(run.id) });
  });

  return router;
}
