// Same-witness direct discovery with a chosen model, on the sessions of an existing analysis, for
// comparing models (server/src/adjudicate/compareModels.ts). Writes reports only: the analysis is untouched.
//
//   npx tsx scripts/direct-model.ts run --analysis <id> --model opus|fable --approved-usd <n> --execute [--labels <file>]
//     PAID: one batch request. Needs ANTHROPIC_API_KEY and ALLOW_PAID_CALLS=true on that command. Reserves
//     the worst case before sending, no retry, and records the call with recordCall().
//   npx tsx scripts/direct-model.ts stored --analysis <id> [--labels <file>]
//     No API call: re-checks the analysis's own stored answer the same way, for a side-by-side.
//   npx tsx scripts/direct-model.ts score --report <file> --labels <file>
//     No API call: discovery and classification of labelled discrepancies (data/eval/*-discrepancies-*.json).
//
// Reports go to data/eval/review/direct-model/ (git-ignored), because they quote testimony.

import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { anthropicDiscovery } from "../server/src/adjudicate";
import { paidRunCap, reportProposals, runComparison, storedComparison, type ComparisonModel, type ComparisonReport } from "../server/src/adjudicate/compareModels";
import { connect } from "../server/src/db/client";
import { readDiscrepancyFile, scoreDiscrepancies } from "../server/src/eval";

const REPORTS = "data/eval/review/direct-model";
const { values, positionals } = parseArgs({ allowPositionals: true, options: { analysis: { type: "string" }, model: { type: "string" }, "approved-usd": { type: "string" }, execute: { type: "boolean" }, labels: { type: "string" }, report: { type: "string" } } });

async function score(report: ComparisonReport) {
  if (!values.labels) return;
  const labels = await readDiscrepancyFile(values.labels);
  const s = scoreDiscrepancies(labels, reportProposals(report, labels.documents));
  console.log(JSON.stringify({ labels: labels.set, discovery: s.discovery, classification: s.classification, results: s.results }, null, 2));
}

function save(name: string, report: ComparisonReport) {
  mkdirSync(REPORTS, { recursive: true });
  const file = path.join(REPORTS, `analysis-${report.analysis}-${name}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  const lanes = (report.findings ?? []).reduce<Record<string, number>>((n, f) => ({ ...n, [f.lane]: (n[f.lane] ?? 0) + 1 }), {});
  console.log(JSON.stringify({ model: report.model, source: report.source, status: report.status, completion: report.completion ?? null, costUsd: report.costUsd ?? null, error: report.error ?? null, lanes, report: file }, null, 2));
}

async function main() {
  if (positionals[0] === "score") {
    if (!values.report || !values.labels) throw new Error("score needs --report and --labels");
    return score(JSON.parse(readFileSync(values.report, "utf8")) as ComparisonReport);
  }
  const { db, pool } = connect();
  try {
    const analysisId = Number(values.analysis);
    if (positionals[0] === "run") {
      const capUsd = paidRunCap(process.env, values.execute, values["approved-usd"]);
      const report = await runComparison(db, { analysisId, model: values.model as ComparisonModel, capUsd, provider: anthropicDiscovery(new Anthropic({ maxRetries: 0 })) });
      save(values.model!, report);
      await score(report);
    } else if (positionals[0] === "stored") {
      const report = await storedComparison(db, analysisId);
      save(`stored-${report.model}`, report);
      await score(report);
    } else throw new Error("Usage: run --analysis <id> --model opus|fable --approved-usd <n> --execute | stored --analysis <id> | score --report <file> --labels <file>");
  } finally {
    await pool.end();
  }
}
void main();
