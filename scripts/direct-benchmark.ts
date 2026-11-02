// The synthetic evaluation of direct discovery, through the production path. Development-tuned
// synthetic evaluation, not a held-out benchmark: see server/src/eval/directBenchmark.ts.
//   npx tsx scripts/direct-benchmark.ts estimate
//     No API call, no database write: the request plan and its cost, from the fixtures' real token
//     counts in earlier runs where they exist.
//   npx tsx scripts/direct-benchmark.ts score --analysis <id> --suite whitfield|webb
//     No API call: scores a finished analysis.
//   npx tsx scripts/direct-benchmark.ts run --execute --approved-usd <n> [--suite whitfield|webb]
//     PAID: one Fable batch request per suite. Synthetic testimony only. Needs ALLOW_PAID_CALLS=true,
//     and stops at the ceiling: one shared budget covers every request.

import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { parseArgs } from "node:util";
import { anthropicDiscovery, DISCOVERY_FALLBACK_MODEL, DISCOVERY_MODEL, DISCOVERY_PROMPT_VERSION, DISCOVERY_SYSTEM, discoveryUserPrompt, inputTokensBound, type DiscoveryProvider } from "../server/src/adjudicate";
import { BATCH_MULTIPLIER, callCost, maxBatchRequestCost, type CallTokens } from "../server/src/costs";
import { connect, type Database } from "../server/src/db/client";
import { analyses, budgets, candidates, depositions, discoveryRuns, exchangeLines, exchanges, findings, lines } from "../server/src/db/schema";
import { scoreBenchmark, type BenchmarkFinding, type BenchmarkTarget } from "../server/src/eval/directBenchmark";
import { withDistractors } from "../server/src/eval/discovery";
import { toSourceLines, WEBB_SUITE, WHITFIELD_SUITE, type SyntheticSuite } from "../server/src/eval/synthetic";
import { storeSessions } from "../server/src/eval/syntheticStore";
import { DIRECT_FABLE, runAnalysis } from "../server/src/jobs";

const DISTRACTORS = 60; // the size every earlier run on these suites used
export const BENCHMARK_MAX_OUTPUT_TOKENS = 64_000; // the production cap: 24,000 cut off Whitfield's answer on November 1
const SUITES: Record<string, SyntheticSuite> = { whitfield: WHITFIELD_SUITE, webb: WEBB_SUITE };

const { values, positionals } = parseArgs({ allowPositionals: true, options: { suite: { type: "string" }, analysis: { type: "string" }, execute: { type: "boolean" }, "approved-usd": { type: "string" } } });

function promptOf(suite: SyntheticSuite) {
  const [a, b] = suite.sessions.map((s) => ({ description: `session of ${s.takenOn}`, lines: toSourceLines(s.text, s.firstPage).map((l) => ({ page: l.printedPage!, line: l.lineNo, text: l.rawText })) }));
  return discoveryUserPrompt(suite.witness, a, b);
}

// What earlier single-call runs measured on the same fixture text: the input size, from real usage.
function measuredInput(name: string) {
  const root = "experiments/multimodel-contradictions/runs";
  for (const run of readdirSync(root).filter((r) => r.endsWith(`discovery-${name}-C`)).reverse()) {
    try {
      const u = JSON.parse(readFileSync(`${root}/${run}/manifest.json`, "utf8")).usage;
      return { input: u.input + u.cacheRead + u.cacheWrite, output: u.output, run };
    } catch { /* an unfinished run has no manifest */ }
  }
  return null;
}

function estimate() {
  const rows = Object.entries(SUITES).map(([name, suite]) => {
    const user = promptOf(withDistractors(suite, DISTRACTORS));
    const bound = inputTokensBound(user);
    const measured = measuredInput(name);
    const input = measured?.input ?? Math.ceil(bound / 3);
    const cost = (output: number) => callCost(DISCOVERY_MODEL, { input, output, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } as CallTokens, { batch: true })!.costUsd;
    return {
      suite: name, targets: suite.cases.filter((c) => c.label === "direct" || c.label === "inferential").length, promptChars: user.length, inputTokensMeasured: measured?.input ?? null, measuredIn: measured?.run ?? null,
      expectedOutputLow: 8000, expectedOutputHigh: BENCHMARK_MAX_OUTPUT_TOKENS, expectedUsdLow: cost(8000), expectedUsdHigh: cost(BENCHMARK_MAX_OUTPUT_TOKENS),
      reservedUsd: maxBatchRequestCost(DISCOVERY_MODEL, { inputTokens: bound, maxOutputTokens: BENCHMARK_MAX_OUTPUT_TOKENS }),
    };
  });
  console.log(JSON.stringify({ model: DISCOVERY_MODEL, mode: `Batch API (${BATCH_MULTIPLIER * 100}% of list price)`, promptVersion: DISCOVERY_PROMPT_VERSION, promptChars: DISCOVERY_SYSTEM.length, requests: rows.length, fallback: `${DISCOVERY_FALLBACK_MODEL}, only after a refusal, only if the budget allows`, maxOutputTokensPerRequest: BENCHMARK_MAX_OUTPUT_TOKENS, rows, expectedTotalLow: rows.reduce((n, r) => n + r.expectedUsdLow, 0), expectedTotalHigh: rows.reduce((n, r) => n + r.expectedUsdHigh, 0), syntheticOnly: true }, null, 2));
}

