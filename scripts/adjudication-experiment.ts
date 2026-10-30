// Compares ways of sending evidence to the adjudication model (reports/benchmarks/adjudication-strategies/).
//
//   npx tsx scripts/adjudication-experiment.ts estimate
//     Fixes the sample and writes the cost and time estimates, from real packets and recorded calls.
//     Reads the database in DATABASE_URL; writes nothing to it. No API call.
//   npx tsx scripts/adjudication-experiment.ts mock
//     Runs every strategy over 300 real Ellison candidates with the deterministic mock model, in the
//     database in TEST_DATABASE_URL, which it WIPES. Measures the pipeline, not the model. No API call.
//   npx tsx scripts/adjudication-experiment.ts live --run-id <id> --strategy <A|B|C|D|E|F|P>
//                                                   --approve-usd <shared limit> --i-approve-paid-calls
//     PAID. Runs one strategy over the fixed sample, from a budget shared by the whole run. Results go
//     to runs/<id>/<strategy>/ and are never overwritten; running it again continues unfinished work.
//     Candidates are copied into a set of their own per strategy, so runs can't touch earlier results.
//   npx tsx scripts/adjudication-experiment.ts report --run-id <id> --strategy <id>
//     Writes results.json from stored rows, for a run that ended without one. No API call.

import "dotenv/config";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  anthropicAdjudicator,
  anthropicBatchAdjudicator,
  BATCH_LIMITS,
  BATCH_PROMPT_VERSION,
  BATCH_SYSTEM_PROMPT,
  batchOutputTokens,
  executeAdjudication,
  formatBatch,
  formatPacket,
  isDegenerate,
  loadPacket,
  maxPacketCost,
  persistCandidates,
  planBatches,
  PROMPTS,
  STRATEGIES,
  STRATEGY_IDS,
  usesBatchFormat,
  type Packet,
  type StrategyId,
} from "../server/src/adjudicate";
import { ADJUDICATION_MODEL as MODEL, MAX_OUTPUT_TOKENS } from "../server/src/adjudicate/prompt";
import { BATCH_JSON_SCHEMA } from "../server/src/adjudicate/batch";
import { callCost, ensureBudget, inputTokenBound, maxRequestCost, PRICE_VERSION } from "../server/src/costs";
import { connect, type Database } from "../server/src/db/client";
import { adjudicationRequests, budgetReservations, budgets, candidates, findings, llmCalls, verdicts } from "../server/src/db/schema";
import { ASSUMED_FIRST_TOKEN_MS, ASSUMED_OUTPUT_TOKENS_PER_SECOND, mockBatch, mockSingle } from "../server/src/eval/mockModel";
import { SYNTHETIC_SUITES, type SyntheticCase } from "../server/src/eval/synthetic";
import { ingestFile } from "../server/src/ingest";
import { findPathB, mergeCandidates, selectCandidates } from "../server/src/retrieve";
import { emptyTables, openTestDatabase } from "../tests/db/database";

const DIR = "reports/benchmarks/adjudication-strategies";
const SAMPLE_FILE = path.join(DIR, "sample.json");
const LIVE_PROMPT = "adjudicate-v3";
const ELLISON_TOP = 12;
const ELLISON_SPREAD = 12;
const MOCK_TIME_SCALE = 0.02; // the mock runs 50 times faster than the assumed real speed
const OUTPUT_PER_VERDICT = { typical: 368, high: 681 }; // analysis 9's mean; the largest recorded
const INPUT_TOKENS_PER_CHAR = 0.43; // measured, adjudicate-v2

const round = (n: number, p = 4) => Math.round(n * 10 ** p) / 10 ** p;
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const quantile = (xs: readonly number[], q: number) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const at = (s.length - 1) * q;
  const low = Math.floor(at);
  return round(s[low] + (s[Math.min(low + 1, s.length - 1)] - s[low]) * (at - low), 1);
};
const stats = (xs: readonly number[]) => ({ n: xs.length, mean: xs.length ? round(sum(xs) / xs.length, 1) : null, median: quantile(xs, 0.5), p95: quantile(xs, 0.95), max: quantile(xs, 1) });
const write = (name: string, text: string) => {
  mkdirSync(path.dirname(path.join(DIR, name)), { recursive: true });
  writeFileSync(path.join(DIR, name), text);
};
const writeJson = (name: string, value: unknown) => write(name, `${JSON.stringify(value, null, 2)}\n`);
const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");

