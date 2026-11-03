// Same-witness direct discovery with a chosen model, on the sessions of an existing analysis, to compare
// models. It sends what the live path sends (the same prompt, effort, output cap and one batch request) and
// checks findings with the live verification, but returns a report only: the analysis, its candidates and
// findings are never touched. Used by scripts/direct-model.ts.

import Anthropic from "@anthropic-ai/sdk";
import { desc, eq } from "drizzle-orm";
import { BudgetExceeded, closeFailed, maxBatchRequestCost, recordCall, releaseUnbilled, reserve, settle } from "../costs";
import type { Database } from "../db/client";
import { analyses, budgets, discoveryRuns, llmCalls } from "../db/schema";
import { verifyDirectFinding } from "../verify";
import { classifyDiscovery, DISCOVERY_EFFORT, DISCOVERY_MAX_OUTPUT_TOKENS, fitsContext, inputTokensBound, loadSessions, type DiscoveryProvider } from "./discover";
import { DISCOVERY_PROMPT_VERSION, discoveryUserPrompt } from "./discoverPrompt";
import { readDiscoveryOutput, type DiscoveryOutput } from "./discoverSchema";

export const COMPARISON_MODELS = { fable: "claude-fable-5-1", opus: "claude-opus-5-5" } as const;
export type ComparisonModel = keyof typeof COMPARISON_MODELS;
const POLL_MS = 30_000;

// The gate for a paid comparison: the same rule as live analyses (a key and ALLOW_PAID_CALLS=true), plus
// --execute and an approved cap. Pure. Returns the cap.
export function paidRunCap(env: NodeJS.ProcessEnv, execute: boolean | undefined, approvedUsd: string | undefined): number {
  if (!env.ANTHROPIC_API_KEY || env.ALLOW_PAID_CALLS !== "true") throw new Error("Paid calls are off: this needs ANTHROPIC_API_KEY and ALLOW_PAID_CALLS=true for this one command.");
  if (!execute) throw new Error("Pass --execute: this makes a paid call.");
  const cap = Number(approvedUsd);
  if (!(cap > 0)) throw new Error("Pass --approved-usd with the approved spending cap.");
  return cap;
}

type Loaded = Awaited<ReturnType<typeof load>>;
async function load(db: Database, analysisId: number) {
  const [a] = await db.select().from(analyses).where(eq(analyses.id, analysisId));
  if (!a) throw new Error(`No analysis ${analysisId}`);
  const loaded = await loadSessions(db, a);
  return { a, ...loaded, user: discoveryUserPrompt(loaded.witness, loaded.sessions[0], loaded.sessions[1]) };
}

const sessionsOf = (s: Loaded) => s.sessions.map((x) => ({ label: x.label, depositionId: x.depositionId, sha256: s.hashes[x.depositionId] ?? null, description: x.description, lines: x.lines.length }));

// The live path's checks, finding by finding: lane, evidence status and both citations.
function check(output: DiscoveryOutput, s: Loaded) {
  return output.findings.map((f) => {
    const c = verifyDirectFinding(f, s.sessions, s.witness);
    return { findingId: f.finding_id, classification: f.classification, lane: c.lane, evidenceStatus: c.evidenceStatus, reasons: c.reasons, sharedSubject: f.shared_subject, a: { session: f.session_a, citation: f.citation_a, excerpt: f.exact_excerpt_a }, b: { session: f.session_b, citation: f.citation_b, excerpt: f.exact_excerpt_b }, explanation: f.explanation };
  });
}
export type ComparisonReport = {
  analysis: number;
  model: string;
  source: "paid run" | "stored answer, re-checked";
  sessions: ReturnType<typeof sessionsOf>;
  status: string;
  completion?: "complete" | "partial";
  limitations?: string[];
  findings?: ReturnType<typeof check>;
  costUsd?: number | null;
  error?: string;
  [extra: string]: unknown;
};

