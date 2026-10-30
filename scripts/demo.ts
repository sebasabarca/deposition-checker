// Prepares the local demonstration (no model calls, nothing deleted). Needs the API server and the
// worker running (`npm run dev`), and Postgres with the Ellison depositions already ingested.
//
//   npx tsx scripts/demo.ts [--fresh]
//
// 1. Stores the synthetic fixture suites (Marcus Webb, Dana Whitfield) if they aren't stored yet.
// 2. Starts demo analyses through the API, exactly as the app does:
//    - U.S. v. Oracle, Lawrence Ellison, both sessions: replays the stored Sonnet verdicts;
//    - Marcus Webb (synthetic), with prompt adjudicate-v2: replays the stored v2 Sonnet verdicts.
//    A completed demo analysis of the same pair is reused (--fresh starts a new one), and one
//    already running is never duplicated.
// 3. Prints the links to open.

import "dotenv/config";
import { connect } from "../server/src/db/client";
import { SYNTHETIC_SUITES } from "../server/src/eval/synthetic";
import { storeSynthetic } from "../server/src/eval/syntheticStore";

const API = process.env.DEMO_API ?? "http://localhost:3001/api";
const APP = process.env.DEMO_APP ?? "http://localhost:5173";

type CaseDetail = { case: { id: number; name: string }; witnesses: { id: number; name: string }[]; depositions: { id: number; witnessId: number; status: string; takenOn: string | null }[] };

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(`${method} ${path}: ${data.error ?? res.status}`);
  return data;
}

async function startDemo(caseName: string, witness: string, promptVersion?: string) {
  const { cases } = await call<{ cases: { id: number; name: string }[] }>("GET", "/cases");
  const kase = cases.find((c) => c.name === caseName);
  if (!kase) return console.log(`- ${caseName}: not in this database; skipped.`);
  const detail = await call<CaseDetail>("GET", `/cases/${kase.id}`);
  const w = detail.witnesses.find((x) => x.name === witness);
  const ready = detail.depositions.filter((d) => d.witnessId === w?.id && d.status === "ready");
  if (ready.length < 2) return console.log(`- ${caseName}: fewer than two ready sessions of ${witness}; skipped.`);
  // Reuse the latest completed demo analysis of this pair, unless --fresh is given.
  const { analyses } = await call<{ analyses: { id: number; mode: string; status: string; promptVersion: string; depositions: { id: number }[] }[] }>("GET", `/cases/${kase.id}/analyses`);
  const done = analyses.find(
    (a) => a.mode === "demo" && a.status === "completed" && a.promptVersion === (promptVersion ?? a.promptVersion) && a.depositions.map((d) => d.id).join() === `${ready[0].id},${ready[1].id}`,
  );
  if (done && !process.argv.includes("--fresh")) return console.log(`- ${caseName}: analysis #${done.id} already complete → ${APP}/#/analyses/${done.id}`);
  const { analysis, created } = await call<{ created: boolean; analysis: { id: number } }>("POST", `/cases/${kase.id}/analyses`, {
    depositionA: ready[0].id,
    depositionB: ready[1].id,
    mode: "demo",
    ...(promptVersion ? { promptVersion } : {}),
  });
  console.log(`- ${caseName}: analysis #${analysis.id} ${created ? "started" : "already running"} → ${APP}/#/analyses/${analysis.id}`);
}

async function main() {
  const { db, pool } = connect();
  try {
    for (const suite of SYNTHETIC_SUITES) {
      const ids = await storeSynthetic(db, suite);
      console.log(`Fixture suite ${suite.set}: ${ids.size} candidates stored.`);
    }
  } finally {
    await pool.end();
  }
  await startDemo("U.S. v. Oracle", "Lawrence Ellison");
  await startDemo("Synthetic: Marcus Webb (fixture)", "Marcus Webb", "adjudicate-v2");
  console.log(`Open ${APP} and choose a case. Demo analyses make no model calls.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
