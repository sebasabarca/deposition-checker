// Stage 2 fact extraction from the command line (server/src/claims/facts).
//
//   npx tsx scripts/facts.ts plan --case-id <id> [--json]
//     For every active, ready document of the case: its answer-group units, those still due, and the
//     planned requests, tokens and cost (expected and worst case). No model call and no writes.
//   npx tsx scripts/facts.ts coverage --case-id <id> [--json]
//     Units by status, facts indexed, rejected and stale, uncertain attribution, and measured tokens and cost.
//   npx tsx scripts/facts.ts run --document-id <id> --approved-usd <n> --execute
//     PAID: extracts one document's due units with Haiku, under a budget of <n> USD reserved per request.
//     Needs ALLOW_PAID_CALLS=true and ANTHROPIC_API_KEY. Run it only with approval.
//   npx tsx scripts/facts.ts eval-real [--json]
//     The real-data evaluation (data/eval/facts-expected-v1.json) in TEST_DATABASE_URL, which it wipes:
//     hand-authored records through the real pipeline. Fails if a fixture file is missing or a check
//     fails. Measures no model.
//
// Excluded document copies (legacy parses, duplicates) are never planned or extracted.

import "dotenv/config";
import { parseArgs } from "node:util";
import { and, eq, isNull } from "drizzle-orm";
import { anthropicFactModel } from "../server/src/claims";
import { extractFacts, factCoverage, planFacts } from "../server/src/claims/facts";
import { ensureBudget } from "../server/src/costs";
import { connect } from "../server/src/db/client";
import { depositions } from "../server/src/db/schema";
import { loadEvidenceFixtures, missingFixtureFiles, openEvaluationDatabase, readEvidenceFixture } from "../server/src/eval/evidenceFixtures";
import { readFactExpectations, runFactChecks } from "../server/src/eval/factFixtures";
import { paidCallsAllowed } from "../server/src/jobs";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { "case-id": { type: "string" }, "document-id": { type: "string" }, "approved-usd": { type: "string" }, execute: { type: "boolean" }, json: { type: "boolean" } } });
const [command] = positionals;
const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));

async function evalReal() {
  const fixture = readEvidenceFixture();
  const missing = missingFixtureFiles(fixture);
  if (missing.length) throw new Error(`The evaluation needs every fixture file; missing:\n  ${missing.join("\n  ")}`);
  const { db, pool } = await openEvaluationDatabase(process.env.TEST_DATABASE_URL);
  try {
    const l = await loadEvidenceFixtures(db, fixture);
    const r = await runFactChecks(db, l, readFactExpectations());
    if (values.json) console.log(JSON.stringify(r, null, 2));
    else {
      console.log("Hand-authored records through the real pipeline: schema expressiveness and verification only, no model and no recall.");
      for (const c of r.checks) console.log(`  ${c.ok ? "pass" : "FAIL"}  ${c.name}  (${c.detail})`);
      console.log(`${r.indexed} facts in the verified index.`);
    }
    if (r.checks.some((c) => !c.ok)) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

async function main() {
  if (command === "eval-real") return evalReal();
  const { db, pool } = connect();
  try {
    if (command === "plan") {
      const caseId = num(values["case-id"]);
      if (!caseId) throw new Error("plan needs --case-id");
      const docs = await db.select({ id: depositions.id }).from(depositions).where(and(eq(depositions.caseId, caseId), eq(depositions.status, "ready"), isNull(depositions.excludedReason))).orderBy(depositions.id);
      const plans = [];
      for (const d of docs) plans.push({ documentId: d.id, ...(await planFacts(db, d.id)) });
      const total = plans.reduce((t, p) => ({ units: t.units + p.units, due: t.due + p.due, requests: t.requests + p.estimate.batches, inputTokens: t.inputTokens + p.estimate.inputTokens, expectedUsd: t.expectedUsd + p.estimate.expectedUsd, worstCaseUsd: t.worstCaseUsd + p.estimate.worstCaseUsd }), { units: 0, due: 0, requests: 0, inputTokens: 0, expectedUsd: 0, worstCaseUsd: 0 });
      if (values.json) return console.log(JSON.stringify({ plans, total }, null, 2));
      for (const p of plans) console.log(`document ${p.documentId}: ${p.units} units, ${p.due} due${p.staleUnits ? `, ${p.staleUnits} stale` : ""}; ${p.estimate.batches} requests, ~${p.estimate.inputTokens} input tokens, expected $${p.estimate.expectedUsd}, worst case $${p.estimate.worstCaseUsd} (${p.estimate.model})`);
      console.log(`total: ${total.due} of ${total.units} units due, ${total.requests} requests, ~${total.inputTokens} input tokens, expected $${total.expectedUsd.toFixed(4)}, worst case $${total.worstCaseUsd.toFixed(4)}. Planning figures, not measurements.`);
    } else if (command === "coverage") {
      const caseId = num(values["case-id"]);
      if (!caseId) throw new Error("coverage needs --case-id");
      const c = await factCoverage(db, caseId);
      if (values.json) return console.log(JSON.stringify(c, null, 2));
      for (const d of c.documents) console.log(`document ${d.documentId} (${d.witness}): ${d.answerGroups} answer groups, units ${JSON.stringify(d.units)}; facts ${JSON.stringify(d.facts)}; ${d.usage.calls} calls, ${d.usage.inputTokens} in / ${d.usage.outputTokens} out tokens, $${d.usage.costUsd}${d.notes.length ? `; ${d.notes.join("; ")}` : ""}`);
      for (const x of c.excluded) console.log(`document ${x.documentId}: excluded (${x.reason}${x.duplicateOf ? ` of ${x.duplicateOf}` : ""}), never extracted`);
    } else if (command === "run") {
      const id = num(values["document-id"]);
      const usd = num(values["approved-usd"]);
      if (!id || !usd || !values.execute) throw new Error("run makes paid calls: it needs --document-id, --approved-usd and --execute");
      if (!paidCallsAllowed(process.env)) throw new Error("Paid calls are off: set ALLOW_PAID_CALLS=true (and ANTHROPIC_API_KEY) for this command only, with approval.");
      const budgetId = await ensureBudget(db, `facts-document-${id}`, usd);
      console.log(JSON.stringify(await extractFacts(db, id, anthropicFactModel(), { budgetId }), null, 2));
    } else {
      throw new Error("Usage: plan | coverage | run | eval-real (see the comment at the top of scripts/facts.ts)");
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
