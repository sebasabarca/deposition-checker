// The whole-product benchmark on the real U.S. v. Oracle depositions (P3171, P3173).
//
//   npx tsx scripts/benchmark.ts free --run-id <id>
//     Measures the product with no model calls: new case, upload, parse, retrieve, a demo analysis
//     started from a real browser, findings, screenshots, and the live cost estimate. The API and
//     worker it starts get no API key, so a paid call is impossible.
//   npx tsx scripts/benchmark.ts estimate --run-id <id>
//     Only the cost estimate, from the run's stored candidates. No API call.
//   npx tsx scripts/benchmark.ts preflight --run-id <id> [--prompt adjudicate-v3]
//     What a warm full run would evaluate and cost, written to preflight.json. Reads the database and
//     stored calls only; no API call, and it can't see the provider's account balance.
//   npx tsx scripts/benchmark.ts live --run-id <id> --start warm|cold --prompt <v> --candidates <n>
//                                     --approve-usd <max> [--tag-budget-usd <n>] --i-approve-paid-calls
//     PAID. warm: Sonnet on the stored U.S. v. Oracle depositions, reusing stored Haiku claims.
//     cold: Haiku tags the benchmark case's depositions, then Sonnet. Every call reserves its worst
//     case from a stored budget, and the two budgets together never exceed --approve-usd.
//   Adding --dry-run to live runs everything with no API key: the analysis stops at
//   blocked_credentials and nothing is spent.
//
// Everything is written to reports/benchmarks/ellison-full-run/<id>/. state.json records each finished
// stage, so running the same command again resumes and never repeats a stage. Nothing is deleted.
// Port 3001 must be free: the worker of a running `npm run dev` would take this run's jobs.

import "dotenv/config";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, release, totalmem } from "node:os";
import { connect as netConnect } from "node:net";
import path from "node:path";
import { parseArgs } from "node:util";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { assess, formatPacket, loadPacket, maxPacketCost, PROMPT_VERSIONS, PROMPTS, type Packet, type PromptVersion, type Verdict } from "../server/src/adjudicate";
import { ADJUDICATION_MODEL, DEFAULT_PROMPT_VERSION } from "../server/src/adjudicate/prompt";
import { coldCacheCost, expectedPacketCost, measure, measuredSamples } from "../server/src/adjudicate/estimate";
import { batchesOf, CLAIMS_MODEL, EXTRACTION_JSON_SCHEMA, EXTRACTOR_VERSION, formatBatch, partsToTag, SYSTEM_PROMPT } from "../server/src/claims";
import { MAX_OUTPUT_TOKENS as CLAIMS_MAX_OUTPUT } from "../server/src/claims/prompt";
import { callCost, inputTokenBound, maxRequestCost } from "../server/src/costs";
import { connect, type Database } from "../server/src/db/client";
import { adjudicationRequests, analyses, candidates, claims, findings, llmCalls, verdicts } from "../server/src/db/schema";
import { findPathA, findPathB, mergeCandidates, selectCandidates } from "../server/src/retrieve";
import { checkAttribution, checkSources } from "../server/src/verify";
import { openBrowser, type Browser, type BrowserProblem } from "./benchmark-browser";

const API = "http://localhost:3001/api";
const APP = "http://localhost:5273";
const BASE_DIR = "reports/benchmarks/ellison-full-run";
const WITNESS = "Lawrence Ellison";
const STORED_CASE = "U.S. v. Oracle";
const FILES = [
  { key: "P3171", file: "data/raw/ellison/p3171.pdf", takenOn: "2004-01-20" as string | undefined },
  // The transcript states no session date: it refers back to January 20th, 2004 as an earlier session.
  { key: "P3173", file: "data/raw/ellison/p3173.pdf", takenOn: undefined as string | undefined },
];
const API_SAMPLES = 20;
const UI_SAMPLES = 6;
const CHECK_REPEATS = 25;

type Args = { runId: string; start?: "warm" | "cold"; prompt?: PromptVersion; candidates?: number; approveUsd?: number; tagBudgetUsd?: number; approved: boolean; dryRun: boolean };
type Stage = { finishedAt: string; ms: number };
type State = {
  runId: string;
  stages: Record<string, Stage>;
  caseId?: number;
  depositions?: { key: string; id: number }[];
  analysisId?: number;
  live?: { analysisId?: number; tagBudget?: string; startedAt?: string };
  data: Record<string, unknown>;
};
type Problem = { at: string; stage: string; kind: string; message: string };

// ------------------------------------------------------------ small helpers

const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;
const sortedOf = (xs: readonly number[]) => [...xs].sort((a, b) => a - b);
function quantile(xs: readonly number[], q: number): number | null {
  if (xs.length === 0) return null;
  const s = sortedOf(xs);
  const at = (s.length - 1) * q;
  const low = Math.floor(at);
  return round(s[low] + (s[Math.min(low + 1, s.length - 1)] - s[low]) * (at - low));
}
const stats = (xs: readonly number[]) => ({ n: xs.length, min: quantile(xs, 0), median: quantile(xs, 0.5), p95: quantile(xs, 0.95), max: quantile(xs, 1), mean: xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null });
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const usd = (n: number | null | undefined, places = 4) => (n === null || n === undefined ? "n/a" : `$${n.toFixed(places)}`);
const secs = (ms: number | null | undefined) => (ms === null || ms === undefined ? "n/a" : `${(ms / 1000).toFixed(2)} s`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readArgs(): { command: string; args: Args } {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "run-id": { type: "string" },
      start: { type: "string" },
      prompt: { type: "string" },
      candidates: { type: "string" },
      "approve-usd": { type: "string" },
      "tag-budget-usd": { type: "string" },
      "i-approve-paid-calls": { type: "boolean" },
      "dry-run": { type: "boolean" },
    },
  });
  const command = positionals[0] ?? "";
  const runId = values["run-id"] ?? "";
  if (!["free", "estimate", "live", "preflight"].includes(command) || !/^[a-z0-9][a-z0-9-]{2,60}$/.test(runId)) {
    throw new Error("Usage: npx tsx scripts/benchmark.ts free|estimate|preflight|live --run-id <lowercase-id> (see the top of this file)");
  }
  if (values.prompt && !PROMPT_VERSIONS.includes(values.prompt as PromptVersion)) throw new Error(`--prompt must be one of ${PROMPT_VERSIONS.join(", ")}.`);
  return {
    command,
    args: {
      runId,
      start: values.start as Args["start"],
      prompt: values.prompt as PromptVersion | undefined,
      candidates: values.candidates ? Number(values.candidates) : undefined,
      approveUsd: values["approve-usd"] ? Number(values["approve-usd"]) : undefined,
      tagBudgetUsd: values["tag-budget-usd"] ? Number(values["tag-budget-usd"]) : undefined,
      approved: values["i-approve-paid-calls"] === true,
      dryRun: values["dry-run"] === true,
    },
  };
}

