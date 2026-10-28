// The ingest worker: a separate process from the API, so parsing never slows down a request.
// Start it with `npm run worker` (or `npm run dev`, which starts it with the server and client).

import "dotenv/config";
import { connect } from "./db/client";
import { createIngestQueues, startBoss, startIngestWorkers } from "./jobs";

async function main() {
  const { db, pool } = connect();
  const boss = await startBoss(process.env.DATABASE_URL!, { supervise: true });
  await createIngestQueues(boss);
  await startIngestWorkers(boss, db);
  console.log("Ingest worker running");

  // Finish the job in hand before exiting; an unfinished one is retried by pg-boss.
  const shutdown = async () => {
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
