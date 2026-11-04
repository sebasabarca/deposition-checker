// The ingest worker: a separate process from the API, so parsing never slows down a request.
// Start it with `npm run worker` (or `npm run dev`, which starts it with the server and client).

import "dotenv/config";
import { anthropicAdjudicator, anthropicDiscovery, type PromptVersion } from "./adjudicate";
import { anthropicCardModel, anthropicTopicModel } from "./claims";
import type { Effort } from "./adjudicate/prompt";
import { connect } from "./db/client";
import { anthropicPacketAdjudicator } from "./adjudicate/packetModel";
import { createAnalysisQueues, createCaseRunQueues, createIngestQueues, fromPacketAdjudicator, paidCallsAllowed, startAnalysisWorkers, startBoss, startCaseRunWorkers, startIngestWorkers } from "./jobs";

async function main() {
  const { db, pool } = connect();
  const boss = await startBoss(process.env.DATABASE_URL!, { supervise: true });
  await createIngestQueues(boss);
  await createAnalysisQueues(boss);
  await createCaseRunQueues(boss);
  await startIngestWorkers(boss, db);
  const shuttingDown = new AbortController();
  await startAnalysisWorkers(boss, db, {
    signal: shuttingDown.signal,
    liveAdjudicator: (a) => (paidCallsAllowed(process.env) ? anthropicAdjudicator(a.effort as Effort, a.promptVersion as PromptVersion) : null),
    liveCardModels: () => (paidCallsAllowed(process.env) ? { cards: anthropicCardModel(), topics: anthropicTopicModel() } : null),
    discovery: () => (paidCallsAllowed(process.env) ? anthropicDiscovery() : null),
  });
  // Whole-case runs: packet-v1 only, so the worker never sends an experimental contract.
  await startCaseRunWorkers(boss, db, pool, {
    signal: shuttingDown.signal,
    adjudicator: () => (paidCallsAllowed(process.env) ? fromPacketAdjudicator(anthropicPacketAdjudicator()) : null),
  });
  console.log(`Worker running (ingest and analysis; paid model calls ${paidCallsAllowed(process.env) ? "ALLOWED" : "off"})`);

  // An unfinished job is redelivered by pg-boss, and stops at once if it was a paid one.
  // A running analysis stops dispatching and aborts what is in flight, then records itself interrupted.
  const shutdown = async () => {
    shuttingDown.abort();
    await boss.stop({ graceful: true });
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
