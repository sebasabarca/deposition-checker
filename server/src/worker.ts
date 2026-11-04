// The ingest worker: a separate process from the API, so parsing never slows down a request.
// Start it with `npm run worker` (or `npm run dev`, which starts it with the server and client).

import "dotenv/config";
import { anthropicAdjudicator, anthropicDiscovery, type PromptVersion } from "./adjudicate";
import { anthropicCardModel, anthropicTopicModel } from "./claims";
import type { Effort } from "./adjudicate/prompt";
import { connect } from "./db/client";
import { caseRunSettings, ProviderLimiter } from "./jobs/limiter";
import { anthropicPacketAdjudicator } from "./adjudicate/packetModel";
import { anthropicPacketBatches } from "./adjudicate/packetBatch";
import { FakeBatchProvider } from "./eval/mockPacketBatch";
import { batchSettings } from "./jobs/caseRunBatch";
import { createAnalysisQueues, createCaseRunQueues, createIngestQueues, fromPacketAdjudicator, paidCallsAllowed, startAnalysisWorkers, startBoss, startCaseRunWorkers, startIngestWorkers } from "./jobs";

const SHUTDOWN_GRACE_MS = 60_000;

async function main() {
  const { db, pool } = connect();
  const boss = await startBoss(process.env.DATABASE_URL!, { supervise: true });
  await createIngestQueues(boss);
  await createAnalysisQueues(boss);
  await createCaseRunQueues(boss);
  await startIngestWorkers(boss, db);
  const shuttingDown = new AbortController();
  const draining = new AbortController(); // case runs stop claiming packets; requests in flight may finish
  await startAnalysisWorkers(boss, db, {
    signal: draining.signal, // analyses abort at once on shutdown, as before
    liveAdjudicator: (a) => (paidCallsAllowed(process.env) ? anthropicAdjudicator(a.effort as Effort, a.promptVersion as PromptVersion) : null),
    liveCardModels: () => (paidCallsAllowed(process.env) ? { cards: anthropicCardModel(), topics: anthropicTopicModel() } : null),
    discovery: () => (paidCallsAllowed(process.env) ? anthropicDiscovery() : null),
  });
  // Whole-case runs: packet-v1 only, so the worker never sends an experimental contract. Concurrency and the
  // provider's limits come from the environment (jobs/limiter.ts, caseRunSettings); one limiter serves every run.
  const caseRuns = caseRunSettings(process.env);
  // Economy runs: the Message Batches API when paid calls are allowed. Test-model runs use the in-process fake
  // provider (no network); its batches live in this process, so a worker restart loses them and the run sees
  // them as missing, which exercises the same recovery as a real lost result.
  const batches = batchSettings(process.env);
  const live = paidCallsAllowed(process.env) ? anthropicPacketBatches() : null;
  const fake = new FakeBatchProvider({ processingMs: 4_000 });
  await startCaseRunWorkers(
    boss, db, pool,
    {
      signal: shuttingDown.signal,
      drain: draining.signal,
      concurrency: caseRuns.packetsPerCase,
      limiter: new ProviderLimiter(caseRuns.limits),
      adjudicator: () => (paidCallsAllowed(process.env) ? fromPacketAdjudicator(anthropicPacketAdjudicator()) : null),
      batch: (run) => (run.mode === "mock" ? { provider: fake, settings: batches } : live ? { provider: live, settings: batches } : null),
    },
    { maxCases: caseRuns.maxCases, batchPollSeconds: batches.pollSeconds },
  );
  console.log(`Worker running (ingest, analysis and case runs; paid model calls ${paidCallsAllowed(process.env) ? "ALLOWED" : "off"}; case runs: ${caseRuns.maxCases} at once, ${caseRuns.packetsPerCase} packets each, ${caseRuns.limits.maxInFlight} packets in all)`);

  // An unfinished job is redelivered by pg-boss, and stops at once if it was a paid one.
  // A running analysis stops dispatching and aborts what is in flight, then records itself interrupted.
  // Case runs first get SHUTDOWN_GRACE_MS to finish the requests they have in flight (a request aborted mid-way
  // may have been billed, and is never retried automatically); then everything in flight is aborted.
  const shutdown = async () => {
    draining.abort();
    setTimeout(() => shuttingDown.abort(), SHUTDOWN_GRACE_MS).unref();
    await boss.stop({ graceful: true, timeout: SHUTDOWN_GRACE_MS + 15_000 });
    await pool.end();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
