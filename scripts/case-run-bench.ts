// Free, mock-only benchmark of whole-case adjudication throughput (no API key, no paid call).
//
//   npx tsx scripts/case-run-bench.ts --database-env PERF_DATABASE_URL --load
//       wipes that database (its name must end in "_perf_test"), migrates it and loads the real fixtures
//   npx tsx scripts/case-run-bench.ts --database-env PERF_DATABASE_URL --latency-ms 100 [--rate-limit-every 50] [--label seq]
//       one "live" run of the loaded case with a fake provider: priced as the packet model, so budget
//       reservations, llm_calls and settlement follow the paid path, but every reply is the deterministic
//       label-blind mock after a fixed latency. Every Nth packet (by a hash of its id) answers its first
//       request with a 429. Prints one JSON line: timings, query counts, retries, duplicates, budget, and a
//       fingerprint of every verdict and finding keyed by the candidate's passages (not its row id), so runs
//       can be compared for identical results.
//
// Mock latency measures the pipeline's own overhead and how well it overlaps waiting; it says nothing about
// the real provider's throughput or rate limits.

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { PACKET_MODEL, type IssuePacket } from "../server/src/adjudicate/packetPrompt";
import { connect } from "../server/src/db/client";
import { candidates, caseRuns, cases, findings, verdicts } from "../server/src/db/schema";
import { loadEvidenceFixtures, missingFixtureFiles, openEvaluationDatabase, readEvidenceFixture } from "../server/src/eval/evidenceFixtures";
import { mockPacketReply } from "../server/src/eval/mockPacketModel";
import { caseRunReport, caseRunSetOf, confirmCaseRun, createCaseRun, runCaseRun, type CasePacketModel } from "../server/src/jobs/caseRun";
import { ProviderLimiter, UNLIMITED } from "../server/src/jobs/limiter";

const { values } = parseArgs({
  options: {
    "database-env": { type: "string" }, load: { type: "boolean" }, "latency-ms": { type: "string", default: "100" },
    "rate-limit-every": { type: "string", default: "0" }, label: { type: "string", default: "" }, budget: { type: "string", default: "10000" },
    concurrency: { type: "string", default: "1" }, "pool-max": { type: "string", default: "10" }, "profile-queries": { type: "boolean" },
  },
});

const hashOf = (s: string) => createHash("sha256").update(s).digest();

// The fake provider. Deterministic: the same packet always gets the same reply, latency and injected error.
function fakeProvider(latencyMs: number, rateLimitEvery: number) {
  const stats = { requests: 0, rateLimited: 0, replies: 0, inFlight: 0, peakInFlight: 0, limited: new Set<string>(), repliesByPacket: new Map<string, number>() };
  const model: CasePacketModel = {
    model: PACKET_MODEL, effort: "medium", promptVersion: "packet-v1",
    async adjudicate(packet: IssuePacket) {
      stats.requests++;
      stats.inFlight++;
      stats.peakInFlight = Math.max(stats.peakInFlight, stats.inFlight);
      try {
        await new Promise((ok) => setTimeout(ok, latencyMs));
        const first = !stats.limited.has(packet.id);
        if (rateLimitEvery > 0 && first && hashOf(packet.id).readUInt32BE(0) % rateLimitEvery === 0) {
          stats.limited.add(packet.id);
          stats.rateLimited++;
          throw new Anthropic.RateLimitError(429, { type: "error", error: { type: "rate_limit_error", message: "injected" } }, "injected 429", new Headers({ "retry-after": "1" }));
        }
        const m = mockPacketReply(packet);
        stats.replies++;
        stats.repliesByPacket.set(packet.id, (stats.repliesByPacket.get(packet.id) ?? 0) + 1);
        const usage = { input_tokens: m.usage.inputTokens, output_tokens: m.usage.outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } as Awaited<ReturnType<CasePacketModel["adjudicate"]>>["usage"];
        return { model: PACKET_MODEL, stopReason: "end_turn", usage, text: m.text, latencyMs, requestId: `fake-${stats.requests}` };
      } finally {
        stats.inFlight--;
      }
    },
  };
  return { model, stats };
}

// Counts every query the process sends, the most connections the pool held at once, and how often (and how
// many) queries waited for a free connection: the pool's saturation.
function instrument(pool: pg.Pool) {
  const counts = { queries: 0, peakConnections: 0, peakWaiting: 0, samples: 0, samplesWaiting: 0, byStatement: new Map<string, number>() };
  const original = pg.Client.prototype.query;
  pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
    counts.queries++;
    const text = typeof args[0] === "string" ? args[0] : ((args[0] as { text?: string } | undefined)?.text ?? "?");
    const key = text.replace(/\s+/g, " ").replace(/\$\d+/g, "?").slice(0, 90);
    counts.byStatement.set(key, (counts.byStatement.get(key) ?? 0) + 1);
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  } as typeof original;
  const timer = setInterval(() => {
    counts.peakConnections = Math.max(counts.peakConnections, pool.totalCount);
    counts.peakWaiting = Math.max(counts.peakWaiting, pool.waitingCount);
    counts.samples++;
    if (pool.waitingCount > 0) counts.samplesWaiting++;
  }, 20);
  return { counts, stop: () => clearInterval(timer) };
}

