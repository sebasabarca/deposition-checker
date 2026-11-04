import "dotenv/config";
import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import { sql } from "drizzle-orm";
import { analysisRoutes, caseRunRoutes, caseRoutes, depositionRoutes, reportRoutes } from "./api";
import { accountGates, authRoutes, requireUser, sameOrigin, scopeToOrg } from "./auth";
import { connect } from "./db/client";
import { createAnalysisQueues, createCaseRunQueues, createIngestQueues, startBoss } from "./jobs";

const app = express();
app.disable("x-powered-by");
// Behind a load balancer or reverse proxy, set TRUST_PROXY (for example "1") so client IPs and
// HTTPS are read from its headers.
if (process.env.TRUST_PROXY) app.set("trust proxy", /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY);

// The app loads nothing from other origins: fonts and icons are bundled, and the original PDF is
// framed from this server. The policy says so, so injected content can't reach out.
app.use((_req, res, next) => {
  res.set({
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
  });
  next();
});
app.use(express.json({ limit: "200kb" }));

// The API needs Postgres; if it can't be reached, the server still starts and says so. Parsing runs in the worker process (server/src/worker.ts).
async function mountDepositionRoutes() {
  try {
    const { db, pool } = connect();
    const boss = await startBoss(process.env.DATABASE_URL!, { supervise: false });
    await createIngestQueues(boss);
    await createAnalysisQueues(boss);
    await createCaseRunQueues(boss);
    // For a load balancer or container health check: 200 only while the database answers.
    app.get("/api/health", async (_req, res) => {
      try {
        await db.execute(sql`select 1`);
        res.json({ ok: true });
      } catch {
        res.status(503).json({ ok: false, error: "The database isn't reachable." });
      }
    });
    // Sign-in is open; everything after it needs a session, and sees only the user's organization.
    app.use("/api", authRoutes(db));
    app.use("/api", sameOrigin, requireUser(db), scopeToOrg(db), accountGates());
    app.use("/api", caseRoutes({ db }));
    app.use("/api", analysisRoutes({ db, pool, boss }));
    app.use("/api", caseRunRoutes({ db, boss }));
    app.use("/api", depositionRoutes({ db, pool, boss }));
    app.use("/api", reportRoutes({ db }));
  } catch (error) {
    console.warn(
      `Deposition endpoints are off: ${error instanceof Error ? error.message : error}`,
    );
  }
}

// In production the built client (npm run build) is served from here, so one process serves the
// app and its API. Routes are hash-based, so only index.html and its assets are needed.
const CLIENT_DIST = path.resolve(process.env.CLIENT_DIST ?? "client/dist");
function mountClient() {
  app.use("/api", (_req, res) => res.status(404).json({ error: "No such endpoint." }));
  if (!existsSync(path.join(CLIENT_DIST, "index.html"))) return;
  // Hashed asset files never change, so they can be cached for a year; index.html is revalidated.
  app.use(express.static(CLIENT_DIST, { setHeaders: (res, file) => res.set("Cache-Control", file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache") }));
}

const PORT = Number(process.env.PORT ?? 3001);
mountDepositionRoutes().then(() => {
  mountClient();
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
});