const promptTokens = (system: string, schema: unknown) => Math.round((system.length + JSON.stringify(schema).length) * INPUT_TOKENS_PER_CHAR);
const PROMPT_INFO = {
  [LIVE_PROMPT]: { sha256: hashOf(PROMPTS[LIVE_PROMPT].system), tokens: promptTokens(PROMPTS[LIVE_PROMPT].system, PROMPTS[LIVE_PROMPT].jsonSchema) },
  [BATCH_PROMPT_VERSION]: { sha256: hashOf(BATCH_SYSTEM_PROMPT), tokens: promptTokens(BATCH_SYSTEM_PROMPT, BATCH_JSON_SCHEMA) },
};

// ------------------------------------------------------------ the sample

type SampleItem = { source: "synthetic" | "ellison"; candidateId: number; case?: string; split?: string; label?: string; acceptable?: string[]; kind?: string; ambiguity?: string; rank?: number };

// Every synthetic case, plus Ellison pairs from the top ranks and evenly across the rest, in an order
// fixed by a hash, so known contradictions don't sit together and every strategy sees the same order.
async function buildSample(db: Database): Promise<SampleItem[]> {
  const items: SampleItem[] = [];
  for (const suite of SYNTHETIC_SUITES) {
    const rows = await db.select({ id: candidates.id, evidence: candidates.evidence }).from(candidates).where(eq(candidates.candidateSet, suite.set));
    for (const r of rows) {
      const name = (r.evidence as { fixture: string }[])[0].fixture;
      const c = suite.cases.find((x) => x.id === name) as SyntheticCase;
      items.push({ source: "synthetic", candidateId: r.id, case: c.id, split: suite.split, label: c.label, acceptable: c.acceptable, kind: c.kind, ambiguity: c.ambiguity });
    }
  }
  const ellison = await db.select({ id: candidates.id, rank: candidates.mergedRank }).from(candidates).where(and(eq(candidates.candidateSet, "ellison-v1"), sql`${candidates.status} <> 'deferred'`)).orderBy(asc(candidates.mergedRank));
  const rest = ellison.slice(ELLISON_TOP);
  const spread = Array.from({ length: ELLISON_SPREAD }, (_, i) => rest[Math.floor(((i + 0.5) * rest.length) / ELLISON_SPREAD)]);
  for (const r of [...ellison.slice(0, ELLISON_TOP), ...spread]) items.push({ source: "ellison", candidateId: r.id, rank: r.rank });
  return items.sort((a, b) => hashOf(String(a.candidateId)).localeCompare(hashOf(String(b.candidateId))));
}

const packetsOf = async (db: Database, ids: readonly number[]) => {
  const packets: Packet[] = [];
  for (const id of ids) packets.push(await loadPacket(db, id));
  return packets;
};

// ------------------------------------------------------------ estimates

const tokenCost = (t: { input: number; output: number; write: number; read: number }) => callCost(MODEL, { input: t.input, output: t.output, cacheWrite5m: t.write, cacheWrite1h: 0, cacheRead: t.read })!.costUsd;

