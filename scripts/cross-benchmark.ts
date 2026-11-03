// The cross-witness evaluation: every session of two witnesses, one discovery request, scored against
// human labels (data/eval/*-cross-v1.json). The transcripts are read by the production reader and the
// findings checked by the production verification; only the analysis record is skipped, because an
// analysis with several sessions per side doesn't exist in the database yet.
//
//   npx tsx scripts/cross-benchmark.ts estimate --set <labels.json> --root <dir>
//     No API call: the sessions, the prompt size and the cost range for each model.
//   npx tsx scripts/cross-benchmark.ts run --set <labels.json> --root <dir> --model fable|opus|sonnet
//       [--comparison <id>] [--effort high] [--max-output 20000] --approved-usd <n> --execute
//     PAID: one batch request per comparison. Needs ALLOW_PAID_CALLS=true. Every request reserves its
//     worst case against one budget first and stops at the ceiling; every call goes through recordCall().
//   npx tsx scripts/cross-benchmark.ts score --report <file>
//     No API call: scores a saved run again.
//
// Reports go to data/eval/review/cross/ (git-ignored), because they quote testimony.

import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { anthropicDiscovery, type DiscoveryResult } from "../server/src/adjudicate/discover";
import { CROSS_PROMPT_VERSION, CROSS_PROMPTS, crossUserPrompt, type CrossSession } from "../server/src/adjudicate/discoverCrossPrompt";
import { CROSS_JSON_SCHEMA, readCrossOutput, type CrossOutput } from "../server/src/adjudicate/discoverCrossSchema";
import { callCost, closeFailed, maxBatchRequestCost, recordCall, releaseUnbilled, reserve, settle, BudgetExceeded } from "../server/src/costs";
import { connect, type Database } from "../server/src/db/client";
import { budgets } from "../server/src/db/schema";
import { readCrossLabelFile, resolveAnchor, wholeAnswer, type CrossLabelFile } from "../server/src/eval/crossLabels";
import { scoreCross, type ScoredFinding } from "../server/src/eval/crossBenchmark";
import { readDeposition, TEXT_ARCHIVE_V1, TEXT_NUMBERED_V1 } from "../server/src/ingest";
import { evidenceStrengthCross } from "../server/src/score/evidenceStrengthCross";
import { verifyCrossFinding, type CrossStoredSession } from "../server/src/verify/cross";

const MODELS = { fable: "claude-fable-5-1", opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5" } as const;
const DEFAULT_EFFORT = "high";
const DEFAULT_MAX_OUTPUT = 20_000;
const POLL_MS = 30_000;
// Characters per token for this kind of text, as a range: plain English runs near 4; our earlier
// transcript runs measured nearer 2.66. Token counts also differ by model (up to about 1.35 times).
const CHARS_PER_TOKEN = { low: 4, high: 2.66 };
const REPORTS = "data/eval/review/cross";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { prompt: { type: "string" }, set: { type: "string" }, root: { type: "string" }, model: { type: "string" }, comparison: { type: "string" }, effort: { type: "string" }, "max-output": { type: "string" }, "approved-usd": { type: "string" }, execute: { type: "boolean" }, report: { type: "string" } } });
const PROMPT_VERSION = values.prompt ?? CROSS_PROMPT_VERSION; // v1 unless asked: a frozen run never changes prompt silently
const CROSS_SYSTEM = CROSS_PROMPTS[PROMPT_VERSION];
if (!CROSS_SYSTEM) throw new Error(`Unknown prompt version ${PROMPT_VERSION}: ${Object.keys(CROSS_PROMPTS).join(", ")}`);

type Loaded = { key: string; layout: string; status: string; session: CrossStoredSession & CrossSession };

// Reads each document of one comparison through the production reader. Witness A's sessions are
// A1, A2, ... and witness B's B1, B2, ..., each in date order. Line IDs are made up here, once per run.
async function loadComparison(labels: CrossLabelFile, root: string, comparisonId: string) {
  const comparison = labels.comparisons.find((c) => c.id === comparisonId)!;
  let nextId = 1;
  const loaded: Loaded[] = [];
  for (const [side, witness] of [["A", comparison.witnessA], ["B", comparison.witnessB]] as const) {
    const docs = Object.entries(labels.documents).filter(([, d]) => d.witness === witness).sort(([, x], [, y]) => x.takenOn.localeCompare(y.takenOn)); // same-day sessions keep the label file's order
    for (const [i, [key, doc]] of docs.entries()) {
      const bytes = new Uint8Array(readFileSync(path.join(root, doc.file)));
      const read = await readDeposition(bytes, undefined, undefined, witness);
      const lines = (read.exchanges?.lines ?? []).map((l) => ({ id: nextId++, page: l.printedPage ?? 0, line: l.lineNo, pdfPage: l.pdfPage, text: l.rawText, role: l.role, ocrConfidence: l.ocrConfidence ?? null }));
      const label = `${side}${i + 1}`;
      loaded.push({ key, layout: read.validation.layout, status: read.validation.status, session: { label, witness, takenOn: doc.takenOn, description: doc.session, depositionId: loaded.length + 1, lines, physicalLines: ["pdf-physical-v1", TEXT_ARCHIVE_V1.name].includes(read.validation.layout) } }); // not official line numbers
    }
  }
  return { comparison, loaded };
}