// The lines of the exchange a case's question phrase opens, in one session.
async function linesOfQuestion(db: Database, depositionId: number, phrase: string): Promise<number[]> {
  const rows = await db.select({ id: exchanges.id, q: exchanges.questionText }).from(exchanges).where(eq(exchanges.depositionId, depositionId));
  const hit = rows.find((r) => r.q.replace(/\s+/g, " ").includes(phrase));
  if (!hit) throw new Error(`No exchange asks "${phrase}".`);
  return (await db.select({ id: exchangeLines.lineId }).from(exchangeLines).where(eq(exchangeLines.exchangeId, hit.id))).map((r) => r.id);
}

async function scoreAnalysis(db: Database, analysisId: number, suite: SyntheticSuite) {
  const [a] = await db.select().from(analyses).where(eq(analyses.id, analysisId));
  const rows = await db.select({ f: findings }).from(findings).innerJoin(candidates, eq(candidates.id, findings.candidateId)).where(eq(candidates.candidateSet, `analysis-${analysisId}`));
  const runs = await db.select().from(discoveryRuns).where(eq(discoveryRuns.analysisId, analysisId));
  const of = (cases_: SyntheticSuite["cases"]) => Promise.all(cases_.map(async (c): Promise<BenchmarkTarget> => ({ id: c.id, label: c.label, a: await linesOfQuestion(db, a.depositionA, c.questionA), b: await linesOfQuestion(db, a.depositionB, c.questionB) })));
  const conflict = (c: SyntheticSuite["cases"][number]) => c.label === "direct" || c.label === "inferential";
  const found: BenchmarkFinding[] = rows.map(({ f }) => {
    const d = (f.checks as { direct: { lane: string; modelClassification: string; a: BenchmarkFinding["a"]; b: BenchmarkFinding["b"] } }).direct;
    return { lane: d.lane, modelClassification: d.modelClassification, evidenceStatus: f.evidenceStatus, a: d.a, b: d.b };
  });
  const stored = await db.select({ id: lines.id, text: lines.rawText, role: lines.speakerRole }).from(lines).where(inArray(lines.depositionId, [a.depositionA, a.depositionB])).orderBy(lines.id);
  // The fixture says who speaks, independently of the parser: each turn opens with Q. or A.
  let speaker = "Q";
  const truth = stored.map((l) => {
    speaker = l.text.match(/^([QA])\./)?.[1] ?? speaker;
    return { lineId: l.id, witness: speaker === "A" };
  });
  const roles = new Map(stored.map((l) => [l.id, l.role]));
  const score = scoreBenchmark({ sessionA: a.depositionA, targets: await of(suite.cases.filter(conflict)), traps: await of(suite.cases.filter((c) => !conflict(c))), findings: found, proposals: runs.flatMap((r) => (r.audit ?? []) as unknown[]).length, truth, codeSaysWitness: (id) => roles.get(id) === "witness" });
  return { analysisId, status: a.status, label: "development-tuned synthetic evaluation, not a held-out benchmark", ...score };
}

async function run(db: Database, ceiling: number) {
  if (process.env.ALLOW_PAID_CALLS !== "true") throw new Error("Set ALLOW_PAID_CALLS=true: this makes paid calls.");
  if (!values.execute) throw new Error("Pass --execute: this makes paid calls.");
  const names = values.suite ? [values.suite] : Object.keys(SUITES);
  const [budget] = await db.insert(budgets).values({ name: `direct-benchmark-${new Date().toISOString()}`, limitUsd: ceiling }).returning();
  const provider: DiscoveryProvider = anthropicDiscovery(undefined, BENCHMARK_MAX_OUTPUT_TOKENS);
  for (const name of names) {
    const suite = SUITES[name];
    const { depositionIds } = await storeSessions(db, withDistractors(suite, DISTRACTORS));
    const [doc] = await db.select().from(depositions).where(eq(depositions.id, depositionIds[0]));
    const [a] = await db.insert(analyses).values({ caseId: doc.caseId, witnessId: doc.witnessId, depositionA: depositionIds[0], depositionB: depositionIds[1], mode: "live", retrieval: DIRECT_FABLE, promptVersion: DISCOVERY_PROMPT_VERSION, effort: "xhigh", maxCandidates: 1, budgetUsd: ceiling, budgetId: budget.id }).returning();
    let outcome = await runAnalysis(db, a.id, { liveAdjudicator: () => null, discovery: () => provider });
    while (outcome === "polling") {
      await new Promise((done) => setTimeout(done, 30_000));
      outcome = await runAnalysis(db, a.id, { liveAdjudicator: () => null, discovery: () => provider });
    }
    console.log(JSON.stringify({ suite: name, outcome, ...(await scoreAnalysis(db, a.id, suite)) }, null, 2));
  }
  const [b] = await db.select().from(budgets).where(eq(budgets.id, budget.id));
  console.log(`Spent $${b.spentUsd.toFixed(4)} of $${ceiling.toFixed(2)}, $${b.reservedUsd.toFixed(4)} still reserved.`);
}

async function main() {
  const command = positionals[0];
  if (command === "estimate") return estimate();
  const { db, pool } = connect();
  try {
    if (command === "score") console.log(JSON.stringify(await scoreAnalysis(db, Number(values.analysis), SUITES[values.suite!]), null, 2));
    else if (command === "run") await run(db, Number(values["approved-usd"]));
    else throw new Error("Commands: estimate, score, run");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
