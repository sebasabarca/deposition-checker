// Whole-case runs from the command line, in this process (no worker needed). The database is named by an
// environment variable, never defaulted, so the demo database is never used by accident.
//
//   --plan                     free: builds the case pool and packets, writes nothing, projects the cost
//   --mock                     free: a full run with the label-blind mock (no model, no budget)
//   --live --budget <usd> --execute
//                              PAID: packet-v1 on Sonnet, under the budget. Needs ANTHROPIC_API_KEY and
//                              ALLOW_PAID_CALLS=true, and the developer's approval with a stated USD limit.
//   --concurrency <n>          packets in flight at once (default 1); the provider limits come from the
//                              environment (PROVIDER_* in jobs/limiter.ts), conservative by default
//   --economy                  with --mock or --live: economy execution through the Message Batches API (half
//                              price, up to 24 hours; jobs/caseRunBatch.ts). --mock uses the fake provider. A
//                              live economy run also needs --acknowledge-retention: the provider stores batch
//                              inputs and results for 29 days (not zero data retention). The command checks the
//                              batches every CASE_RUN_BATCH_POLL_SECONDS until the run stops; Ctrl-C is safe and a
//                              later --resume <runId> --execute carries on from the database
//   --resume <runId> [--budget <usd>] [--retry-uncertain] [--execute]
//                              continues a stopped run; incomplete packets and failures known not to have been
//                              billed are tried again; --retry-uncertain also retries ones that may have been billed
//
// A --live run here counts as confirmed by the command itself (its --budget and --execute); over the API a live
// run stops after retrieval until confirmed.
// npx tsx scripts/case-run.ts --database-env EVAL_DATABASE_URL --case 1 --plan

import "dotenv/config";
import { parseArgs } from "node:util";
import { sql } from "drizzle-orm";
import { anthropicPacketAdjudicator } from "../server/src/adjudicate/packetModel";
import { anthropicPacketBatches } from "../server/src/adjudicate/packetBatch";
import { FakeBatchProvider } from "../server/src/eval/mockPacketBatch";
import { batchSettings } from "../server/src/jobs/caseRunBatch";
import { connect } from "../server/src/db/client";
import { COST_ASSUMPTIONS, projectCost } from "../server/src/eval/screeningBenchmark";
import { paidCallsAllowed } from "../server/src/jobs/analysis";
import { caseRunReport, createCaseRun, fromPacketAdjudicator, resumeCaseRun, runCaseRun, type CaseRunDeps } from "../server/src/jobs/caseRun";
import { caseRunSettings, ProviderLimiter } from "../server/src/jobs/limiter";
import { buildCasePool } from "../server/src/retrieve/casePool";
import { INSTRUCTION_TOKENS } from "../server/src/retrieve/grouping";
import { splitPacketSet } from "../server/src/retrieve/packetSplit";

const { values } = parseArgs({
  options: {
    "database-env": { type: "string" }, case: { type: "string" }, plan: { type: "boolean" }, mock: { type: "boolean" }, live: { type: "boolean" },
    budget: { type: "string" }, execute: { type: "boolean" }, "retry-uncertain": { type: "boolean" }, resume: { type: "string" }, minilm: { type: "string", default: "off" }, concurrency: { type: "string", default: "1" },
    economy: { type: "boolean" }, "acknowledge-retention": { type: "boolean" },
  },
});