// Printed line numbers only mean something where the reader kept them; anywhere else such an anchor is
// reported as unresolved instead of landing on the wrong line.
function resolvePairs(comparison: CrossLabelFile["comparisons"][number], loaded: Loaded[]) {
  const linesOf = (key: string, anchor: Parameters<typeof resolveAnchor>[0]) => {
    const doc = loaded.find((d) => d.key === key);
    if (!doc) return [];
    if ("lines" in anchor && ![TEXT_ARCHIVE_V1.name, TEXT_NUMBERED_V1.name, "ellison-doj-v1", "scanned-25-v1"].includes(doc.layout)) return [];
    // Labels name the whole answer: a finding citing any part of it, its qualifiers included, counts.
    return wholeAnswer(resolveAnchor(anchor, doc.session.lines), doc.session.lines);
  };
  return comparison.pairs.map((p) => ({ id: p.id, expected: p.expected, a: linesOf(p.a.document, p.a), b: linesOf(p.b.document, p.b) }));
}

function costRange(model: string, chars: number, maxOutput: number) {
  const tokens = { low: Math.ceil(chars / CHARS_PER_TOKEN.low), high: Math.ceil((chars / CHARS_PER_TOKEN.high) * 1.35) };
  const batch = (input: number, output: number) => callCost(model, { input, output, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 }, { batch: true })!.costUsd;
  return { inputTokensLow: tokens.low, inputTokensHigh: tokens.high, expectedUsdLow: batch(tokens.low, Math.round(maxOutput / 2)), expectedUsdHigh: batch(tokens.high, maxOutput), worstCaseUsd: maxBatchRequestCost(model, { inputTokens: chars, maxOutputTokens: maxOutput }) };
}

type EstimateRow = { comparison: string; sessions: unknown[]; labels: unknown[]; promptChars: number; perModel: Record<keyof typeof MODELS, ReturnType<typeof costRange>> };

async function estimate(labels: CrossLabelFile, root: string, maxOutput: number) {
  const rows: EstimateRow[] = [];
  for (const c of labels.comparisons) {
    const { comparison, loaded } = await loadComparison(labels, root, c.id);
    const user = crossUserPrompt(comparison.witnessA, comparison.witnessB, loaded.map((d) => d.session));
    const chars = CROSS_SYSTEM.length + user.length + JSON.stringify(CROSS_JSON_SCHEMA).length;
    const pairs = resolvePairs(comparison, loaded);
    rows.push({
      comparison: c.id,
      sessions: loaded.map((d) => ({ label: d.session.label, witness: d.session.witness, document: d.key, read: `${d.status}, ${d.layout}`, lines: d.session.lines.length })),
      labels: pairs.map((p) => ({ id: p.id, expected: p.expected, resolved: p.a.length > 0 && p.b.length > 0 })),
      promptChars: chars,
      perModel: Object.fromEntries(Object.entries(MODELS).map(([name, model]) => [name, costRange(model, chars, maxOutput)])) as EstimateRow["perModel"],
    });
  }
  const total = (name: keyof typeof MODELS, k: "expectedUsdLow" | "expectedUsdHigh" | "worstCaseUsd") => rows.reduce((n, r) => n + r.perModel[name][k], 0);
  console.log(JSON.stringify({ set: labels.set, promptVersion: PROMPT_VERSION, mode: "Batch API, half of list price", requests: rows.length, maxOutputTokensPerRequest: maxOutput, refusalFallback: "none in this benchmark: a refusal is reported", rows, totals: Object.fromEntries(Object.keys(MODELS).map((m) => [m, { expectedUsdLow: total(m as keyof typeof MODELS, "expectedUsdLow"), expectedUsdHigh: total(m as keyof typeof MODELS, "expectedUsdHigh"), worstCaseUsd: total(m as keyof typeof MODELS, "worstCaseUsd") }])) }, null, 2));
}

