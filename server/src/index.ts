import "dotenv/config";
import express from "express";
import { analysisRoutes, caseRoutes, depositionRoutes } from "./api";
import { connect } from "./db/client";
import { createAnalysisQueues, createIngestQueues, startBoss } from "./jobs";

const app = express();
app.use(express.json({ limit: "200kb" }));

// The API needs Postgres; if it can't be reached, the server still starts and says so. Parsing runs in the worker process (server/src/worker.ts).
async function mountDepositionRoutes() {
  try {
    const { db, pool } = connect();
    const boss = await startBoss(process.env.DATABASE_URL!, { supervise: false });
    await createIngestQueues(boss);
    await createAnalysisQueues(boss);
    app.use("/api", caseRoutes({ db }));
    app.use("/api", analysisRoutes({ db, pool, boss }));
    app.use("/api", depositionRoutes({ db, pool, boss }));
  } catch (error) {
    console.warn(
      `Deposition endpoints are off: ${error instanceof Error ? error.message : error}`,
    );
  }
}

const PORT = Number(process.env.PORT ?? 3001);
mountDepositionRoutes().then(() =>
  app.listen(PORT, () =>
    console.log(`Server running on http://localhost:${PORT}`),
  ),
);