async function main() {
  const name = values["database-env"];
  if (!name || !process.env[name]) throw new Error("Name the database with --database-env <ENV_VAR> (for example EVAL_DATABASE_URL).");
  const url = process.env[name]!;
  if (name !== "DATABASE_URL" && url === process.env.DATABASE_URL) throw new Error(`${name} points at DATABASE_URL, the app (demo) database. Use a dedicated database.`);
  const { db, pool } = connect(url);
  const minilm = values.minilm === "auto" ? "auto" : "off";
  const adjudicator = () => (paidCallsAllowed(process.env) ? fromPacketAdjudicator(anthropicPacketAdjudicator()) : null);
  const concurrency = Number(values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--concurrency takes a whole number of at least 1.");
  const limiter = new ProviderLimiter({ ...caseRunSettings(process.env).limits, maxInFlight: concurrency });
  const settings = batchSettings(process.env);
  const live = paidCallsAllowed(process.env) ? anthropicPacketBatches() : null;
  const fake = new FakeBatchProvider();
  const execution: CaseRunDeps = { adjudicator, minilm, concurrency, limiter, batch: (r) => (r.mode === "mock" ? { provider: fake, settings } : live ? { provider: live, settings } : null) };
  // An economy run is checked again until it stops; a standard run returns at once.
  const runUntilStopped = async (id: number) => {
    for (;;) {
      const out = await runCaseRun(db, pool, id, execution);
      if (out !== "polling") return out;
      const [r] = await db.execute<{ mode: string }>(sql`select mode from case_runs where id = ${id}`).then((x) => x.rows);
      await new Promise((ok) => setTimeout(ok, (r.mode === "mock" ? 1 : settings.pollSeconds) * 1000));
    }
  };
  try {
    if (values.resume) {
      const id = Number(values.resume);
      const budgetUsd = values.budget ? Number(values.budget) : undefined;
      console.log(`resume: ${await resumeCaseRun(db, id, { budgetUsd, retryUncertain: values["retry-uncertain"] === true })}`);
      if (!values.execute) return console.log("Queued only; add --execute to run it here.");
      console.log(`run ${id}: ${await runUntilStopped(id)}`);
      return console.log(JSON.stringify(await caseRunReport(db, id), null, 2));
    }
    const caseId = Number(values.case);
    if (!Number.isInteger(caseId) || caseId <= 0) throw new Error("Give the case with --case <id>.");
    if (values.plan) {
      const built = await buildCasePool(db, pool, caseId, { minilm });
      const split = splitPacketSet(built.packets, built.items);
      const packets = split.packets.map((p) => ({ passageTokens: p.inputTokens - INSTRUCTION_TOKENS, pairs: p.pairs.length }));
      const cost = projectCost(packets);
      return console.log(JSON.stringify({
        documents: built.documents.map((d) => ({ id: d.depositionId, witness: d.witnessId, included: d.included, reason: d.reason })), items: built.items.length, ineligibleGroups: built.excluded.length,
        paths: built.paths, poolPairs: built.pool.candidates.length, triageDeferred: built.triage.deferred.length, packets: packets.length, listedPairs: packets.reduce((n, p) => n + p.pairs, 0),
        splitPackets: split.packets.filter((p) => p.splitFrom).length, oversizePackets: split.packets.filter((p) => p.oversize).length,
        uncovered: built.packets.uncovered.length, maxPairsInAPacket: Math.max(0, ...packets.map((p) => p.pairs)), projectedUsd: cost, assumptions: COST_ASSUMPTIONS,
      }, null, 2));
    }
    if (values.mock === values.live) throw new Error("Choose one of --plan, --mock or --live.");
    if (values.live && (!values.execute || !values.budget)) throw new Error("A live run needs --budget <usd> and --execute.");
    if (values.live && !paidCallsAllowed(process.env)) throw new Error("Paid calls are off (ANTHROPIC_API_KEY and ALLOW_PAID_CALLS=true are both required).");
    if (values.live && values.economy && !values["acknowledge-retention"]) throw new Error("A live economy run needs --acknowledge-retention: the provider stores batch inputs and results for 29 days.");
    const run = await createCaseRun(db, caseId, { mode: values.live ? "live" : "mock", budgetUsd: Number(values.budget ?? 0), confirmed: values.live === true, execution: values.economy ? "batch" : "standard" });
    console.log(`case run ${run.id}: ${await runUntilStopped(run.id)}`);
    console.log(JSON.stringify(await caseRunReport(db, run.id), null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