// The expected cost and time of one strategy over these packets, from the plan it would really make.
function estimateStrategy(id: StrategyId, packets: readonly Packet[]) {
  const s = STRATEGIES[id];
  const batched = usesBatchFormat(id);
  const prompt = PROMPT_INFO[batched ? BATCH_PROMPT_VERSION : LIVE_PROMPT].tokens;
  const requests = batched
    ? planBatches(packets, s.candidatesPerRequest).batches.map((b) => ({ n: b.packets.length, chars: b.text.length, maxUsd: maxRequestCost(MODEL, { inputTokens: inputTokenBound(BATCH_SYSTEM_PROMPT.length + JSON.stringify(BATCH_JSON_SCHEMA).length + b.text.length), maxOutputTokens: batchOutputTokens(b.packets.length) }) }))
    : packets.map((p) => ({ n: 1, chars: formatPacket(p).length, maxUsd: maxPacketCost(MODEL, formatPacket(p), LIVE_PROMPT) }));
  const scenario = (outputPerVerdict: number, cacheMissEvery: boolean) =>
    sum(requests.map((r, i) => tokenCost({ input: Math.round(r.chars * INPUT_TOKENS_PER_CHAR), output: r.n * outputPerVerdict, write: cacheMissEvery || i === 0 ? prompt : 0, read: cacheMissEvery || i === 0 ? 0 : prompt })));
  const seconds = (outputPerVerdict: number) => {
    const latency = requests.map((r) => ASSUMED_FIRST_TOKEN_MS / 1000 + (r.n * outputPerVerdict) / ASSUMED_OUTPUT_TOKENS_PER_SECOND);
    return latency[0] + sum(latency.slice(1)) / s.maxConcurrency; // one warm-up request, then the pool
  };
  const peakReserved = sum([...requests.map((r) => r.maxUsd)].sort((a, b) => b - a).slice(0, s.maxConcurrency));
  return {
    strategy: id,
    label: s.label,
    prompt: batched ? BATCH_PROMPT_VERSION : LIVE_PROMPT,
    requests: requests.length,
    candidates: packets.length,
    expectedUsd: round(scenario(OUTPUT_PER_VERDICT.typical, false)),
    expectedUsdLargeOutput: round(scenario(OUTPUT_PER_VERDICT.high, false)),
    usdIfEveryRequestMissesTheCache: round(scenario(OUTPUT_PER_VERDICT.typical, true)),
    worstCaseEveryRequestAtMaxTokens: round(sum(requests.map((r) => r.maxUsd))),
    largestReservationUsd: round(Math.max(...requests.map((r) => r.maxUsd))),
    peakReservedUsd: round(peakReserved),
    assumedMaxTokensPerRequest: batched ? batchOutputTokens(s.candidatesPerRequest) : MAX_OUTPUT_TOKENS,
    projectedSeconds: { typical: Math.round(seconds(OUTPUT_PER_VERDICT.typical)), largeOutput: Math.round(seconds(OUTPUT_PER_VERDICT.high)) },
  };
}

function singleRequestFeasibility(packets: readonly Packet[]) {
  const text = formatBatch(packets);
  const input = Math.round((text.length + BATCH_SYSTEM_PROMPT.length + JSON.stringify(BATCH_JSON_SCHEMA).length) * INPUT_TOKENS_PER_CHAR);
  const output = { typical: packets.length * OUTPUT_PER_VERDICT.typical, high: packets.length * OUTPUT_PER_VERDICT.high, planned: batchOutputTokens(packets.length) };
  const limits = { contextWindow: 1_000_000, modelMaxOutput: 128_000, projectLimitMaxOutput: BATCH_LIMITS.maxOutputTokens };
  return {
    executed: false,
    candidates: packets.length,
    inputTokensEstimate: input,
    outputTokens: output,
    limits,
    contextUtilization: { typical: round((input + output.typical) / limits.contextWindow, 3), planned: round((input + output.planned) / limits.contextWindow, 3) },
    outputLimitUtilization: { typical: round(output.typical / limits.modelMaxOutput, 3), high: round(output.high / limits.modelMaxOutput, 3), planned: round(output.planned / limits.modelMaxOutput, 3) },
    expectedUsd: round(tokenCost({ input, output: output.typical, write: 0, read: 0 })),
    maximumUsdAtModelOutputLimit: round(maxRequestCost(MODEL, { inputTokens: text.length + BATCH_SYSTEM_PROMPT.length, maxOutputTokens: limits.modelMaxOutput })),
    projectedStreamMinutes: { typical: round(output.typical / ASSUMED_OUTPUT_TOKENS_PER_SECOND / 60, 1), high: round(output.high / ASSUMED_OUTPUT_TOKENS_PER_SECOND / 60, 1) },
    truncationRisk: "Fits only at typical verdict length. At the largest recorded length it needs more output than the model allows, so the response would stop mid-JSON and the whole request's cost would buy nothing, because a cut-off response is not parsed.",
    coverageRisk: "One failure loses all 300 candidates, not one. A single interrupted stream costs the full input and all output so far.",
    contaminationRisk: "Every candidate shares a context with 299 others on the same witness and subjects, the worst case for a fact crossing between them.",
    conclusion: "It fits in the context window, but that is not evidence it would work reliably. Not recommended, and not executed.",
  };
}