async function main() {
  const name = values["database-env"];
  const url = name ? process.env[name] : undefined;
  if (!url || !new URL(url).pathname.endsWith("_perf_test")) throw new Error("Name a database ending in _perf_test with --database-env <ENV_VAR>; the benchmark writes to it.");
  if (values.load) {
    const fixture = readEvidenceFixture();
    const missing = missingFixtureFiles(fixture);
    if (missing.length) throw new Error(`Missing fixture files:\n  ${missing.join("\n  ")}`);
    const { db, pool } = await openEvaluationDatabase(url);
    const loaded = await loadEvidenceFixtures(db, fixture);
    await pool.end();
    return console.log(`loaded case ${loaded.caseId}`);
  }

  const { db, pool } = connect(url, { max: Number(values["pool-max"]) });
  try {
    const [{ caseId }] = await db.select({ caseId: cases.id }).from(cases).limit(1);
    const latencyMs = Number(values["latency-ms"]);
    const { model, stats } = fakeProvider(latencyMs, Number(values["rate-limit-every"]));
    const concurrency = Number(values.concurrency);
    // Unlimited provider buckets: the mock measures the pipeline. Injected 429s still pause every lane, for the
    // retry-after (1 s) on a virtual clock that advances instead of waiting.
    let skew = 0;
    const limiter = new ProviderLimiter({ ...UNLIMITED, maxInFlight: concurrency }, { now: () => Date.now() + skew, sleep: async (ms) => { skew += ms; } });
    const deps = { adjudicator: () => model, minilm: "off" as const, concurrency, limiter };

    const run = await createCaseRun(db, caseId, { mode: "live", budgetUsd: Number(values.budget) });
    const t0 = performance.now();
    const afterRetrieval = await runCaseRun(db, pool, run.id, deps);
    const retrievalMs = performance.now() - t0;
    if (afterRetrieval !== "awaiting_confirmation") throw new Error(`retrieval ended ${afterRetrieval}`);
    await confirmCaseRun(db, run.id, { budgetUsd: Number(values.budget) });

    const probe = instrument(pool);
    const t1 = performance.now();
    const status = await runCaseRun(db, pool, run.id, deps);
    const adjudicationMs = performance.now() - t1;
    probe.stop();

    const report = (await caseRunReport(db, run.id))!;
    const [{ calls, cost }] = (await db.execute<{ calls: number; cost: string }>(sql`select count(*)::int as calls, coalesce(sum(l.cost_usd), 0)::text as cost from adjudication_requests r join llm_calls l on l.id = r.llm_call_id where r.candidate_set = ${caseRunSetOf(run.id)}`)).rows;
    // Every verdict and finding, keyed by the candidate's two passages so different runs compare.
    const rows = await db
      .select({ a: candidates.depositionA, ga: candidates.groupA, b: candidates.depositionB, gb: candidates.groupB, parsed: verdicts.parsed, type: findings.type, score: findings.score, band: findings.band, status: findings.evidenceStatus })
      .from(verdicts).innerJoin(candidates, eq(candidates.id, verdicts.candidateId)).leftJoin(findings, eq(findings.verdictId, verdicts.id))
      .where(eq(candidates.candidateSet, caseRunSetOf(run.id)));
    const keyed = rows.map((r) => `${r.a}:${r.ga}|${r.b}:${r.gb} ${JSON.stringify([r.parsed, r.type, r.score, r.band, r.status])}`).sort();
    const verdictsPerCandidate = await db.execute<{ n: number }>(sql`select count(*)::int as n from (select v.candidate_id from verdicts v join candidates c on c.id = v.candidate_id where c.candidate_set = ${caseRunSetOf(run.id)} group by 1 having count(*) > 1) d`);
    const packets = report.packets.total;
    const [{ runSeconds }] = (await db.execute<{ runSeconds: number }>(sql`select extract(epoch from (finished_at - started_at))::float as "runSeconds" from case_runs where id = ${run.id}`)).rows;
    void caseRuns;
    console.log(JSON.stringify({
      label: values.label, runId: run.id, status, concurrency, latencyMs, packets,
      retrievalSeconds: +(retrievalMs / 1000).toFixed(1), adjudicationSeconds: +(adjudicationMs / 1000).toFixed(1), runSeconds: +runSeconds.toFixed(1),
      packetsPerMinute: Math.round(packets / (adjudicationMs / 60_000)),
      wallMsPerPacket: +(adjudicationMs / packets).toFixed(1),
      db: { queries: probe.counts.queries, queriesPerPacket: +(probe.counts.queries / packets).toFixed(1), queriesPerSecond: Math.round(probe.counts.queries / (adjudicationMs / 1000)), peakConnections: probe.counts.peakConnections, poolMax: pool.options.max, peakWaitingForConnection: probe.counts.peakWaiting, shareOfTimeSaturated: +(probe.counts.samplesWaiting / Math.max(1, probe.counts.samples)).toFixed(3) },
      provider: { requests: stats.requests, replies: stats.replies, rateLimited: stats.rateLimited, peakInFlight: stats.peakInFlight, sharedPauses: limiter.stats.pauses, duplicateReplies: [...stats.repliesByPacket.values()].reduce((n, c) => n + c - 1, 0) },
      budget: { ...report.cost.budget, recordedCalls: calls, recordedCostUsd: Number(cost) },
      coverage: { state: report.coverageState, ...report.candidates, deferredByStage: undefined },
      packetStates: report.packets,
      requests: report.requests,
      ...(values["profile-queries"] ? { statementsPerPacket: Object.fromEntries([...probe.counts.byStatement].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, n]) => [k, +(n / packets).toFixed(2)])) } : {}),
      findings: { verdicts: rows.length, findings: rows.filter((r) => r.type !== null).length, candidatesWithTwoVerdicts: verdictsPerCandidate.rows[0].n, fingerprint: createHash("sha256").update(keyed.join("\n")).digest("hex").slice(0, 16) },
    }));
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exitCode = 1;
});