class Run {
  dir: string;
  state: State;
  problems: Problem[];
  constructor(public runId: string) {
    this.dir = path.join(BASE_DIR, runId);
    mkdirSync(path.join(this.dir, "screenshots"), { recursive: true });
    mkdirSync(path.join(this.dir, "logs"), { recursive: true });
    const file = path.join(this.dir, "state.json");
    this.state = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as State) : { runId, stages: {}, data: {} };
    const errors = path.join(this.dir, "errors.json");
    this.problems = existsSync(errors) ? (JSON.parse(readFileSync(errors, "utf8")) as { problems: Problem[] }).problems : [];
  }
  get timingFile() {
    return path.resolve(this.dir, "timings.jsonl");
  }
  save() {
    writeFileSync(path.join(this.dir, "state.json"), `${JSON.stringify(this.state, null, 2)}\n`);
  }
  json(name: string, value: unknown) {
    writeFileSync(path.join(this.dir, name), `${JSON.stringify(value, null, 2)}\n`);
  }
  problem(stage: string, kind: string, message: string) {
    this.problems.push({ at: new Date().toISOString(), stage, kind, message: message.slice(0, 2000) });
    this.json("errors.json", { problems: this.problems });
  }
  async stage(name: string, work: () => Promise<void>) {
    if (this.state.stages[name]) return console.log(`· ${name}: already done`);
    const started = performance.now();
    console.log(`→ ${name}`);
    try {
      await work();
    } catch (error) {
      this.problem(name, "stage_failed", error instanceof Error ? (error.stack ?? error.message) : String(error));
      throw error;
    }
    this.state.stages[name] = { finishedAt: new Date().toISOString(), ms: round(performance.now() - started) };
    this.save();
    console.log(`  ${name}: ${secs(this.state.stages[name].ms)}`);
  }
  timings() {
    if (!existsSync(this.timingFile)) return [];
    return readFileSync(this.timingFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { stage: string; ms: number; at: string; analysisId?: number });
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<{ status: number; ms: number; data: T }> {
  const started = performance.now();
  const res = await fetch(`${API}${url}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = (await res.json()) as T;
  return { status: res.status, ms: performance.now() - started, data };
}

// ------------------------------------------------------------ the application under test

type Stack = { stop: () => Promise<void> };

function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect(port, "127.0.0.1");
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => resolve(false));
  });
}

// Starts the API, the worker and the production client build as this run's own processes. Paid calls
// are off unless `paid` is true: the key is blanked (dotenv doesn't replace a variable already set).
async function startStack(run: Run, paid: boolean): Promise<Stack> {
  for (const port of [3001, 5273]) if (await portBusy(port)) throw new Error(`Port ${port} is in use. Stop \`npm run dev\` first: its worker would take this run's jobs.`);
  const env = { ...process.env, BENCHMARK_TIMING_FILE: run.timingFile, ...(paid ? { ALLOW_PAID_CALLS: "true" } : { ALLOW_PAID_CALLS: "false", ANTHROPIC_API_KEY: "" }) };
  const start = (name: string, command: string, args: string[], cwd = ".") => {
    const log = createWriteStream(path.join(run.dir, "logs", `${name}.log`), { flags: "a" });
    const child = spawn(command, args, { env, cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    return child;
  };
  const children: ChildProcess[] = [
    start("api", "npx", ["tsx", "server/src/index.ts"]),
    start("worker", "npx", ["tsx", "server/src/worker.ts"]),
    start("client", "npx", ["vite", "preview", "--port", "5273", "--strictPort"], "client"),
  ];
  const stop = async () => {
    for (const c of children) if (c.pid) try { process.kill(-c.pid, "SIGTERM"); } catch { /* already gone */ }
    await sleep(1000);
  };
  process.once("SIGINT", () => void stop().then(() => process.exit(130)));
  process.once("SIGTERM", () => void stop().then(() => process.exit(143)));
  for (let i = 0; i < 300; i++) {
    const up = await Promise.all([fetch(`${API}/cases`).then((r) => r.ok, () => false), fetch(APP).then((r) => r.ok, () => false), Promise.resolve(existsSync(path.join(run.dir, "logs", "worker.log")) && readFileSync(path.join(run.dir, "logs", "worker.log"), "utf8").includes("Worker running"))]);
    if (up.every(Boolean)) return { stop };
    await sleep(100);
  }
  await stop();
  throw new Error("The application did not start; see the logs folder.");
}

// ------------------------------------------------------------ database facts

async function counts(db: Database) {
  const row = await db.execute<Record<string, number>>(sql`select
    (select count(*)::int from cases) as cases, (select count(*)::int from depositions) as depositions, (select count(*)::int from analyses) as analyses,
    (select count(*)::int from verdicts) as verdicts, (select count(*)::int from verdicts where origin = 'model') as model_verdicts, (select count(*)::int from findings) as findings,
    (select count(*)::int from claims) as claims, (select count(*)::int from llm_calls) as llm_calls, (select coalesce(sum(cost_usd), 0)::float from llm_calls) as llm_cost_usd`);
  return row.rows[0];
}

async function usageOf(db: Database, condition: ReturnType<typeof sql>) {
  const rows = await db.execute<{ stage: string; model: string; calls: number; items: number; input: number; output: number; cache_write: number; cache_read: number; thinking: number | null; thinking_reported: number; cost: number | null; unpriced: number }>(sql`
    select stage::text, model, count(*)::int calls, sum(items)::int items, sum(input_tokens)::int input, sum(output_tokens)::int output,
      sum(cache_write_5m_tokens + cache_write_1h_tokens)::int cache_write, sum(cache_read_tokens)::int cache_read, sum(thinking_tokens)::int thinking,
      count(thinking_tokens)::int thinking_reported, sum(cost_usd)::float cost, (count(*) filter (where cost_usd is null))::int unpriced
    from llm_calls l where ${condition} group by 1, 2 order by 1`);
  return rows.rows;
}

// ------------------------------------------------------------ the free stages

async function uploadStage(run: Run) {
  const { state } = run;
  const results: Record<string, unknown>[] = [];
  state.depositions = [];
  for (const f of FILES) {
    const body = readFileSync(f.file);
    const started = performance.now();
    const query = new URLSearchParams({ witness: WITNESS, filename: path.basename(f.file).toUpperCase().replace(".PDF", ".pdf"), ...(f.takenOn ? { takenOn: f.takenOn } : {}) });
    const res = await fetch(`${API}/cases/${state.caseId}/depositions?${query}`, { method: "POST", headers: { "content-type": "application/pdf" }, body });
    const uploaded = (await res.json()) as { created: boolean; deposition: { id: number } };
    const uploadMs = performance.now() - started;
    if (res.status !== 202 && res.status !== 200) throw new Error(`Upload of ${f.key} answered ${res.status}: ${JSON.stringify(uploaded)}`);
    const id = uploaded.deposition.id;
    let view: Record<string, unknown> & { status: string; stored: Record<string, number> };
    for (;;) {
      ({ deposition: view } = (await call<{ deposition: typeof view }>("GET", `/depositions/${id}`)).data);
      if (view.status !== "processing") break;
      if (performance.now() - started > 120_000) throw new Error(`${f.key} was still processing after 2 minutes.`);
      await sleep(25);
    }
    const processedMs = performance.now() - started;
    if (view.status !== "ready") run.problem("upload", "deposition_not_ready", `${f.key}: ${view.status}`);
    // The same bytes again must be recognised and queue nothing.
    const again = await fetch(`${API}/cases/${state.caseId}/depositions?${query}`, { method: "POST", headers: { "content-type": "application/pdf" }, body });
    const duplicate = (await again.json()) as { created: boolean };
    results.push({ key: f.key, depositionId: id, bytes: body.length, created: uploaded.created, status: view.status, pageCount: view.pageCount, needsOcrPages: view.needsOcrPages, blankPages: view.blankPages, stored: view.stored, validation: view.validation, uploadRequestMs: round(uploadMs), uploadToReadyMs: round(processedMs), duplicateRejected: again.status === 200 && duplicate.created === false });
    state.depositions.push({ key: f.key, id });
  }
  state.data.upload = results;
}

async function startFromBrowser(run: Run, browser: Browser) {
  const { page } = browser;
  const { state } = run;
  const shots = path.join(run.dir, "screenshots");
  const before = (await call<{ analyses: { id: number }[] }>("GET", `/cases/${state.caseId}/analyses`)).data.analyses.map((a) => a.id);
  const pageLoadMs = await page.load(`${APP}/#/cases/${state.caseId}`, `[...document.querySelectorAll("button")].some((b) => b.textContent === "Start analysis" && !b.disabled)`);
  await page.screenshot(path.join(shots, "1-case-overview.png"));

  const clickedAt = new Date();
  const started = performance.now();
  await page.click(`[...document.querySelectorAll("button")].find((b) => b.textContent === "Start analysis")`);
  const routeMs = await page.waitFor(`location.hash.startsWith("#/analyses/")`, 10_000, started);
  await page.waitFor(`[...document.querySelectorAll("li")].some((l) => l.textContent.includes("Read both depositions"))`);
  await page.screenshot(path.join(shots, "2-analysis-progress.png"));
  const id = Number((await page.eval<string>("location.hash")).match(/analyses\/(\d+)/)![1]);
  if (before.includes(id)) throw new Error(`Analysis ${id} is not new.`);
  state.analysisId = id;
  run.save();

  // Watches the analysis as the page does, recording when each status is first seen.
  const seen: Record<string, number> = {};
  for (;;) {
    const { analysis } = (await call<{ analysis: { status: string } }>("GET", `/analyses/${id}`)).data;
    seen[analysis.status] ??= round(performance.now() - started);
    if (["completed", "failed", "blocked_budget", "blocked_credentials"].includes(analysis.status)) break;
    if (performance.now() - started > 600_000) throw new Error("The analysis was still running after 10 minutes.");
    await sleep(20);
  }
  state.data.start = { clickedAt: clickedAt.toISOString(), caseHardLoadMs: round(pageLoadMs), clickToAnalysisPageMs: round(routeMs), statusFirstSeenMs: seen };
  if (seen.failed !== undefined || seen.blocked_budget !== undefined) run.problem("analysis", "analysis_stopped", JSON.stringify(seen));
}

type FindingRow = { id: number; group: string };

async function measureDelivery(run: Run, browser: Browser, analysisId: number) {
  const { page } = browser;
  const shots = path.join(run.dir, "screenshots");
  const listTimes: number[] = [];
  let groups: { group: string; label: string; findings: FindingRow[] }[] = [];
  for (let i = 0; i < API_SAMPLES; i++) {
    const r = await call<{ groups: typeof groups }>("GET", `/analyses/${analysisId}/findings`);
    listTimes.push(r.ms);
    groups = r.data.groups;
  }
  const ids = groups.flatMap((g) => g.findings.map((f) => f.id));
  const detailTimes: number[] = [];
  const details: unknown[] = [];
  for (const id of ids) {
    const r = await call<{ finding: unknown }>("GET", `/findings/${id}`);
    detailTimes.push(r.ms);
    details.push(r.data.finding);
  }
  const statusTimes: number[] = [];
  for (let i = 0; i < API_SAMPLES; i++) statusTimes.push((await call("GET", `/analyses/${analysisId}`)).ms);

  const listTest = `document.querySelectorAll('nav[aria-label="Findings"] a').length === ${ids.length}`;
  const listRender: number[] = [];
  const compareRender: number[] = [];
  if (ids.length > 0) {
    for (let i = 0; i < UI_SAMPLES; i++) listRender.push(await page.load(`${APP}/#/analyses/${analysisId}`, listTest));
    await page.waitFor(`document.querySelector("article ol li")`);
    await page.screenshot(path.join(shots, "3-findings-list.png"));
    for (let i = 0; i < UI_SAMPLES; i++) {
      const id = ids[i % ids.length];
      const started = performance.now();
      await page.click(`document.querySelector('nav[aria-label="Findings"] a[href$="/findings/${id}"]')`);
      compareRender.push(await page.waitFor(`document.querySelector('article[aria-labelledby="finding-${id}"] ol li')`, 10_000, started));
    }
    const best = groups.flatMap((g) => g.findings)[0]; // sections are in review order
    await page.click(`document.querySelector('nav[aria-label="Findings"] a[href$="/findings/${best.id}"]')`);
    await page.waitFor(`document.querySelector('article[aria-labelledby="finding-${best.id}"] ol li')`);
    await page.screenshot(path.join(shots, "4-side-by-side-evidence.png"));
  } else {
    await page.load(`${APP}/#/analyses/${analysisId}`, `document.body.textContent.includes("Findings ready")`);
    await page.screenshot(path.join(shots, "3-findings-list.png"));
    run.problem("delivery", "no_findings", "The analysis has no findings, so the list and the side-by-side view could not be measured.");
  }
  return {
    groups,
    details,
    timing: {
      findingsListApiMs: stats(listTimes),
      findingDetailApiMs: stats(detailTimes),
      analysisStatusApiMs: stats(statusTimes),
      findingsListRenderHardLoadMs: stats(listRender),
      sideBySideRenderMs: stats(compareRender),
    },
  };
}

// Retrieval on the stored U.S. v. Oracle depositions, which hold the Haiku claims. Reads only.
async function storedDualPath(db: Database) {
  const [row] = (await db.execute<{ case_id: string; witness_id: string; a: string; b: string }>(sql`
    select c.id case_id, w.id witness_id, min(d.id) a, max(d.id) b from cases c join witnesses w on w.case_id = c.id join depositions d on d.witness_id = w.id
    where c.name = ${STORED_CASE} and w.name = ${WITNESS} and d.status = 'ready' group by 1, 2`)).rows;
  const [witnessId, depositionA, depositionB] = [Number(row.witness_id), Number(row.a), Number(row.b)];
  const pair = new Set([depositionA, depositionB]);
  const within = (x: { a: { depositionId: number }; b: { depositionId: number } }) => pair.has(x.a.depositionId) && pair.has(x.b.depositionId);
  const time = async <T>(f: () => Promise<T> | T) => {
    const started = performance.now();
    const value = await f();
    return { value, ms: round(performance.now() - started) };
  };
  const a = await time(() => findPathA(db, { witnessId, depositionId: depositionB, extractorVersion: EXTRACTOR_VERSION }));
  const b = await time(() => findPathB(db, { witnessId, depositionId: depositionB, mode: "rare_terms" }));
  const pathA = a.value.filter(within);
  const pathB = b.value.pairs.filter(within);
  const merged = await time(() => {
    const m = mergeCandidates({ claims: pathA, fulltext: pathB });
    return { merged: m, chosen: selectCandidates(m, { budget: 300 }) };
  });
  const both = merged.value.merged.filter((c) => c.sources.length > 1).length;
  const claimStatus = await db.select({ status: claims.status, n: sql<number>`count(*)::int` }).from(claims).where(and(eq(claims.witnessId, witnessId), eq(claims.extractorVersion, EXTRACTOR_VERSION))).groupBy(claims.status);
  return {
    label: "Path A + Path B on the stored depositions, reusing stored Haiku claims (read-only; nothing was written)",
    deposition: { a: depositionA, b: depositionB },
    extractorVersion: EXTRACTOR_VERSION,
    extractedClaims: sum(claimStatus.map((c) => c.n)),
    claimsByStatus: Object.fromEntries(claimStatus.map((c) => [c.status, c.n])),
    eligibleClaims: sum(claimStatus.filter((c) => c.status !== "rejected").map((c) => c.n)),
    pathACandidates: pathA.length,
    pathBCandidates: pathB.length,
    overlapBothPaths: both,
    pathAOnly: merged.value.merged.length - pathB.length,
    mergedUnique: merged.value.merged.length,
    selected: merged.value.chosen.selected.length,
    deferred: merged.value.chosen.deferred.length,
    deferredByReason: { cap: merged.value.chosen.deferred.filter((d) => d.reason === "cap").length, budget: merged.value.chosen.deferred.filter((d) => d.reason === "budget").length },
    timingMs: { pathA: a.ms, pathB: b.ms, mergeRank: merged.ms },
  };
}

async function retrievalOf(db: Database, analysisId: number) {
  const set = `analysis-${analysisId}`;
  const rows = await db.select({ status: candidates.status, sources: candidates.sources, id: candidates.id }).from(candidates).where(eq(candidates.candidateSet, set));
  const live = rows.filter((r) => r.status !== "deferred");
  const [verdictCount] = (await db.execute<{ n: number }>(sql`select count(*)::int n from verdicts v join candidates c on c.id = v.candidate_id where c.candidate_set = ${set}`)).rows;
  const has = (r: (typeof rows)[number], s: string) => r.sources.includes(s);
  return {
    candidateSet: set,
    pathACandidates: rows.filter((r) => has(r, "claims")).length,
    pathBCandidates: rows.filter((r) => has(r, "fulltext")).length,
    overlapBothPaths: rows.filter((r) => has(r, "claims") && has(r, "fulltext")).length,
    mergedUnique: rows.length,
    selected: live.length,
    deferred: rows.length - live.length,
    assessedWithAVerdict: verdictCount.n,
    selectedWithoutVerdict: live.length - verdictCount.n,
  };
}

// Times code's checks on this run's verdicts. They are pure, so a repeat is the same work: Layer 1
// (source), Layer 2 (attribution) and the rest of assess() (consistency, corroboration, score, priority).
async function checkTimings(db: Database, analysisId: number) {
  const rows = await db.select({ candidateId: verdicts.candidateId, parsed: verdicts.parsed }).from(verdicts).innerJoin(candidates, eq(candidates.id, verdicts.candidateId)).where(and(eq(candidates.candidateSet, `analysis-${analysisId}`), eq(verdicts.status, "valid")));
  const source: number[] = [];
  const attribution: number[] = [];
  const whole: number[] = [];
  for (const r of rows) {
    const packet = await loadPacket(db, r.candidateId);
    const v = r.parsed as Verdict;
    const evidence = { witnessId: packet.witnessId, a: { id: packet.a.id, witnessId: packet.a.witnessId, lines: packet.a.lines, context: [...packet.a.before, ...packet.a.after] }, b: { id: packet.b.id, witnessId: packet.b.witnessId, lines: packet.b.lines, context: [...packet.b.before, ...packet.b.after] } };
    for (let i = 0; i < CHECK_REPEATS; i++) {
      const t0 = performance.now();
      const checked = checkSources(v, evidence);
      const t1 = performance.now();
      checkAttribution(v, checked);
      const t2 = performance.now();
      assess(packet, v);
      const t3 = performance.now();
      source.push(t1 - t0);
      attribution.push(t2 - t1);
      whole.push(t3 - t2);
    }
  }
  const median = (xs: number[]) => (xs.length ? round(sortedOf(xs)[Math.floor(xs.length / 2)], 3) : null);
  return { verdicts: rows.length, repeats: CHECK_REPEATS, sourceVerificationMsPerVerdict: median(source), attributionVerificationMsPerVerdict: median(attribution), assessWholeMsPerVerdict: median(whole), note: "Median CPU time of the pure checks, replayed in this process; assessWhole includes source, attribution, consistency, score and priority." };
}

// ------------------------------------------------------------ the estimate

async function estimateRun(db: Database, run: Run) {
  const packetsOf = async (set: string) => {
    const rows = await db.select({ id: candidates.id }).from(candidates).where(and(eq(candidates.candidateSet, set), sql`${candidates.status} <> 'deferred'`)).orderBy(asc(candidates.mergedRank));
    const texts: string[] = [];
    for (const r of rows) texts.push(formatPacket((await loadPacket(db, r.id)) as Packet));
    return texts;
  };
  const sets: Record<string, string[]> = {};
  if (run.state.analysisId) sets[`Path B only (benchmark case, analysis ${run.state.analysisId})`] = await packetsOf(`analysis-${run.state.analysisId}`);
  sets["Path A + Path B (stored depositions, set ellison-v1)"] = await packetsOf("ellison-v1");

  const model = ADJUDICATION_MODEL;
  const adjudication: unknown[] = [];
  for (const version of PROMPT_VERSIONS) {
    // v3 has never been called, so it is priced with v2's measured rates and its own prompt length.
    const basis = (await measuredSamples(db, model, version)).length >= 4 ? version : "adjudicate-v2";
    const measured = measure(await measuredSamples(db, model, basis));
    if (!measured) continue;
    const scale = (PROMPTS[version].system.length + JSON.stringify(PROMPTS[version].jsonSchema).length) / (PROMPTS[basis].system.length + JSON.stringify(PROMPTS[basis].jsonSchema).length);
    const m = { ...measured, promptTokens: Math.round(measured.promptTokens * scale) };
    for (const [name, texts] of Object.entries(sets)) {
      const expected = texts.map((t) => expectedPacketCost(model, t.length, m)!);
      const worst = texts.map((t) => maxPacketCost(model, t, version));
      const median = sum(expected.map((e) => e.median));
      const high = sum(expected.map((e) => e.high));
      const cold = coldCacheCost(model, m) ?? 0;
      adjudication.push({
        prompt: version,
        pricedFrom: basis,
        measuredCalls: m.calls,
        candidateSet: name,
        calls: texts.length,
        packetChars: stats(texts.map((t) => t.length)),
        expectedUsdAtMedianOutput: round(median + cold, 4),
        expectedUsdAtLargestMeasuredOutput: round(high + cold, 4),
        worstCaseUsdEveryCallAtMaxTokens: round(sum(worst), 4),
        largestSingleReservationUsd: round(Math.max(...worst), 4),
        expectedUsdPerCall: round((median + cold) / texts.length, 5),
      });
    }
  }

  // Haiku over every testimony part of the benchmark depositions (none are tagged yet).
  const schemaChars = JSON.stringify(EXTRACTION_JSON_SCHEMA).length;
  const tagging: { depositionKey: string; parts: number; batches: number; worstCaseUsd: number; largestReservationUsd: number }[] = [];
  for (const d of run.state.depositions ?? []) {
    const { parts } = await partsToTag(db, d.id);
    const batches = batchesOf(parts);
    const worst = batches.map((b) => maxRequestCost(CLAIMS_MODEL, { inputTokens: inputTokenBound(SYSTEM_PROMPT.length + schemaChars + formatBatch(b).length), maxOutputTokens: CLAIMS_MAX_OUTPUT }));
    tagging.push({ depositionKey: d.key, parts: parts.length, batches: batches.length, worstCaseUsd: round(sum(worst), 4), largestReservationUsd: round(Math.max(0, ...worst), 4) });
  }
  const [measuredTag] = (await db.execute<{ calls: number; parts: number; cost: number }>(sql`
    select count(*)::int calls, sum(items)::int parts, sum(cost_usd)::float cost from llm_calls l
    where stage = 'claim_tagging' and exists (select 1 from claim_tagging t where t.llm_call_id = l.id and t.extractor_version = ${EXTRACTOR_VERSION})`)).rows;
  const gaps = (await db.execute<{ ms: number }>(sql`
    select extract(epoch from created_at - lag(created_at) over (order by created_at)) * 1000 as ms from llm_calls where stage = 'claim_tagging'`)).rows.map((r) => Number(r.ms)).filter((x) => x > 0 && x < 60_000);
  const totalParts = sum(tagging.map((t) => t.parts));
  const expectedTag = totalParts * (measuredTag.cost / measuredTag.parts);

  const sonnetLatency = (await db.execute<{ ms: number }>(sql`select latency_ms ms from llm_calls where stage = 'adjudication' and latency_ms is not null`)).rows.map((r) => r.ms);
  return {
    note: "Estimates only. Nothing here was charged. Expected figures use measured calls; worst-case figures assume every call uses all of max_tokens, which the stored budget caps.",
    prices: { source: "server/src/costs/pricing.ts", sonnetPerMTok: "input 2, cache write 2.50, cache read 0.10, output 10", haikuPerMTok: "input 0.10, cache write 0.125, cache read 0.01, output 0.50 (prompts up to 100k tokens)" },
    adjudication,
    tagging: {
      extractorVersion: EXTRACTOR_VERSION,
      perDeposition: tagging,
      totalParts,
      totalBatches: sum(tagging.map((t) => t.batches)),
      worstCaseUsd: round(sum(tagging.map((t) => t.worstCaseUsd)), 4),
      largestReservationUsd: Math.max(0, ...tagging.map((t) => t.largestReservationUsd)),
      measured: { ...measuredTag, usdPerPart: round(measuredTag.cost / measuredTag.parts, 6) },
      expectedUsd: round(expectedTag, 4),
      secondsBetweenRecordedCalls: stats(gaps.map((g) => g / 1000)),
      timingNote: "Haiku latency was not recorded historically; these are gaps between recorded calls in earlier CLI runs, so they include code's verification and any pause.",
    },
    sonnetMeasuredLatencyMs: stats(sonnetLatency),
    uncappedAllCandidates: "selection caps a two-session analysis at 300 pairs; the rest stay deferred and counted.",
    accountBalance: "Unknown. The Messages API does not report a balance and no call was made to find out; check the Console billing page before approving.",
  };
}

// ------------------------------------------------------------ preflight

// What a warm full run would do, from stored rows and recorded calls. No API call.
async function preflight(db: Database, run: Run, prompt: PromptVersion) {
  const dual = await storedDualPath(db);
  const { a: depositionA, b: depositionB } = dual.deposition;
  const [{ case_id: caseId }] = (await db.execute<{ case_id: string }>(sql`select case_id from depositions where id = ${depositionA}`)).rows;
  const pair = new Set([depositionA, depositionB]);
  const within = (x: { a: { depositionId: number }; b: { depositionId: number } }) => pair.has(x.a.depositionId) && pair.has(x.b.depositionId);
  const [{ witness_id: witness }] = (await db.execute<{ witness_id: string }>(sql`select witness_id from depositions where id = ${depositionA}`)).rows;
  const witnessId = Number(witness);
  const pathA = (await findPathA(db, { witnessId, depositionId: depositionB, extractorVersion: EXTRACTOR_VERSION })).filter(within);
  const pathB = (await findPathB(db, { witnessId, depositionId: depositionB, mode: "rare_terms" })).pairs.filter(within);
  const { selected } = selectCandidates(mergeCandidates({ claims: pathA, fulltext: pathB }), { budget: 300 });
  const key = (x: { depositionA: number; groupA: number; depositionB: number; groupB: number }) => `${x.depositionA}:${x.groupA}|${x.depositionB}:${x.groupB}`;
  const selectedPairs = selected.map((c) => ({ rank: c.rank, sources: c.sources, depositionA: c.a.depositionId, groupA: c.a.groupId, depositionB: c.b.depositionId, groupB: c.b.groupId }));

  // The stored set with the same pairs, if retrieval still selects it: its rows give the packets.
  const stored = await db.select().from(candidates).where(and(eq(candidates.candidateSet, "ellison-v1"), sql`${candidates.status} <> 'deferred'`)).orderBy(asc(candidates.mergedRank));
  const storedKeys = new Set(stored.map(key));
  const matching = selectedPairs.filter((p) => storedKeys.has(key(p))).length;
  const groupKeys = selectedPairs.map(key);
  const prior = (await db.execute<{ prompt_version: string; origin: string; n: number; pairs: number }>(sql`
    select v.prompt_version, v.origin, count(*)::int n, count(distinct (c.group_a, c.group_b))::int pairs from verdicts v join candidates c on c.id = v.candidate_id
    where c.deposition_a = ${depositionA} and c.deposition_b = ${depositionB} and (c.deposition_a || ':' || c.group_a || '|' || c.deposition_b || ':' || c.group_b) in (${sql.join(groupKeys.map((k) => sql`${k}`), sql`, `)})
    group by 1, 2 order by 1, 2`)).rows;
  const existing = (await db.select({ id: analyses.id, mode: analyses.mode, status: analyses.status, prompt: analyses.promptVersion }).from(analyses).where(eq(analyses.caseId, Number(caseId))).orderBy(asc(analyses.id)));

  // Measured v3 rates on real Ellison pairs only, from the live strategy comparison.
  const ellison = (await db.execute<{ input: number; output: number; read: number; cost: number; latency: number; chars: number }>(sql`
    select l.input_tokens input, l.output_tokens output, l.cache_read_tokens read, l.cost_usd::float cost, l.latency_ms latency, 0 chars
    from verdicts v join candidates c on c.id = v.candidate_id join llm_calls l on l.id = v.llm_call_id
    where c.candidate_set in ('exp-strategies-1-B', 'exp-strategies-1-C') and (c.evidence->0->>'sourceCandidateId')::bigint in (select id from candidates where candidate_set = 'ellison-v1')`)).rows;
  const texts: string[] = [];
  for (const c of stored) texts.push(formatPacket(await loadPacket(db, c.id)));
  const sampleIds = (await db.execute<{ id: string }>(sql`select id from candidates where candidate_set = 'exp-strategies-1-C' and (evidence->0->>'sourceCandidateId')::bigint in (select id from candidates where candidate_set = 'ellison-v1')`)).rows.map((r) => Number(r.id));
  const sampleChars: number[] = [];
  for (const id of sampleIds) sampleChars.push(formatPacket(await loadPacket(db, id)).length);
  const scaledUp = sum(texts.map((t) => t.length)) / (sum(sampleChars) / sampleChars.length) / texts.length;
  const perPair = sum(ellison.map((e) => e.cost)) / ellison.length;
  const outputs = ellison.map((e) => e.output);
  const reads = quantile(ellison.map((e) => e.read), 0.5) ?? 0;
  const inputPerChar = sum(ellison.map((e) => e.input)) / (ellison.length / sampleChars.length) / sum(sampleChars); // each pair ran under two strategies
  const costAt = (output: number) => sum(texts.map((t) => callCost(ADJUDICATION_MODEL, { input: Math.round(t.length * inputPerChar), output, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: reads })!.costUsd));
  const worst = texts.map((t) => maxPacketCost(ADJUDICATION_MODEL, t, prompt));
  const peakReserved = sum([...worst].sort((a, b) => b - a).slice(0, 10));
  const coldWrite = callCost(ADJUDICATION_MODEL, { input: 0, output: 0, cacheWrite5m: reads, cacheWrite1h: 0, cacheRead: 0 })!.costUsd;
  const expected = { atMeanOutput: round(costAt(sum(outputs) / outputs.length) + coldWrite, 2), atP95Output: round(costAt(quantile(outputs, 0.95)!) + coldWrite, 2), atLargestOutput: round(costAt(Math.max(...outputs)) + coldWrite, 2) };
  const budgetToKeepTenRunning = Math.ceil((expected.atLargestOutput + peakReserved) * 10) / 10;

  const spend = await usageOf(db, sql`true`);
  const reservations = (await db.execute<{ status: string; n: number; usd: number }>(sql`select status::text, count(*)::int n, sum(max_usd)::float usd from budget_reservations group by 1 order by 1`)).rows;
  const value = {
    note: "No API call was made. Estimates, not charges. Application records are not the provider's balance.",
    analysis: { willCreateNew: true, candidateSet: "analysis-<new id>", existingInCase: existing, existingUnchanged: "New verdicts go on new candidate rows in the new set. v1 verdicts and earlier analyses are not touched." },
    candidates: { selected: selected.length, identifiedBy: "deposition, exchange group and rank; candidate row IDs are assigned when the analysis starts", sameAsStoredSetEllisonV1: matching, list: selectedPairs },
    retrieval: { paths: dual.pathACandidates > 0 ? "Path A + Path B" : "Path B only", claims: "reused, not re-extracted (warm start)", extractorVersion: dual.extractorVersion, extractedClaims: dual.extractedClaims, eligibleClaims: dual.eligibleClaims, pathA: dual.pathACandidates, pathB: dual.pathBCandidates, overlap: dual.overlapBothPaths, merged: dual.mergedUnique, deferred: dual.deferred, selectedBySource: { pathAOnly: selected.filter((c) => c.sources.length === 1 && c.sources[0] === "claims").length, pathBOnly: selected.filter((c) => c.sources.length === 1 && c.sources[0] === "fulltext").length, both: selected.filter((c) => c.sources.length === 2).length } },
    promptVersions: { thisRun: prompt, priorVerdictsOnTheseExchangePairs: prior, mixing: "None. Prior verdicts are not reused: all 300 pairs are sent fresh under this one prompt, and a resume keeps the analysis's prompt." },
    spending: { applicationBudget: "Each analysis has its own budget; there is no account-wide application budget. This run's is whatever --approve-usd sets.", outstandingReservations: reservations.find((r) => r.status === "reserved") ?? { n: 0, usd: 0 }, reservations, historicalRecordedUsd: round(sum(spend.map((u) => u.cost ?? 0)), 4), historicalUncertainUsd: round(reservations.find((r) => r.status === "uncertain")?.usd ?? 0, 4), byStage: spend },
    cost: {
      basis: `${ellison.length} real v3 calls on Ellison pairs; packets for the full set are ${round(scaledUp, 2)}x their average length`,
      measuredPerPairUsd: round(perPair, 5),
      expectedUsd: expected,
      conservativeMaximumIfEveryCallUsedMaxTokensUsd: round(sum(worst), 2),
      largestReservationUsd: round(Math.max(...worst), 4),
      peakReservedAtConcurrency10Usd: round(peakReserved, 2),
      recommendedBudgetUsd: budgetToKeepTenRunning,
      budgetNote: "The budget is the hard ceiling. A lower one still finishes if spending stays under it: concurrency falls near the end, and the run stops cleanly only when one more request can't be reserved.",
    },
    timing: { measuredMedianLatencyMs: quantile(ellison.map((e) => e.latency), 0.5), projectedMinutesAt10: round((((quantile(ellison.map((e) => e.latency), 0.5) ?? 0) * 300) / 10 / 60000) * 1.1, 1), caveat: "No sustained run has happened at this concurrency; rate limits are unknown." },
    accountBalance: { verifiable: false, reason: "The Messages API doesn't report credit, and no call was made. Check the Console billing page." },
  };
  run.json("preflight.json", value);
  const { list: _list, ...shown } = value.candidates;
  console.log(JSON.stringify({ ...value, candidates: shown, spending: { ...value.spending, byStage: undefined } }, null, 1));
}

// ------------------------------------------------------------ reports

// The full-run record of one analysis: what the requests did, and what came of them.
async function requestMeasures(db: Database, run: Run, analysisId: number, createdAt: string, delivery: Bundle["delivery"]) {
  const set = `analysis-${analysisId}`;
  const requests = await db.select().from(adjudicationRequests).where(eq(adjudicationRequests.candidateSet, set));
  const ids = requests.flatMap((r) => (r.llmCallId ? [r.llmCallId] : []));
  const calls = ids.length ? await db.select().from(llmCalls).where(inArray(llmCalls.id, ids)) : [];
  const events = requests.flatMap((r) => [[r.startedAt.getTime(), 1], [(r.finishedAt ?? r.startedAt).getTime(), -1]]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let open = 0;
  let peak = 0;
  for (const [, change] of events) peak = Math.max(peak, (open += change));
  const found = await db.select({ f: findings }).from(findings).innerJoin(candidates, eq(candidates.id, findings.candidateId)).where(eq(candidates.candidateSet, set));
  const since = new Date(createdAt).getTime();
  const earliest = (xs: typeof found) => (xs.length ? Math.min(...xs.map((r) => r.f.createdAt.getTime())) - since : null);
  const usd = sum(calls.map((c) => c.costUsd ?? 0));
  const tokens = (f: (c: (typeof calls)[number]) => number) => sum(calls.map(f));
  const unverified = found.filter((r) => !["verified", "approximate"].includes(r.f.evidenceStatus));
  const count = (g: string) => delivery.groups.find((x) => x.group === g)?.findings.length ?? 0;

  // Every model answer with its source references, for checking any finding against what was sent.
  const raw = await db.select({ v: verdicts, c: candidates }).from(verdicts).innerJoin(candidates, eq(candidates.id, verdicts.candidateId)).where(eq(candidates.candidateSet, set));
  writeFileSync(path.join(run.dir, "raw-verdicts.jsonl"), raw.map(({ v, c }) => JSON.stringify({ verdictId: v.id, candidateId: c.id, rank: c.mergedRank, sources: c.sources, depositionA: c.depositionA, groupA: c.groupA, depositionB: c.depositionB, groupB: c.groupB, status: v.status, promptVersion: v.promptVersion, model: v.model, llmCallId: v.llmCallId, requestId: v.requestId, error: v.error, raw: v.raw, packet: v.packet })).join("\n") + "\n");

  return {
    timeToFirstVerifiedFindingMs: earliest(found.filter((r) => ["verified", "approximate"].includes(r.f.evidenceStatus))),
    timeToFirstPotentialContradictionMs: earliest(found.filter((r) => ["direct", "inferential"].includes(r.f.type))),
    measuredFrom: "analysis created",
    apiLatencyMs: stats(calls.flatMap((c) => (c.latencyMs === null ? [] : [c.latencyMs]))),
    peakConcurrency: peak,
    requests: requests.length,
    rateLimitErrors: requests.filter((r) => r.status === "rate_limited").length,
    failedCalls: requests.filter((r) => r.status === "failed").length,
    abortedCalls: requests.filter((r) => r.status === "aborted").length,
    sourceVerificationFailures: { count: unverified.length, findings: unverified.map((r) => ({ findingId: r.f.id, status: r.f.evidenceStatus, classification: r.f.type, score: r.f.score })) },
    tokens: { input: tokens((c) => c.inputTokens), output: tokens((c) => c.outputTokens), cacheRead: tokens((c) => c.cacheReadTokens), cacheWrite: tokens((c) => c.cacheWrite5mTokens + c.cacheWrite1hTokens) },
    actualApiCostUsd: round(usd, 6),
    costPerCandidateUsd: calls.length ? round(usd / calls.length, 6) : null,
    classifications: Object.fromEntries(["direct", "inferential", "false_positive", "insufficient_evidence"].map((k) => [k, found.filter((r) => r.f.type === k).length])),
    sections: Object.fromEntries(delivery.groups.map((g) => [g.group, g.findings.length])),
    findingsRequiringReview: count("contradictions") + count("review"),
    rawOutputs: "raw-verdicts.jsonl here; verdicts.raw and llm_calls.raw_output in the database",
  };
}

type Bundle = { analysisId: number; mode: "free" | "live"; delivery: Awaited<ReturnType<typeof measureDelivery>>; since: string; until: string };

async function writeFindings(run: Run, delivery: Bundle["delivery"]) {
  run.json("findings.json", { note: "Classifications are the model's interpretation. No finding here has been confirmed by a human. Quoted lines come from the stored transcript.", groups: delivery.groups.map((g) => ({ group: g.group, label: g.label, count: g.findings.length })), findings: delivery.details });
  type Side = { range: string | null; verification: { status: string; location: string | null }; attribution: { level: string; disagreement: string | null }; lines: { text: string }[] };
  type Detail = { id: number; groupLabel: string; classification: string; priority: string; score: number | null; band: string | null; evidenceStatus: string; unscoredReason: string | null; contextRequested: boolean; source: { kind: string; model: string; promptVersion: string }; assessment: { explanation: string; alternativeExplanation: string | null }; a: Side; b: Side };
  const cell = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""').replace(/\s+/g, " ")}"`;
  const header = ["finding_id", "group", "classification", "source", "model", "prompt_version", "priority", "score", "band", "evidence_status", "unscored_reason", "context_requested", "a_range", "a_verification", "a_attribution", "a_disagreement", "b_range", "b_verification", "b_attribution", "b_disagreement", "a_text", "b_text", "model_explanation", "alternative_explanation", "human_review"];
  const rows = (delivery.details as Detail[]).map((f) =>
    [f.id, f.groupLabel, f.classification, f.source.kind, f.source.model, f.source.promptVersion, f.priority, f.score, f.band, f.evidenceStatus, f.unscoredReason, f.contextRequested, f.a.range, f.a.verification.status, f.a.attribution.level, f.a.attribution.disagreement, f.b.range, f.b.verification.status, f.b.attribution.level, f.b.attribution.disagreement, f.a.lines.map((l) => l.text).join(" "), f.b.lines.map((l) => l.text).join(" "), f.assessment.explanation, f.assessment.alternativeExplanation, "not reviewed"].map(cell).join(","),
  );
  writeFileSync(path.join(run.dir, "findings.csv"), `${[header.join(","), ...rows].join("\n")}\n`);
}

async function collectMetrics(db: Database, run: Run, b: Bundle) {
  const a = (await call<{ analysis: Record<string, unknown> & { createdAt: string; startedAt: string | null; finishedAt: string | null; status: string; progress: Record<string, unknown>; promptVersion: string; effort: string; mode: string; maxCandidates: number; strategy: string; maxConcurrency: number; caseId: number; depositions: { id: number; originalFilename: string | null }[] } }>("GET", `/analyses/${b.analysisId}`)).data.analysis;
  const set = `analysis-${b.analysisId}`;
  const [first] = (await db.execute<{ first_finding: string | null; first_verified: string | null; last_finding: string | null }>(sql`
    select min(f.created_at) first_finding, min(f.created_at) filter (where f.evidence_status in ('verified', 'approximate')) first_verified, max(f.created_at) last_finding
    from findings f join candidates c on c.id = f.candidate_id where c.candidate_set = ${set}`)).rows;
  const ms = (x: string | null | undefined, y: string | null | undefined) => (x && y ? new Date(y).getTime() - new Date(x).getTime() : null);
  const timings = run.timings();
  const ofStage = (stage: string, analysisId?: number) => timings.filter((t) => t.stage === stage && (analysisId === undefined || t.analysisId === analysisId)).map((t) => t.ms);
  const start = run.state.data.start as { clickedAt: string; statusFirstSeenMs: Record<string, number>; clickToAnalysisPageMs: number; caseHardLoadMs: number } | undefined;
  const apiMs = (await db.execute<{ ms: number }>(sql`select l.latency_ms ms from verdicts v join candidates c on c.id = v.candidate_id join llm_calls l on l.id = v.llm_call_id where c.candidate_set = ${set} and l.latency_ms is not null`)).rows.map((r) => r.ms);
  const documents = (run.state.data.upload ?? []) as { key: string; stored: { lines: number; exchanges: number; parts: number }; pageCount: number; uploadRequestMs: number; uploadToReadyMs: number; bytes: number }[];
  const documentStages = ["upload.validate", "upload.sha256", "upload.store_file", "upload.record", "ingest.read_file", "ingest.pdf_parse", "ingest.validate", "ingest.build_exchanges", "ingest.save_lines", "ingest.save_exchanges", "ingest.save_total"];
  return {
    runId: run.runId,
    benchmark: b.mode === "free" ? "A. no-cost product benchmark (demo mode: no model calls)" : "B. live model benchmark",
    window: { since: b.since, until: b.until },
    configuration: { mode: a.mode, promptVersion: a.promptVersion, effort: a.effort, maxCandidates: a.maxCandidates, strategy: a.strategy, maxConcurrency: a.maxConcurrency, candidatesPerRequest: 1, analysisId: b.analysisId, caseId: a.caseId, depositions: a.depositions.map((d) => d.id), pgBossPollingSeconds: 2 },
    documentProcessing: {
      perFile: documents.map((d) => ({ key: d.key, bytes: d.bytes, pages: d.pageCount, ...d.stored, clientUploadRequestMs: d.uploadRequestMs, uploadToReadyMs: d.uploadToReadyMs })),
      stageMs: Object.fromEntries(documentStages.map((s) => [s, { perFile: ofStage(s) }])),
      totalWallClockMs: round(sum(documents.map((d) => d.uploadToReadyMs))),
      note: "Each file was uploaded and read before the next began. Each stage lists P3171 then P3173, then any repeat upload of the same file (upload.* only).",
    },
    retrieval: {
      pathAClaimExtraction: b.mode === "free" ? "not executed (no model calls)" : "see costs.json",
      pathAMatchingMs: ofStage("retrieve.path_a", b.analysisId),
      pathBMs: ofStage("retrieve.path_b", b.analysisId),
      mergeRankMs: ofStage("retrieve.merge_rank", b.analysisId),
      persistCandidatesMs: ofStage("retrieve.persist_candidates", b.analysisId),
      totalMs: round(sum(["retrieve.path_a", "retrieve.path_b", "retrieve.merge_rank", "retrieve.persist_candidates"].flatMap((s) => ofStage(s, b.analysisId)))),
    },
    adjudication: {
      submitted: (a.progress.candidates as { selected: number } | undefined)?.selected ?? 0,
      freshModelVerdicts: a.progress.adjudicated ?? 0,
      replayedVerdicts: a.progress.replayed ?? 0,
      withoutVerdict: a.progress.withoutVerdict ?? 0,
      failed: a.progress.failed ?? 0,
      apiLatencyMs: b.mode === "free" ? "not measured: no model was called" : stats(apiMs),
      perCandidateMs: stats(ofStage(b.mode === "free" ? "adjudicate.replay_candidate" : "adjudicate.live_candidate", b.analysisId)),
      loadPacketMs: stats(ofStage("adjudicate.load_packet")),
      assessMs: stats(ofStage("adjudicate.assess")),
      findingPersistenceMs: stats(ofStage("adjudicate.persist_finding")),
      wallClockMs: ms(a.startedAt, a.finishedAt),
      pureChecks: await checkTimings(db, b.analysisId),
    },
    application: {
      clickToAnalysisPageMs: start?.clickToAnalysisPageMs ?? null,
      statusFirstSeenAfterClickMs: start?.statusFirstSeenMs ?? null,
      clickToJobProcessingMs: start ? ms(start.clickedAt, a.startedAt) : null,
      queueWaitMs: ms(a.createdAt, a.startedAt),
      clickToFirstPersistedFindingMs: start ? ms(start.clickedAt, first.first_finding) : null,
      clickToFirstSourceVerifiedFindingMs: start ? ms(start.clickedAt, first.first_verified) : null,
      clickToCompletionMs: start ? ms(start.clickedAt, a.finishedAt) : null,
      caseHardLoadMs: start?.caseHardLoadMs ?? null,
      ...b.delivery.timing,
    },
    status: a.status,
    progress: a.progress,
    stages: run.state.stages,
    ...(b.mode === "live" ? { fullRun: await requestMeasures(db, run, b.analysisId, a.createdAt, b.delivery) } : {}),
  };
}

async function writeCosts(db: Database, run: Run, b: Bundle, estimate: unknown) {
  const fresh = await usageOf(db, sql`l.created_at >= ${b.since}::timestamptz and l.created_at <= ${b.until}::timestamptz`);
  const replayed = (await db.execute<{ id: string }>(sql`select distinct o.llm_call_id id from verdicts v join candidates c on c.id = v.candidate_id join verdicts o on o.id = v.replay_of where c.candidate_set = ${`analysis-${b.analysisId}`} and o.llm_call_id is not null`)).rows.map((r) => Number(r.id));
  const reused = replayed.length ? await usageOf(db, sql`l.id in (${sql.join(replayed.map((i) => sql`${i}`), sql`, `)})`) : [];
  const all = await usageOf(db, sql`true`);
  const freshUsd = sum(fresh.map((f) => f.cost ?? 0));
  const reservations = (await db.execute<{ status: string; n: number; usd: number }>(sql`select status::text, count(*)::int n, sum(max_usd)::float usd from budget_reservations r join budgets b on b.id = r.budget_id where b.name = ${`analysis-${b.analysisId}`} group by 1`)).rows;
  const documents = (run.state.data.upload ?? []) as { pageCount: number; stored: { exchanges: number } }[];
  const pages = sum(documents.map((d) => d.pageCount));
  const exchanges = sum(documents.map((d) => d.stored.exchanges));
  const groups = b.delivery.groups;
  const contradictions = groups.find((g) => g.group === "contradictions")?.findings.length ?? 0;
  const details = b.delivery.details as { evidenceStatus: string }[];
  const verified = details.filter((d) => ["verified", "approximate"].includes(d.evidenceStatus)).length;
  const per = (n: number) => (n > 0 ? round(freshUsd / n, 6) : null);
  const value = {
    note: "The three totals are separate and must not be added: fresh spending, historical cost of reused results, and an estimate.",
    "1_freshApiSpendingThisBenchmark": { usd: freshUsd, usage: fresh, failedOrUncertainReservations: reservations, derived: { perPage: per(pages), perExchange: per(exchanges), perCandidateEvaluated: per(fresh.filter((f) => f.stage === "adjudication").reduce((n, f) => n + f.calls, 0)), perPotentialContradiction: per(contradictions), perSourceVerifiedFinding: per(verified) } },
    "2_historicalSpendingOfReusedResults": { usd: sum(reused.map((r) => r.cost ?? 0)), usage: reused, note: "Paid on earlier days for the stored Sonnet verdicts this run replayed. Not new spending." },
    historicalAllTime: { usd: sum(all.map((r) => r.cost ?? 0)), usage: all, note: "Everything recorded in llm_calls, for reference. Includes tagging and evaluation calls unrelated to this run." },
    "3_estimatedFreshProductionRun": estimate,
    infrastructure: { actualIncrementalUsd: 0, note: "Local Postgres in Docker and local processes: no cloud charge. No hosting cost is estimated here." },
    denominators: { pages, exchanges, potentialContradictions: contradictions, sourceVerifiedFindings: verified },
  };
  run.json("costs.json", value);
  return value;
}

function writeEnvironment(run: Run, chrome: string | undefined, postgres: string) {
  const v = (name: string, base = ".") => (JSON.parse(readFileSync(path.join(base, "node_modules", name, "package.json"), "utf8")) as { version: string }).version;
  const hash = (version: PromptVersion) => `system prompt sha256 ${createHash("sha256").update(PROMPTS[version].system).digest("hex").slice(0, 12)}`;
  const lines = [
    `# Environment: ${run.runId}`,
    "",
    "No keys, passwords or connection strings are recorded here.",
    "",
    `- OS: ${platform()} ${release()}, ${cpus().length} × ${cpus()[0]?.model}, ${round(totalmem() / 2 ** 30)} GB memory`,
    `- Node: ${process.version}`,
    `- Browser: ${chrome ?? "not used in this run"} (headless, 1440×1000)`,
    `- Database: ${postgres}, local Docker`,
    `- Packages: express ${v("express")}, drizzle-orm ${v("drizzle-orm")}, pg-boss ${v("pg-boss")}, @anthropic-ai/sdk ${v("@anthropic-ai/sdk")}, pdfjs-dist ${v("pdfjs-dist")}, tsx ${v("tsx")}; client react ${v("react", "client")}, vite ${v("vite", "client")}, tailwindcss ${v("tailwindcss", "client")}`,
    `- Models: adjudication ${ADJUDICATION_MODEL}, claim extraction ${CLAIMS_MODEL} (${EXTRACTOR_VERSION})`,
    `- Prompts: ${PROMPT_VERSIONS.map((p) => `${p} (${hash(p)})`).join(", ")}`,
    "- Concurrency: the worker runs one analysis job at a time; each analysis sends up to its stored maxConcurrency requests at once (metrics.json); pg-boss polls every 2 seconds",
    "- Client: production build served by `vite preview`, API through its proxy",
    "- Process isolation: this run's own API and worker; `free` and `--dry-run` start them with a blank API key and ALLOW_PAID_CALLS=false",
    "- Limits: at most 300 candidates per analysis, 3 per exchange, SDK retries off, 8,000 max output tokens per Sonnet call, 16,000 per Haiku batch",
    "",
  ];
  writeFileSync(path.join(run.dir, "environment.md"), lines.join("\n"));
}

function writeSummary(run: Run, b: Bundle, metrics: Awaited<ReturnType<typeof collectMetrics>>, costs: Awaited<ReturnType<typeof writeCosts>>, retrieval: { benchmarkRun: Awaited<ReturnType<typeof retrievalOf>>; storedDualPath: Awaited<ReturnType<typeof storedDualPath>> }, before: Record<string, number>, after: Record<string, number>) {
  const { documentProcessing: dp, adjudication: ad, application: app, retrieval: rt } = metrics;
  const est = (costs["3_estimatedFreshProductionRun"] as Awaited<ReturnType<typeof estimateRun>>);
  const groups = b.delivery.groups.map((g) => `| ${g.label} | ${g.findings.length} |`).join("\n");
  const adj = (est.adjudication as { prompt: string; candidateSet: string; calls: number; expectedUsdAtMedianOutput: number; expectedUsdAtLargestMeasuredOutput: number; worstCaseUsdEveryCallAtMaxTokens: number; largestSingleReservationUsd: number }[]).map((e) => `| ${e.prompt} | ${e.candidateSet} | ${e.calls} | ${usd(e.expectedUsdAtMedianOutput, 2)} to ${usd(e.expectedUsdAtLargestMeasuredOutput, 2)} | ${usd(e.worstCaseUsdEveryCallAtMaxTokens, 2)} | ${usd(e.largestSingleReservationUsd)} |`).join("\n");
  const evaluation = path.join(run.dir, "evaluation.md");
  const lines = [
    `# Ellison full-run benchmark: ${run.runId}`,
    "",
    `**${metrics.benchmark}.** Replay and demo timing is not live-model latency, and replayed verdicts are not fresh inference.`,
    "",
    "## Overall result",
    "",
    `- Status: ${metrics.status}. Fresh API spending: ${usd(costs["1_freshApiSpendingThisBenchmark"].usd)} (${after.llm_calls - before.llm_calls} new calls).`,
    `- Upload to both transcripts stored: ${secs(dp.totalWallClockMs)} wall clock. Click on Start analysis to completion: ${secs(app.clickToCompletionMs)}.`,
    `- Candidates selected: ${retrieval.benchmarkRun.selected}; assessed fresh: ${ad.freshModelVerdicts}; replayed: ${ad.replayedVerdicts}; with no assessment: ${ad.withoutVerdict}.`,
    `- Retrieval in this run: ${retrieval.benchmarkRun.pathACandidates > 0 ? "Path A + Path B" : "Path B only, because the new case has no claims"}.`,
    `- Existing data preserved: ${["cases", "depositions", "analyses", "verdicts", "findings", "claims"].map((k) => `${k} ${before[k]}→${after[k]}`).join(", ")}; model verdicts ${before.model_verdicts}→${after.model_verdicts}.`,
    `- Problems recorded: ${run.problems.length} (errors.json).`,
    ...("fullRun" in metrics && metrics.fullRun
      ? [
          `- Requests: ${metrics.fullRun.requests}, peak ${metrics.fullRun.peakConcurrency} at once; ${metrics.fullRun.rateLimitErrors} rate limits, ${metrics.fullRun.failedCalls} failed, ${metrics.fullRun.abortedCalls} aborted.`,
          `- Latency: median ${metrics.fullRun.apiLatencyMs.median} ms, P95 ${metrics.fullRun.apiLatencyMs.p95} ms, slowest ${metrics.fullRun.apiLatencyMs.max} ms.`,
          `- First verified finding ${secs(metrics.fullRun.timeToFirstVerifiedFindingMs)}, first potential contradiction ${secs(metrics.fullRun.timeToFirstPotentialContradictionMs)}, after the analysis was created.`,
          `- Actual API cost ${usd(metrics.fullRun.actualApiCostUsd)}, ${usd(metrics.fullRun.costPerCandidateUsd, 5)} per candidate. Citations not verified: ${metrics.fullRun.sourceVerificationFailures.count}. Findings to review: ${metrics.fullRun.findingsRequiringReview}.`,
        ]
      : []),
    "",
    "## Findings",
    "",
    "| Section | Count |",
    "| --- | --- |",
    groups,
    "",
    "Nothing here is human-confirmed. Source verification means the cited words were found in the stored transcript; it says nothing about whether the testimony conflicts.",
    "",
    "## Measured times",
    "",
    "| Stage | Time |",
    "| --- | --- |",
    ...dp.perFile.map((f) => `| ${f.key}: upload to stored (${f.pages} pages, ${f.lines} lines, ${f.exchanges} exchanges) | ${secs(f.uploadToReadyMs)} |`),
    `| Queue wait, analysis created to worker start | ${secs(app.queueWaitMs)} |`,
    `| Retrieval total | ${secs(rt.totalMs)} |`,
    `| Assessment stage wall clock | ${secs(ad.wallClockMs)} |`,
    `| Click to first persisted finding | ${secs(app.clickToFirstPersistedFindingMs)} |`,
    `| Click to first source-verified finding | ${secs(app.clickToFirstSourceVerifiedFindingMs)} |`,
    `| Findings list API, median of ${API_SAMPLES} | ${app.findingsListApiMs.median} ms |`,
    `| One finding API, median | ${app.findingDetailApiMs.median} ms |`,
    `| Findings list, full page load to painted, median | ${app.findingsListRenderHardLoadMs.median} ms |`,
    `| Side-by-side, click to painted, median | ${app.sideBySideRenderMs.median} ms |`,
    "",
    "## Estimated live cost (nothing below was spent)",
    "",
    "| Prompt | Candidates | Calls | Expected | Every call at max_tokens | Largest reservation |",
    "| --- | --- | --- | --- | --- | --- |",
    adj,
    "",
    `Haiku, cold start: ${est.tagging.totalParts} parts in ${est.tagging.totalBatches} batches, expected ${usd(est.tagging.expectedUsd, 2)}, worst case ${usd(est.tagging.worstCaseUsd, 2)}.`,
    "",
    existsSync(evaluation) ? readFileSync(evaluation, "utf8") : "## Evaluation\n\nNot written yet.\n",
  ];
  writeFileSync(path.join(run.dir, "summary.md"), lines.join("\n"));
}

async function report(db: Database, run: Run, b: Bundle, chrome: string | undefined, before: Record<string, number>) {
  await writeFindings(run, b.delivery);
  const estimate = await estimateRun(db, run);
  const metrics = await collectMetrics(db, run, b);
  run.json("metrics.json", metrics);
  const costs = await writeCosts(db, run, b, estimate);
  const retrieval = { benchmarkRun: await retrievalOf(db, b.analysisId), storedDualPath: await storedDualPath(db), documents: run.state.data.upload };
  run.json("retrieval.json", retrieval);
  const [{ version }] = (await db.execute<{ version: string }>(sql`select version()`)).rows;
  writeEnvironment(run, chrome, version.split(" on ")[0]);
  writeSummary(run, b, metrics, costs, retrieval, before, await counts(db));
  if (!existsSync(path.join(run.dir, "errors.json"))) run.json("errors.json", { problems: run.problems });
}

// ------------------------------------------------------------ commands

async function ensureCase(run: Run, name: string) {
  if (run.state.caseId) return;
  const { cases } = (await call<{ cases: { id: number; name: string }[] }>("GET", "/cases")).data;
  const found = cases.find((c) => c.name === name);
  run.state.caseId = found?.id ?? (await call<{ case: { id: number } }>("POST", "/cases", { name, witness: WITNESS })).data.case.id;
  run.save();
}

async function free(db: Database, run: Run) {
  if (process.env.ALLOW_PAID_CALLS === "true") throw new Error("Unset ALLOW_PAID_CALLS: the free benchmark never allows paid calls.");
  run.state.data.before ??= await counts(db);
  const before = run.state.data.before as Record<string, number>;
  run.state.data.since ??= new Date().toISOString();
  run.save();
  await run.stage("build_client", async () => {
    const built = spawnSync("npm", ["run", "build", "--prefix", "client"], { encoding: "utf8" });
    if (built.status !== 0) throw new Error(built.stderr);
  });
  const stack = await startStack(run, false);
  let browser: Browser | undefined;
  try {
    await run.stage("create_case", () => ensureCase(run, `Benchmark ${run.runId}: U.S. v. Oracle`));
    await run.stage("upload_and_parse", () => uploadStage(run));
    browser = await openBrowser();
    await run.stage("start_and_finish_analysis", () => startFromBrowser(run, browser!));
    const analysisId = run.state.analysisId!;
    let delivery!: Bundle["delivery"];
    await run.stage("deliver_findings", async () => {
      delivery = await measureDelivery(run, browser!, analysisId);
    });
    delivery ??= await measureDelivery(run, browser, analysisId);
    for (const p of browser.page.problems as BrowserProblem[]) run.problem("browser", p.kind, p.text);
    await run.stage("reports", () => report(db, run, { analysisId, mode: "free", delivery, since: run.state.data.since as string, until: new Date().toISOString() }, browser?.version, before));
    const after = await counts(db);
    if (after.llm_calls !== before.llm_calls || after.model_verdicts !== before.model_verdicts) run.problem("guard", "unexpected_model_call", `llm_calls ${before.llm_calls}→${after.llm_calls}`);
    console.log(`Done. ${path.join(run.dir, "summary.md")}`);
  } finally {
    browser?.close();
    await stack.stop();
  }
}

// Warm: the stored depositions, with their claims. Cold: the benchmark case's own, tagged first.
async function live(db: Database, run: Run, a: Args) {
  if (!a.start || !a.prompt || !a.candidates || a.approveUsd === undefined) throw new Error("live needs --start warm|cold, --prompt, --candidates and --approve-usd.");
  if (!a.dryRun && !a.approved) throw new Error("live makes paid calls: add --i-approve-paid-calls after the budget has been approved.");
  if (!a.dryRun && !process.env.ANTHROPIC_API_KEY) throw new Error("No ANTHROPIC_API_KEY.");
  if (!run.state.stages.upload_and_parse) throw new Error("Run `free` with this run ID first.");
  const tagBudget = a.start === "cold" ? a.tagBudgetUsd : 0;
  if (tagBudget === undefined) throw new Error("--start cold needs --tag-budget-usd.");
  const analysisBudget = a.approveUsd - tagBudget;
  if (analysisBudget <= 0 || analysisBudget > 20) throw new Error(`The analysis budget would be ${analysisBudget}; it must be above 0 and at most 20.`);
  const paid = !a.dryRun;
  const subdir = new Run(`${run.runId}/live-${a.start}${a.dryRun ? "-dry-run" : ""}`);
  subdir.state.depositions ??= run.state.depositions;
  subdir.state.data.upload ??= run.state.data.upload;
  subdir.state.data.before ??= await counts(db);
  subdir.state.data.since ??= new Date().toISOString();
  subdir.save();
  const stack = await startStack(subdir, paid);
  let browser: Browser | undefined;
  try {
    let caseId = run.state.caseId!;
    let [depositionA, depositionB] = run.state.depositions!.map((d) => d.id);
    if (a.start === "warm") {
      const stored = (await storedDualPath(db)).deposition;
      [depositionA, depositionB] = [stored.a, stored.b];
      caseId = Number((await db.execute<{ id: string }>(sql`select case_id id from depositions where id = ${depositionA}`)).rows[0].id);
    } else if (paid) {
      await subdir.stage("haiku_tagging", async () => {
        for (const d of run.state.depositions!) {
          const tagged = spawnSync("npx", ["tsx", "scripts/patha.ts", "tag", "--case-id", String(caseId), "--witness", WITNESS, "--deposition", String(d.id), "--all", "--budget-name", `benchmark-${run.runId}-tagging`, "--budget-limit", String(tagBudget)], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, BENCHMARK_TIMING_FILE: subdir.timingFile } });
          console.log(tagged.stdout);
          if (tagged.status !== 0) throw new Error(`Tagging ${d.key} failed.`);
        }
      });
    }
    await subdir.stage("start_analysis", async () => {
      if (subdir.state.analysisId) return;
      const started = await call<{ analysis: { id: number } }>("POST", `/cases/${caseId}/analyses`, { depositionA, depositionB, mode: "live", budgetUsd: analysisBudget, maxCandidates: a.candidates, promptVersion: a.prompt, effort: "medium", strategy: "C" });
      if (started.status >= 300) throw new Error(`Starting the analysis answered ${started.status}: ${JSON.stringify(started.data)}`);
      subdir.state.analysisId = started.data.analysis.id;
    });
    const id = subdir.state.analysisId!;
    await subdir.stage("wait_for_analysis", async () => {
      let view = (await call<{ analysis: { status: string; error: string | null } }>("GET", `/analyses/${id}`)).data.analysis;
      // Running this command again resumes an analysis that stopped, within the same budget.
      if (paid && ["blocked_budget", "failed", "blocked_credentials", "interrupted"].includes(view.status)) await call("POST", `/analyses/${id}/resume`, {});
      for (;;) {
        await sleep(1000);
        view = (await call<typeof view & { analysis: typeof view }>("GET", `/analyses/${id}`)).data.analysis;
        if (["completed", "failed", "blocked_budget", "blocked_credentials"].includes(view.status)) break;
      }
      if (view.status !== "completed") subdir.problem("analysis", view.status, view.error ?? "");
    });
    browser = await openBrowser();
    const delivery = await measureDelivery(subdir, browser, id);
    for (const p of browser.page.problems) subdir.problem("browser", p.kind, p.text);
    await report(db, subdir, { analysisId: id, mode: "live", delivery, since: subdir.state.data.since as string, until: new Date().toISOString() }, browser.version, subdir.state.data.before as Record<string, number>);
    console.log(`Done. ${path.join(subdir.dir, "summary.md")}`);
  } finally {
    browser?.close();
    await stack.stop();
  }
}

async function main() {
  const { command, args } = readArgs();
  const { db, pool } = connect();
  const run = new Run(args.runId);
  try {
    if (command === "free") await free(db, run);
    else if (command === "live") await live(db, run, args);
    else if (command === "preflight") await preflight(db, run, args.prompt ?? DEFAULT_PROMPT_VERSION);
    else console.log(JSON.stringify(await estimateRun(db, run), null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  appendFileSync(path.join(BASE_DIR, "failures.log"), `${new Date().toISOString()} ${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
});