async function estimate(db: Database) {
  const sample = existsSync(SAMPLE_FILE) ? (JSON.parse(readFileSync(SAMPLE_FILE, "utf8")) as { items: SampleItem[] }).items : await buildSample(db);
  if (!existsSync(SAMPLE_FILE)) writeJson("sample.json", { note: "Fixed once. Synthetic labels are read from server/src/eval/synthetic.ts, unchanged. Ellison pairs have no labels.", items: sample });
  const samplePackets = await packetsOf(db, sample.map((s) => s.candidateId));
  const ids = (await db.select({ id: candidates.id }).from(candidates).where(and(eq(candidates.candidateSet, "ellison-v1"), sql`${candidates.status} <> 'deferred'`)).orderBy(asc(candidates.mergedRank))).map((r) => r.id);
  const fullPackets = await packetsOf(db, ids);
  const order: StrategyId[] = ["A", "B", "C", "P", "D", "E", "F"];
  const onSample = order.map((id) => estimateStrategy(id, samplePackets));
  const onFull = order.map((id) => estimateStrategy(id, fullPackets));
  const [budget] = (await db.execute<Record<string, number>>(sql`select coalesce(sum(cost_usd), 0)::float recorded from llm_calls`)).rows;
  const uncertain = (await db.execute<{ n: number; usd: number }>(sql`select count(*)::int n, coalesce(sum(max_usd), 0)::float usd from budget_reservations where status = 'uncertain'`)).rows[0];
  const open = (await db.execute<{ n: number }>(sql`select count(*)::int n from budget_reservations where status = 'reserved'`)).rows[0];

  const pick = (ids: StrategyId[]) => {
    const rows = onSample.filter((e) => ids.includes(e.strategy));
    const expected = sum(rows.map((r) => r.expectedUsd));
    const large = sum(rows.map((r) => r.expectedUsdLargeOutput));
    const missedCache = sum(rows.map((r) => r.usdIfEveryRequestMissesTheCache - r.expectedUsd));
    const interrupted = Math.max(...rows.map((r) => r.largestReservationUsd));
    // The shared limit must hold what has been spent, plus what the largest strategy reserves at once.
    // Warm-up makes missing the cache on every request unlikely, and the limit caps it anyway.
    const requiredLimit = large + interrupted + Math.max(...rows.map((r) => r.peakReservedUsd));
    return { strategies: ids, expectedUsd: round(expected, 2), withLargeOutputUsd: round(large, 2), allowanceAllCacheMissesUsd: round(missedCache, 2), allowanceOneInterruptedRequestUsd: round(interrupted, 2), recommendedSharedBudgetUsd: Math.ceil(requiredLimit * 10) / 10 };
  };
  const value = {
    note: "Estimates only; nothing here was charged. Expected costs use 368 output tokens per verdict (analysis 9) and 681 for the large-output case (the most recorded). Time uses the assumed latency model below, not a measurement of batches.",
    assumedLatency: { firstTokenMs: ASSUMED_FIRST_TOKEN_MS, outputTokensPerSecond: ASSUMED_OUTPUT_TOKENS_PER_SECOND, basis: "Fitted to analysis 9: 3.3 s per call at 368 output tokens. The split between first token and streaming is an assumption." },
    priceVersion: PRICE_VERSION,
    recorded: { totalUsd: round(budget.recorded), uncertainReservations: uncertain.n, uncertainUsd: round(uncertain.usd), openReservations: open.n, accountBalance: "Unknown: the API doesn't report it. Check the Console before approving." },
    promptTokensEstimate: PROMPT_INFO,
    sampleOf40: onSample,
    full300PathAPlusB: onFull,
    proposals: { reduced: pick(["B", "C", "D"]), recommended: pick(["B", "C", "P", "D", "E"]), full: pick(["A", "B", "C", "P", "D", "E"]) },
    wholeCaseInOneRequest: singleRequestFeasibility(fullPackets),
  };
  writeJson("cost-estimates.json", value);
  return { value, sample };
}

// ------------------------------------------------------------ measuring a run