export async function runComparison(db: Database, opts: { analysisId: number; model: ComparisonModel; capUsd: number; provider: DiscoveryProvider; pollMs?: number }): Promise<ComparisonReport> {
  const model = COMPARISON_MODELS[opts.model];
  if (!model) throw new Error(`--model must be ${Object.keys(COMPARISON_MODELS).join(" or ")}`);
  const s = await load(db, opts.analysisId);
  const inputTokens = inputTokensBound(s.user);
  if (!fitsContext(inputTokens)) throw new Error("These sessions don't fit the context window; nothing was sent.");
  const maxCostUsd = maxBatchRequestCost(model, { inputTokens, maxOutputTokens: DISCOVERY_MAX_OUTPUT_TOKENS });
  const [budget] = await db.insert(budgets).values({ name: `direct-model-analysis-${s.a.id}-${opts.model}-${new Date().toISOString()}`, limitUsd: opts.capUsd }).returning();
  let reservationId: number;
  try {
    reservationId = await reserve(db, budget.id, maxCostUsd, `direct model comparison analysis ${s.a.id} ${model}`);
  } catch (error) {
    if (error instanceof BudgetExceeded) throw new Error(`Not sent: the worst case is $${maxCostUsd.toFixed(2)} and the cap $${opts.capUsd.toFixed(2)}.`);
    throw error;
  }
  const customId = `direct-model-${s.a.id}-${opts.model}-${Date.now()}`;
  let batchId: string;
  try {
    batchId = (await opts.provider.submit({ customId, model, user: s.user, maxOutputTokens: DISCOVERY_MAX_OUTPUT_TOKENS })).batchId;
  } catch (error) {
    await closeFailed(db, reservationId, error); // counted in full: it may have started a paid batch
    throw error;
  }
  let state = await opts.provider.poll(batchId);
  while (!state.ended) {
    await new Promise((done) => setTimeout(done, opts.pollMs ?? POLL_MS));
    state = await opts.provider.poll(batchId);
  }
  const result = await opts.provider.result(batchId, customId);
  const report: ComparisonReport = { analysis: s.a.id, model, source: "paid run", promptVersion: DISCOVERY_PROMPT_VERSION, effort: DISCOVERY_EFFORT, maxOutput: DISCOVERY_MAX_OUTPUT_TOKENS, maxCostUsd, batchId, latencyMs: state.latencyMs, sessions: sessionsOf(s), status: result.type };
  if (result.type === "succeeded") {
    const { message } = result;
    const classified = classifyDiscovery(result);
    const raw = "text" in classified ? classified.text : null;
    const call = await recordCall(db, { jobId: null, stage: "discovery", model: message.model, usage: message.usage as Anthropic.Usage, attempt: 1, items: 1, batch: true, rawOutput: raw, effort: DISCOVERY_EFFORT, latencyMs: state.latencyMs });
    await settle(db, reservationId, { id: call.id, costUsd: call.costUsd });
    Object.assign(report, { status: classified.status, stopReason: message.stop_reason, costUsd: call.costUsd, tokens: { input: message.usage.input_tokens, output: message.usage.output_tokens, thinking: message.usage.output_tokens_details?.thinking_tokens ?? null }, rawOutput: raw });
    // Only a finished, valid answer has findings; a cut-off, refused or invalid one is reported, never scored.
    if (classified.status === "succeeded") Object.assign(report, { completion: classified.output.summary.completion_status, limitations: classified.output.summary.limitations, findings: check(classified.output, s) });
    else report.error = "error" in classified ? classified.error : classified.status;
  } else {
    if (result.type === "errored" || result.type === "missing") await closeFailed(db, reservationId, new Error(result.type));
    else await releaseUnbilled(db, reservationId, `batch item ${result.type}`);
    report.error = `batch result: ${result.type}`;
  }
  return report;
}

// The analysis's own stored answer, checked again by today's code. No API call.
export async function storedComparison(db: Database, analysisId: number): Promise<ComparisonReport> {
  const s = await load(db, analysisId);
  const [r] = await db.select({ model: discoveryRuns.model, raw: llmCalls.rawOutput, cost: llmCalls.costUsd }).from(discoveryRuns).innerJoin(llmCalls, eq(llmCalls.id, discoveryRuns.llmCallId)).where(eq(discoveryRuns.analysisId, s.a.id)).orderBy(desc(discoveryRuns.attempt)).limit(1);
  if (!r) throw new Error(`Analysis ${s.a.id} has no stored model answer.`);
  const read = readDiscoveryOutput(r.raw);
  if (!read.output) throw new Error(`The stored answer isn't valid: ${read.error}`);
  return { analysis: s.a.id, model: r.model, source: "stored answer, re-checked", sessions: sessionsOf(s), status: "succeeded", costUsd: r.cost, completion: read.output.summary.completion_status, limitations: read.output.summary.limitations, findings: check(read.output, s) };
}

// A report's findings as proposals against a label file, matching sessions to its documents by file hash.
// Pure. Sessions whose file is not in the labels are left out, so the scorer can't credit another file.
export function reportProposals(report: Pick<ComparisonReport, "sessions" | "findings">, documents: Record<string, { sha256: string }>) {
  const docOf = new Map(report.sessions.map((x) => [x.label, Object.entries(documents).find(([, d]) => d.sha256 === x.sha256)?.[0] ?? null]));
  return (report.findings ?? []).flatMap((f) => {
    const [a, b] = [docOf.get(f.a.session), docOf.get(f.b.session)];
    return a && b ? [{ a: { document: a, citation: f.a.citation }, b: { document: b, citation: f.b.citation }, modelClassification: f.classification }] : [];
  });
}
