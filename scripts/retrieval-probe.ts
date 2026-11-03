// The retrieval feasibility probe (server/src/eval/retrievalProbe.ts) from the command line.
//
//   npx tsx scripts/retrieval-probe.ts [--facts] [--json]
//     Loads every real fixture document into TEST_DATABASE_URL (which it wipes), runs the independent
//     retrieval paths (full text, LSA, question-centered, anchors) without any Stage 2 facts, and ranks
//     the known pairs. With --facts it runs again with the pilots' indexed facts from DATABASE_URL added
//     as a fifth signal. No model or API call. The report quotes nothing but positions; it is written
//     under the git-ignored data/raw/retrieval/.

import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { connect } from "../server/src/db/client";
import { loadEvidenceFixtures, missingFixtureFiles, openEvaluationDatabase, readEvidenceFixture } from "../server/src/eval/evidenceFixtures";
import { pilotFacts, runRetrievalProbe } from "../server/src/eval/retrievalProbe";

const { values } = parseArgs({ options: { facts: { type: "boolean" }, json: { type: "boolean" } } });
const PILOT_VERSIONS = ["facts-v2+fact-schema-v1+claude-haiku-5-5", "facts-v3+fact-schema-v2+claude-haiku-5-5"];

async function main() {
  const fixture = readEvidenceFixture();
  const missing = missingFixtureFiles(fixture);
  if (missing.length) throw new Error(`The probe needs every fixture file; missing:\n  ${missing.join("\n  ")}`);
  const facts = values.facts ? await (async () => { const { db, pool } = connect(); try { return await pilotFacts(db, PILOT_VERSIONS); } finally { await pool.end(); } })() : [];
  const { db, pool } = await openEvaluationDatabase(process.env.TEST_DATABASE_URL);
  try {
    const l = await loadEvidenceFixtures(db, fixture);
    const without = await runRetrievalProbe(db, pool, l, fixture);
    const withFacts = values.facts ? await runRetrievalProbe(db, pool, l, fixture, facts) : null;
    mkdirSync("data/raw/retrieval", { recursive: true });
    const file = `data/raw/retrieval/probe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(file, JSON.stringify({ without, withFacts, factRows: facts.length }, null, 2));
    if (values.json) return console.log(JSON.stringify({ without, withFacts }, null, 2));
    for (const [label, r] of [["WITHOUT Stage 2 facts", without], ["WITH pilot facts", withFacts]] as const) {
      if (!r) continue;
      console.log(`\n${label}: ${r.corpus.items} answer groups in ${r.corpus.documents} documents, ${r.corpus.sessions} sessions; items with facts ${r.corpus.itemsWithFacts}; timings ${JSON.stringify(r.timingsMs)}`);
      const pairsOrder = r.paths[0].pairs.map((p) => p.pair);
      console.log(`${"path".padEnd(32)} ${"candidates".padStart(10)}  ${["@20", "@50", "@100", "@250", "@1000"].map((k) => k.padStart(6)).join(" ")}  | global rank (query rank) per pair: ${pairsOrder.join(", ")}`);
      for (const p of r.paths) {
        const rec = ["@20", "@50", "@100", "@250", "@1000"].map((k) => (p.recall as Record<string, { reviewWorthy: string }>)[k].reviewWorthy.padStart(6)).join(" ");
        console.log(`${p.path.padEnd(32)} ${String(p.candidates).padStart(10)}  ${rec}  | ${p.pairs.map((x) => `${x.globalRank ?? "-"}${x.queryRank !== null ? ` (${x.queryRank})` : ""}`).join(", ")}`);
      }
    }
    console.log("\nPer-item budgets (no Stage 2 facts): each answer group keeps its k best neighbours per path.");
    for (const b of without.perItemBudgets) console.log(`  k=${String(b.k).padEnd(3)} union of A-D: ${b.unionOfPaths.recovered.length}/3 review-worthy [${b.unionOfPaths.recovered.join(", ")}], ${b.unionOfPaths.candidatePairs} candidate pairs; fused per query: ${b.fusedPerQuery.recovered.length}/3; by path ${Object.entries(b.byPath).map(([n, x]) => `${n.split("_")[0]} ${x.recovered.length} (${x.candidatePairs})`).join(", ")}; controls ${b.controlsRecoveredByUnion.length}/3`);
    for (const b of without.fusedBudgets) console.log(`  fused top k=${String(b.k).padEnd(3)} for every item: ${b.recovered.length}/3 review-worthy [${b.recovered.join(", ")}], controls ${b.controls.length}/3, ${b.candidatePairs} candidate pairs`);
    console.log(`  fused query ranks: ${without.fusedQueryRanks.map((x) => `${x.pair} ${x.fusedQueryRank ?? "-"}`).join(", ")}`);
    console.log(`\nRecall columns count the review-worthy pairs only. Report: ${file}`);
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