async function measureSet(db: Database, set: string, startedAt: Date, finishedAt: Date, peak: number, sample?: SampleItem[]) {
  const requests = await db.select().from(adjudicationRequests).where(eq(adjudicationRequests.candidateSet, set));
  const callIds = [...new Set(requests.flatMap((r) => (r.llmCallId ? [r.llmCallId] : [])))];
  const calls = callIds.length ? await db.select().from(llmCalls).where(inArray(llmCalls.id, callIds)) : [];
  const rows = await db.select({ v: verdicts, c: candidates }).from(verdicts).innerJoin(candidates, eq(candidates.id, verdicts.candidateId)).where(eq(candidates.candidateSet, set));
  const found = await db.select({ f: findings }).from(findings).innerJoin(candidates, eq(candidates.id, findings.candidateId)).where(eq(candidates.candidateSet, set));
  const total = await db.$count(candidates, and(eq(candidates.candidateSet, set), sql`${candidates.status} <> 'deferred'`));
  const verified = found.filter((r) => ["verified", "approximate"].includes(r.f.evidenceStatus));
  const contradictions = found.filter((r) => ["direct", "inferential"].includes(r.f.type));
  const first = (xs: typeof found) => (xs.length ? Math.min(...xs.map((r) => r.f.createdAt.getTime())) - startedAt.getTime() : null);
  const reservations = requests.flatMap((r) => (r.reservationId ? [r.reservationId] : []));
  const held = reservations.length ? await db.select().from(budgetReservations).where(inArray(budgetReservations.id, reservations)) : [];
  const usd = sum(calls.map((c) => c.costUsd ?? 0));
  const per = (n: number) => (n > 0 ? round(usd / n, 6) : null);
  const tokens = (f: (c: (typeof calls)[number]) => number) => sum(calls.map(f));

  let accuracy: unknown = "No labelled candidates in this run.";
  if (sample) {
    const bySource = new Map(sample.map((s) => [s.candidateId, s]));
    const labelled = rows.flatMap(({ v, c }) => {
      const s = bySource.get((c.evidence as { sourceCandidateId?: number }[])[0]?.sourceCandidateId ?? -1);
      return s?.source === "synthetic" ? [{ s, v }] : [];
    });
    const expected = sample.filter((s) => s.source === "synthetic");
    const conflict = (x: string | undefined) => x === "direct" || x === "inferential";
    const said = (v: (typeof labelled)[number]["v"] | undefined) => (v?.parsed as { classification?: string } | null | undefined)?.classification;
    const answered = labelled.filter((l) => l.v.status === "valid");
    const positives = expected.filter((s) => conflict(s.label));
    const negatives = expected.filter((s) => !conflict(s.label));
    const split = (name: string) => {
      const part = answered.filter((l) => l.s.split === name);
      return { cases: expected.filter((s) => s.split === name).length, exactAgreement: part.filter((l) => said(l.v) === l.s.label).length, acceptableAgreement: part.filter((l) => l.s.acceptable?.includes(said(l.v)!)).length };
    };
    accuracy = {
      labelledCases: expected.length,
      exactAgreement: answered.filter((l) => said(l.v) === l.s.label).length,
      contradictionRecall: { found: answered.filter((l) => conflict(l.s.label) && conflict(said(l.v))).length, of: positives.length },
      falsePositives: { flagged: answered.filter((l) => !conflict(l.s.label) && conflict(said(l.v))).length, of: negatives.length },
      bySplit: { development: split("development"), held_out: split("held_out") },
      perCase: expected.map((s) => ({ case: s.case, split: s.split, kind: s.kind, label: s.label, said: said(labelled.find((l) => l.s.candidateId === s.candidateId)?.v) ?? "(no verdict)" })),
    };
  }
  return {
    candidates: total,
    request: {
      apiCalls: calls.length,
      requestsRecorded: requests.length,
      candidatesPerCall: stats(requests.map((r) => r.candidateIds.length)),
      peakConcurrency: peak,
      latencyMs: stats(calls.flatMap((c) => (c.latencyMs === null ? [] : [c.latencyMs]))),
      rateLimitErrors: requests.filter((r) => r.status === "rate_limited").length,
      failedRequests: requests.filter((r) => r.status === "failed").length,
      aborted: requests.filter((r) => r.status === "aborted").length,
      splits: requests.filter((r) => r.splitReason).length,
    },
    endToEnd: { wallClockMs: finishedAt.getTime() - startedAt.getTime(), firstVerifiedFindingMs: first(verified), firstPotentialContradictionMs: first(contradictions) },
    tokens: { input: tokens((c) => c.inputTokens), output: tokens((c) => c.outputTokens), cacheRead: tokens((c) => c.cacheReadTokens), cacheWrite: tokens((c) => c.cacheWrite5mTokens + c.cacheWrite1hTokens), outputPerCandidate: total ? round(tokens((c) => c.outputTokens) / total, 1) : null },
    cost: { totalUsd: round(usd, 6), perCandidate: per(total), perVerifiedFinding: per(verified.length), perPotentialContradiction: per(contradictions.length), maxReservedUsd: round(Math.max(0, ...held.map((h) => h.maxUsd)), 4), uncertainBilledUsd: round(sum(held.filter((h) => h.status === "uncertain").map((h) => h.maxUsd)), 4) },
    quality: {
      missingVerdictRate: total ? round(1 - new Set(rows.map((r) => r.c.id)).size / total, 3) : null,
      invalidVerdictRate: rows.length ? round(rows.filter((r) => r.v.status !== "valid").length / rows.length, 3) : null,
      citationVerificationRate: found.length ? round(verified.length / found.length, 3) : null,
      contaminationRate: total ? round(sum(requests.map((r) => r.contaminatedCandidateIds.length)) / total, 3) : null,
      degenerateVerdicts: rows.filter((r) => r.v.parsed && isDegenerate(r.v.parsed as { explanation: string })).map((r) => ({ candidateId: r.c.id, classification: (r.v.parsed as { classification: string }).classification, explanation: (r.v.parsed as { explanation: string }).explanation })),
      suspectedCrossReferences: sum(requests.map((r) => r.suspectedCandidateIds.length)),
      classifications: Object.fromEntries(["direct", "inferential", "false_positive", "insufficient_evidence"].map((k) => [k, found.filter((r) => r.f.type === k).length])),
      note: "Citation verification means the cited words exist where cited. It says nothing about whether a classification is right.",
    },
    accuracy,
  };
}