// Verifies and scores one comparison's answer. Pure apart from the inputs it is given.
function assess(output: CrossOutput, loaded: Loaded[], pairs: ReturnType<typeof resolvePairs>) {
  const sessions = loaded.map((d) => d.session);
  const findings = output.findings.map((f, index) => {
    const check = verifyCrossFinding(f, sessions, { acceptUnofficialLines: true }); // test setting: archive lines count as citations
    const strength = evidenceStrengthCross({ classification: f.classification, lane: check.lane, a: check.a, b: check.b, basisA: f.basis_a, basisB: f.basis_b });
    return { index, finding: f, lane: check.lane, reasons: check.reasons, evidenceStatus: check.evidenceStatus, identityIssues: check.identityIssues, witnessA: check.witnessA, witnessB: check.witnessB, a: check.a, b: check.b, score: strength.score, priority: strength.priority, priorityReason: strength.priorityReason };
  });
  const scored: ScoredFinding[] = findings.map((f) => ({ index: f.index, lane: f.lane, classification: f.finding.classification, evidenceStatus: f.evidenceStatus, a: f.a.lineIds, b: f.b.lineIds }));
  return { findings, score: scoreCross(pairs, scored), modelSummary: output.summary };
}

async function waitFor(provider: ReturnType<typeof anthropicDiscovery>, batchId: string, customId: string): Promise<{ result: DiscoveryResult; latencyMs: number | null }> {
  for (;;) {
    const state = await provider.poll(batchId);
    if (state.ended) return { result: await provider.result(batchId, customId), latencyMs: state.latencyMs };
    await new Promise((done) => setTimeout(done, POLL_MS));
  }
}