// Copies candidates into a strategy's own set, keeping each one's source ID. Re-running keeps them.
async function copyCandidates(db: Database, set: string, sourceIds: number[]) {
  const existing = await db.select({ id: candidates.id }).from(candidates).where(eq(candidates.candidateSet, set)).orderBy(asc(candidates.mergedRank));
  if (existing.length > 0) return existing.map((r) => r.id);
  const rows = await db.select().from(candidates).where(inArray(candidates.id, sourceIds));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: number[] = [];
  for (const [i, id] of sourceIds.entries()) {
    const { id: _id, createdAt: _created, ...c } = byId.get(id)!;
    const [row] = await db.insert(candidates).values({ ...c, candidateSet: set, jobId: null, status: "selected", deferredReason: null, mergedRank: i + 1, evidence: [{ path: "experiment", sourceCandidateId: id }] }).returning({ id: candidates.id });
    out.push(row.id);
  }
  return out;
}

// ------------------------------------------------------------ mock

async function mock() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("mock needs TEST_DATABASE_URL naming a database ending in _test.");
  const opened = await openTestDatabase();
  const db: Database = opened.db;
  const pool = opened.pool;
  await emptyTables(db);
  const [org] = await db.execute<{ id: string }>(sql`insert into orgs (name) values ('Mock') returning id`).then((r) => r.rows);
  const [kase] = await db.execute<{ id: string }>(sql`insert into cases (org_id, name) values (${org.id}, 'Mock') returning id`).then((r) => r.rows);
  const [wit] = await db.execute<{ id: string }>(sql`insert into witnesses (case_id, name) values (${kase.id}, 'Lawrence Ellison') returning id`).then((r) => r.rows);
  const target = { caseId: Number(kase.id), witnessId: Number(wit.id) };
  await ingestFile(db, new Uint8Array(readFileSync("data/raw/ellison/p3171.pdf")), { ...target, takenOn: "2004-01-20" }, "/private/tmp/adj-mock-uploads");
  const second = await ingestFile(db, new Uint8Array(readFileSync("data/raw/ellison/p3173.pdf")), { ...target, takenOn: null }, "/private/tmp/adj-mock-uploads");
  const pathB = (await findPathB(db, { witnessId: target.witnessId, depositionId: second.depositionId, mode: "rare_terms" })).pairs;
  const { selected, deferred } = selectCandidates(mergeCandidates({ fulltext: pathB }), { budget: 300 });
  await persistCandidates(db, { set: "mock-source", witnessId: target.witnessId, selected, deferred, jobId: null as never });
  const ids = (await db.select({ id: candidates.id }).from(candidates).where(and(eq(candidates.candidateSet, "mock-source"), eq(candidates.status, "selected"))).orderBy(asc(candidates.mergedRank))).map((r) => r.id);

  const runs: Record<string, unknown> = {};
  for (const id of ["A", "B", "C", "P", "D", "E", "F"] as StrategyId[]) {
    const set = `mock-${id}`;
    const copies = await copyCandidates(db, set, ids);
    const budgetId = await ensureBudget(db, set, 60);
    const single = mockSingle({ timeScale: MOCK_TIME_SCALE });
    const batch = mockBatch({ timeScale: MOCK_TIME_SCALE });
    const startedAt = new Date();
    const result = await executeAdjudication(db, { candidateSet: set, candidateIds: copies, strategy: id, budgetId, single, batch });
    const finishedAt = new Date();
    const m = await measureSet(db, set, startedAt, finishedAt, result.peak);
    const assumedModelMs = sum((await db.select({ ms: llmCalls.latencyMs }).from(llmCalls).innerJoin(adjudicationRequests, eq(adjudicationRequests.llmCallId, llmCalls.id)).where(eq(adjudicationRequests.candidateSet, set))).map((r) => r.ms ?? 0));
    runs[id] = {
      label: STRATEGIES[id].label,
      result: { adjudicated: result.adjudicated, failed: result.failed, stopped: result.stopped, peak: result.peak, mockPeak: Math.max(single.peak, batch.peak) },
      mockApiCalls: m.request.apiCalls,
      wallClockMsAtMockSpeed: m.endToEnd.wallClockMs,
      assumedSerialModelSeconds: Math.round(assumedModelMs / 1000),
      // The mock's waits are scaled, but database work isn't, so only the waits are scaled back up.
      pipelineOverheadMs: Math.round(m.endToEnd.wallClockMs - (assumedModelMs * MOCK_TIME_SCALE) / STRATEGIES[id].maxConcurrency),
      projectedWallClockSecondsAtAssumedSpeed: Math.round(assumedModelMs / STRATEGIES[id].maxConcurrency / 1000 + (m.endToEnd.wallClockMs - (assumedModelMs * MOCK_TIME_SCALE) / STRATEGIES[id].maxConcurrency) / 1000),
      findings: sum(Object.values(m.quality.classifications)),
      citationVerificationRate: m.quality.citationVerificationRate,
      missingVerdictRate: m.quality.missingVerdictRate,
      costUsdAtMockTokens: m.cost.totalUsd,
      maxReservedUsd: m.cost.maxReservedUsd,
      latencyMsAssumed: m.request.latencyMs,
    };
    console.log(id, JSON.stringify(runs[id]));
  }
  writeJson("mock-results.json", {
    warning: "MOCK. No model was called. Every number measures this pipeline around a deterministic stand-in. Latencies, tokens and costs are assumptions, not model performance, and the mock gives every pair the same compatible verdict, so accuracy can't be read from this.",
    timeScale: MOCK_TIME_SCALE,
    candidates: ids.length,
    source: "300 Path B candidates from a fresh ingestion of P3171 and P3173 in the test database",
    runs,
  });
  await pool.end();
}