async function run(db: Database, labels: CrossLabelFile, root: string, name: keyof typeof MODELS, ceiling: number, maxOutput: number, effort: "low" | "medium" | "high" | "xhigh" | "max") {
  if (process.env.ALLOW_PAID_CALLS !== "true") throw new Error("Set ALLOW_PAID_CALLS=true: this makes paid calls.");
  if (!values.execute) throw new Error("Pass --execute: this makes paid calls.");
  if (!(ceiling > 0)) throw new Error("Pass --approved-usd with the approved spending cap.");
  const model = MODELS[name];
  const [budget] = await db.insert(budgets).values({ name: `cross-benchmark-${labels.set}-${name}-${new Date().toISOString()}`, limitUsd: ceiling }).returning();
  const provider = anthropicDiscovery(new Anthropic({ maxRetries: 0 }), maxOutput, { system: CROSS_SYSTEM, schema: CROSS_JSON_SCHEMA, effort });
  mkdirSync(REPORTS, { recursive: true });
  const only = values.comparison?.split(",").map((s) => s.trim());
  const unknown = only?.filter((id) => !labels.comparisons.some((c) => c.id === id)) ?? [];
  if (unknown.length) throw new Error(`Unknown comparison ${unknown.join(", ")}: ${labels.comparisons.map((c) => c.id).join(", ")}`);
  for (const c of labels.comparisons.filter((x) => !only || only.includes(x.id))) {
    const { comparison, loaded } = await loadComparison(labels, root, c.id);
    const user = crossUserPrompt(comparison.witnessA, comparison.witnessB, loaded.map((d) => d.session));
    const inputBound = CROSS_SYSTEM.length + user.length + JSON.stringify(CROSS_JSON_SCHEMA).length;
    const maxCostUsd = maxBatchRequestCost(model, { inputTokens: inputBound, maxOutputTokens: maxOutput });
    let reservationId: number;
    try {
      reservationId = await reserve(db, budget.id, maxCostUsd, `cross benchmark ${labels.set} ${c.id} ${model}`);
    } catch (error) {
      if (error instanceof BudgetExceeded) { console.log(`Stopped before ${c.id}: it could cost $${maxCostUsd.toFixed(2)}, and $${error.availableUsd.toFixed(2)} of the cap remains.`); break; }
      throw error;
    }
    const customId = `cross-${c.id}-${Date.now()}`;
    let batchId: string;
    try {
      batchId = (await provider.submit({ customId, model, user, maxOutputTokens: maxOutput })).batchId;
    } catch (error) {
      await closeFailed(db, reservationId, error); // counted in full: it may have started a paid batch
      throw error;
    }
    console.log(`${c.id}: batch ${batchId} submitted to ${model}, waiting…`);
    const { result, latencyMs } = await waitFor(provider, batchId, customId);
    const report: Record<string, unknown> = { set: labels.set, comparison: c.id, model, effort, maxOutput, promptVersion: PROMPT_VERSION, batchId, sessions: loaded.map((d) => ({ label: d.session.label, witness: d.session.witness, document: d.key, read: d.layout, lines: d.session.lines.length })), ranAt: new Date().toISOString() };
    if (result.type === "succeeded") {
      const message = result.message;
      const text = message.content.find((b) => b.type === "text");
      const raw = text?.type === "text" ? text.text : null;
      const call = await recordCall(db, { jobId: null, stage: "discovery", model: message.model, usage: message.usage as Anthropic.Usage, attempt: 1, items: 1, batch: true, rawOutput: raw, effort, latencyMs });
      await settle(db, reservationId, { id: call.id, costUsd: call.costUsd });
      const thinking = message.usage.output_tokens_details?.thinking_tokens ?? null;
      const tokens = { input: message.usage.input_tokens, cacheWrite: message.usage.cache_creation_input_tokens ?? 0, cacheRead: message.usage.cache_read_input_tokens ?? 0, output: message.usage.output_tokens, thinking, writtenAnswer: thinking === null ? null : message.usage.output_tokens - thinking };
      Object.assign(report, { stopReason: message.stop_reason, usage: message.usage, tokens, costUsd: call.costUsd, llmCallId: call.id, rawOutput: raw });
      const read = message.stop_reason === "end_turn" ? readCrossOutput(raw) : { output: null, error: `stopped with ${message.stop_reason}` };
      // Only a finished answer that says it compared all the testimony is a result. A cut-off answer, a
      // refusal, invalid output, or a self-declared partial review is reported as incomplete, never scored.
      if (read.output && read.output.summary.completion_status === "complete") Object.assign(report, { completion: "complete" }, assess(read.output, loaded, resolvePairs(comparison, loaded)));
      else if (read.output) Object.assign(report, { completion: "partial", error: `the model reported a partial review: ${read.output.summary.limitations.join("; ") || "no reason given"}`, findingsForInspection: assess(read.output, loaded, resolvePairs(comparison, loaded)).findings });
      else Object.assign(report, { completion: message.stop_reason === "max_tokens" ? "truncated" : message.stop_reason === "refusal" ? "refused" : "invalid", error: read.error });
    } else {
      if (result.type === "errored" || result.type === "missing") await closeFailed(db, reservationId, new Error(result.type));
      else await releaseUnbilled(db, reservationId, `batch item ${result.type}`);
      report.error = `batch result: ${result.type}`;
    }
    const file = path.join(REPORTS, `${labels.set}-${c.id}-${name}-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ comparison: c.id, model, effort, maxOutput, promptVersion: PROMPT_VERSION, completion: report.completion ?? "no result", stopReason: report.stopReason ?? null, tokens: report.tokens ?? null, costUsd: report.costUsd ?? null, error: report.error ?? null, score: (report as { score?: unknown }).score ?? null, report: file }, null, 2));
  }
  const [b] = await db.select().from(budgets).where(eq(budgets.id, budget.id));
  console.log(`Spent $${b.spentUsd.toFixed(4)} of $${ceiling.toFixed(2)}, $${b.reservedUsd.toFixed(4)} still reserved.`);
}

async function rescore(file: string) {
  const report = JSON.parse(readFileSync(file, "utf8")) as { set: string; comparison: string; rawOutput: string | null };
  const labelsPath = values.set ?? `data/eval/${report.set}.json`;
  const labels = await readCrossLabelFile(labelsPath);
  const { comparison, loaded } = await loadComparison(labels, values.root!, report.comparison);
  const read = readCrossOutput(report.rawOutput);
  if (!read.output) throw new Error(`The saved output isn't valid: ${read.error}`);
  console.log(JSON.stringify(assess(read.output, loaded, resolvePairs(comparison, loaded)).score, null, 2));
}

async function main() {
  const command = positionals[0];
  const maxOutput = Number(values["max-output"] ?? DEFAULT_MAX_OUTPUT);
  if (command === "score") return rescore(values.report!);
  if (!values.set || !values.root) throw new Error("Pass --set <labels.json> and --root <directory of the documents>.");
  const labels = await readCrossLabelFile(values.set);
  if (command === "estimate") return estimate(labels, values.root, maxOutput);
  if (command !== "run") throw new Error("Commands: estimate, run, score");
  const name = values.model as keyof typeof MODELS;
  if (!MODELS[name]) throw new Error("Pass --model fable, opus or sonnet.");
  const { db, pool } = connect();
  try {
    await run(db, labels, values.root, name, Number(values["approved-usd"]), maxOutput, (values.effort ?? DEFAULT_EFFORT) as "high");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