// ------------------------------------------------------------ live

async function live(db: Database, values: { runId?: string; strategy?: string; approveUsd?: string; approved?: boolean }) {
  const { runId, strategy, approveUsd, approved } = values;
  if (!runId || !/^[a-z0-9][a-z0-9-]{2,60}$/.test(runId)) throw new Error("live needs --run-id <lowercase-id>.");
  if (!strategy || !STRATEGY_IDS.includes(strategy as StrategyId)) throw new Error(`--strategy must be one of ${STRATEGY_IDS.join(", ")}.`);
  const limit = Number(approveUsd);
  if (!(limit > 0)) throw new Error("live needs --approve-usd <shared limit>.");
  if (!approved) throw new Error("live makes paid calls: add --i-approve-paid-calls once the budget has been approved.");
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("No ANTHROPIC_API_KEY.");
  if (!existsSync(SAMPLE_FILE)) throw new Error("Run `estimate` first: it fixes the sample.");
  const id = strategy as StrategyId;
  const out = `runs/${runId}/${id}`;
  if (existsSync(path.join(DIR, out, "results.json"))) throw new Error(`${out}/results.json exists; results are never overwritten. Use a new run ID.`);
  const { items } = JSON.parse(readFileSync(SAMPLE_FILE, "utf8")) as { items: SampleItem[] };
  const set = `exp-${runId}-${id}`;
  const copies = await copyCandidates(db, set, items.map((s) => s.candidateId));
  const done = new Set((await db.select({ id: verdicts.candidateId }).from(verdicts).where(inArray(verdicts.candidateId, copies))).map((r) => r.id));
  const budgetId = await ensureBudget(db, `exp-${runId}`, limit);

  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  process.once("SIGTERM", () => stop.abort());
  const startedAt = new Date();
  const result = await executeAdjudication(db, {
    candidateSet: set,
    candidateIds: copies.filter((c) => !done.has(c)),
    strategy: id,
    budgetId,
    single: usesBatchFormat(id) ? undefined : anthropicAdjudicator("medium", LIVE_PROMPT),
    batch: usesBatchFormat(id) ? anthropicBatchAdjudicator("medium") : undefined,
    signal: stop.signal,
  });
  const finishedAt = new Date();
  const measured = await measureSet(db, set, startedAt, finishedAt, result.peak, items);
  const [b] = await db.select().from(budgets).where(eq(budgets.id, budgetId));
  const report = { runId, strategy: STRATEGIES[id], model: MODEL, promptVersion: usesBatchFormat(id) ? BATCH_PROMPT_VERSION : LIVE_PROMPT, promptSha256: PROMPT_INFO[usesBatchFormat(id) ? BATCH_PROMPT_VERSION : LIVE_PROMPT].sha256, startedAt, finishedAt, stopped: result.stopped, lastError: result.lastError, budget: { limitUsd: b.limitUsd, spentUsd: b.spentUsd }, ...measured };
  // An unfinished run writes its partial results beside the place the final ones go.
  write(`${out}/${result.stopped ? `partial-${Date.now()}` : "results"}.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ stopped: result.stopped, wallClockMs: report.endToEnd.wallClockMs, costUsd: report.cost.totalUsd, accuracy: report.accuracy }, null, 2));
}

// Writes a strategy's results from what is stored, for a run whose report wasn't written. No API call.
async function reportStored(db: Database, runId: string, id: StrategyId) {
  const out = `runs/${runId}/${id}`;
  if (existsSync(path.join(DIR, out, "results.json"))) throw new Error(`${out}/results.json exists; results are never overwritten.`);
  const { items } = JSON.parse(readFileSync(SAMPLE_FILE, "utf8")) as { items: SampleItem[] };
  const set = `exp-${runId}-${id}`;
  const requests = await db.select().from(adjudicationRequests).where(eq(adjudicationRequests.candidateSet, set));
  if (requests.length === 0) throw new Error(`No requests stored for ${set}.`);
  const startedAt = new Date(Math.min(...requests.map((r) => r.startedAt.getTime())));
  const finishedAt = new Date(Math.max(...requests.map((r) => (r.finishedAt ?? r.startedAt).getTime())));
  const events = requests.flatMap((r) => [[r.startedAt.getTime(), 1], [(r.finishedAt ?? r.startedAt).getTime(), -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let now = 0;
  let peak = 0;
  for (const [, change] of events) peak = Math.max(peak, (now += change));
  const measured = await measureSet(db, set, startedAt, finishedAt, peak, items);
  const prompt = usesBatchFormat(id) ? BATCH_PROMPT_VERSION : LIVE_PROMPT;
  writeJson(`${out}/results.json`, { runId, strategy: STRATEGIES[id], model: MODEL, promptVersion: prompt, promptSha256: PROMPT_INFO[prompt].sha256, startedAt, finishedAt, reportedFromStoredRows: true, ...measured });
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { "run-id": { type: "string" }, strategy: { type: "string" }, "approve-usd": { type: "string" }, "i-approve-paid-calls": { type: "boolean" } } });
  const command = positionals[0];
  if (command === "mock") return mock();
  if (!["estimate", "live", "report"].includes(command ?? "")) throw new Error("Usage: npx tsx scripts/adjudication-experiment.ts estimate|mock|live|report (see the top of this file)");
  const { db, pool } = connect();
  try {
    if (command === "estimate") {
      const { value } = await estimate(db);
      console.log(JSON.stringify({ sample: value.sampleOf40.map((e) => [e.strategy, e.requests, e.expectedUsd, e.expectedUsdLargeOutput, e.usdIfEveryRequestMissesTheCache, e.worstCaseEveryRequestAtMaxTokens, e.peakReservedUsd, e.projectedSeconds]), full: value.full300PathAPlusB.map((e) => [e.strategy, e.requests, e.expectedUsd, e.expectedUsdLargeOutput, e.worstCaseEveryRequestAtMaxTokens, e.peakReservedUsd, e.projectedSeconds]), proposals: value.proposals, whole: value.wholeCaseInOneRequest, recorded: value.recorded }, null, 1));
    } else if (command === "report") await reportStored(db, values["run-id"] ?? "", values.strategy as StrategyId);
    else await live(db, { runId: values["run-id"], strategy: values.strategy, approveUsd: values["approve-usd"], approved: values["i-approve-paid-calls"] });
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
