// Path A from the command line (development only).
//
//   npx tsx scripts/patha.ts estimate (--case-id <id> | --case <name>) --witness <name>
//     The cost of tagging the witness's ready depositions: a 2-batch pilot and the full run. No API call.
//   npx tsx scripts/patha.ts sample (--case-id …) --witness <name> --deposition <id>
//     Prints the pilot sample (PILOT_BATCHES batches of parts chosen by a fixed rule). No API call.
//   npx tsx scripts/patha.ts tag (--case-id …) --witness <name> --deposition <id> (--pilot | --all)
//     Tags claims with Haiku: PAID API CALLS. --pilot tags only the pilot sample.
//   npx tsx scripts/patha.ts report (--case-id …) --witness <name> [--deposition <id>] [--limit 10]
//     Extraction coverage and quality, the claim fixtures, Path A pairs, and how many of them Path B
//     doesn't find. No API call.
//   npx tsx scripts/patha.ts reverify (--case-id …) --witness <name> [--version <extractor version>]
//     Re-applies code's checks to stored claims. No API call.
//   npx tsx scripts/patha.ts tag … --parts <id,id,…>
//     Tags only the listed parts (PAID): for re-testing known failures.
//   npx tsx scripts/patha.ts tag … --all --budget-name <name> --budget-limit <usd>
//     Tags every remaining part (PAID) one batch at a time, from a stored budget: each batch reserves
//     its worst-case cost first, and the run stops before any call the budget can't cover.

import "dotenv/config";
import { parseArgs } from "node:util";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  anthropicClaimModel,
  BATCH_SIZE,
  batchesOf,
  estimateCost,
  EXTRACTION_JSON_SCHEMA,
  EXTRACTOR_VERSION,
  partsToTag,
  PLANNING_OUTPUT_SHARE,
  readAnswer,
  reverifyClaims,
  tagClaims,
} from "../server/src/claims";
import { BudgetExceeded, budgetStatus, ensureBudget, measuredOutputShare, reconcileStale } from "../server/src/costs";
import { connect, type Database } from "../server/src/db/client";
import { checkClaimFixtures } from "../server/src/eval";
import { claims, claimTagging, depositions, exchanges, lines, llmCalls } from "../server/src/db/schema";
import { findPathA, findPathB } from "../server/src/retrieve";
import { resolveDeposition, resolveWitness } from "./cases";

const PILOT_BATCHES = 2;
const STALE_RESERVATION_MS = 15 * 60 * 1000; // a reservation open this long was left by a crash
const USAGE =
  "Usage: npx tsx scripts/patha.ts estimate|sample|tag|report|reverify (--case-id <id> | --case <name>) --witness <name> [--deposition <id>] [--pilot | --all | --parts <ids>] [--version <v>] [--limit 10]";

const Args = z.object({
  command: z.enum(["estimate", "sample", "tag", "report", "reverify"]),
  parts: z.string().regex(/^\d+(,\d+)*$/).optional(),
  version: z.string().optional(),
  caseId: z.coerce.number().int().positive().optional(),
  case: z.string().trim().min(1).optional(),
  witness: z.string().trim().min(1),
  deposition: z.coerce.number().int().positive().optional(),
  pilot: z.boolean().default(false),
  all: z.boolean().default(false),
  limit: z.coerce.number().int().nonnegative().default(10),
  budgetName: z.string().min(1).optional(),
  budgetLimit: z.coerce.number().positive().optional(),
});

function readArgs() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "case-id": { type: "string" },
      case: { type: "string" },
      witness: { type: "string" },
      deposition: { type: "string" },
      pilot: { type: "boolean" },
      all: { type: "boolean" },
      limit: { type: "string" },
      parts: { type: "string" },
      version: { type: "string" },
      "budget-name": { type: "string" },
      "budget-limit": { type: "string" },
    },
  });
  const parsed = Args.safeParse({ ...values, caseId: values["case-id"], budgetName: values["budget-name"], budgetLimit: values["budget-limit"], command: positionals[0] ?? "estimate" });
  if (!parsed.success) throw new Error(`${z.prettifyError(parsed.error)}\n${USAGE}`);
  return parsed.data;
}

const usd = (n: number) => `$${n.toFixed(4)}`;

// The pilot sample: PILOT_BATCHES batches of substantive testimony, chosen by a fixed rule so the
// same parts are chosen every time. In order, each group skipping parts already chosen:
//   shared topic  8 parts on this side of Path B's top rare-terms pairs (topics both sessions cover)
//   yes_no        4 plain yes-or-no answers (readAnswer), for adopted questions
//   qualified     4 answers with "I think", "I believe", "probably", "I suppose"
//   recollection  4 answers with "don't recall", "don't remember", "don't know", "not sure"
//   direct        the rest: answers of 200+ characters
// Each group is taken in part-ID order; the sample is returned in part-ID order.
const SAMPLE_PLAN = [
  ["shared_topic", 8],
  ["yes_no", 4],
  ["qualified", 4],
  ["recollection", 4],
  ["direct", PILOT_BATCHES * BATCH_SIZE],
] as const;

async function pilotSample(db: Database, witnessId: number, depositionId: number) {
  const pending = (await partsToTag(db, depositionId)).parts;
  const rows = await db
    .select({ id: exchanges.id, depositionId: exchanges.depositionId, question: exchanges.questionText, answer: exchanges.answerText })
    .from(exchanges)
    .where(inArray(exchanges.id, pending.length ? pending.map((p) => p.id) : [-1]))
    .orderBy(asc(exchanges.id));
  const others = (await db.select({ id: depositions.id }).from(depositions).where(and(eq(depositions.witnessId, witnessId), eq(depositions.status, "ready")))).map((d) => d.id).filter((id) => id !== depositionId);
  // Path B's pairs from another ready session's point of view, so this deposition can be either side.
  const pathB = others.length ? (await findPathB(db, { witnessId, depositionId: others[0], mode: "rare_terms" })).pairs : [];
  const sharedTopic = pathB.flatMap((p) => [p.exchangeA, p.exchangeB]);

  const tests: Record<(typeof SAMPLE_PLAN)[number][0], (r: (typeof rows)[number]) => boolean> = {
    shared_topic: (r) => sharedTopic.includes(r.id),
    yes_no: (r) => readAnswer(r.question, r.answer) !== "uncertain",
    qualified: (r) => /\b(i think|i believe|probably|i suppose)\b/i.test(r.answer),
    recollection: (r) => /\b(don't|do not) (recall|remember|know)\b|\bnot sure\b/i.test(r.answer),
    direct: (r) => r.answer.length >= 200,
  };
  const chosen = new Map<number, string>();
  const want = PILOT_BATCHES * BATCH_SIZE;
  for (const [group, count] of SAMPLE_PLAN) {
    let ordered = rows.filter((r) => !chosen.has(r.id) && tests[group](r));
    if (group === "shared_topic") ordered = sharedTopic.map((id) => ordered.find((r) => r.id === id)).filter((r): r is (typeof rows)[number] => !!r);
    for (const r of ordered.slice(0, Math.min(count, want - chosen.size))) chosen.set(r.id, group);
  }
  return rows.filter((r) => chosen.has(r.id)).map((r) => ({ ...r, group: chosen.get(r.id)! }));
}

async function sample(db: Database, witnessId: number, depositionId: number) {
  const parts = await pilotSample(db, witnessId, depositionId);
  const all = await partsToTag(db, depositionId);
  const est = estimateCost(batchesOf(all.parts.filter((p) => parts.some((s) => s.id === p.id))), JSON.stringify(EXTRACTION_JSON_SCHEMA).length);
  console.log(`Pilot sample for deposition ${depositionId}: ${parts.length} parts, ${est.batches} batches, ≈ ${usd(est.costUsd)} (no API call)`);
  for (const p of parts) console.log(`  ${String(p.id).padEnd(5)} ${p.group.padEnd(13)} Q: ${p.question.replace(/\s+/g, " ").slice(0, 55).padEnd(55)} A: ${p.answer.replace(/\s+/g, " ").slice(0, 60)}`);
}

async function readyDepositions(db: Database, target: { caseId: number; witnessId: number }) {
  return db
    .select({ id: depositions.id })
    .from(depositions)
    .where(and(eq(depositions.caseId, target.caseId), eq(depositions.witnessId, target.witnessId), eq(depositions.status, "ready")))
    .orderBy(asc(depositions.id));
}

// The output share to estimate with: measured from recorded claim-tagging calls once there are
// enough, else DESIGN.md's planning allowance.
async function outputShare(db: Database) {
  const measured = await measuredOutputShare(db, "claim_tagging");
  return measured
    ? { share: measured.share, basis: `output measured at ${measured.share.toFixed(2)}x input over ${measured.calls} recorded calls` }
    : { share: PLANNING_OUTPUT_SHARE, basis: `output at the ${PLANNING_OUTPUT_SHARE}x planning allowance (fewer than 4 recorded calls)` };
}

async function estimate(db: Database, target: { caseId: number; witnessId: number }) {
  const schemaChars = JSON.stringify(EXTRACTION_JSON_SCHEMA).length;
  const { share, basis } = await outputShare(db);
  console.log(`Estimate for ${EXTRACTOR_VERSION} (no API call). Input at 1 token per 3 characters, ${basis}; ignores caching.\n`);
  for (const { id } of await readyDepositions(db, target)) {
    const { parts, skipped } = await partsToTag(db, id);
    const batches = batchesOf(parts);
    const pilot = estimateCost(batches.slice(0, PILOT_BATCHES), schemaChars, share);
    const full = estimateCost(batches, schemaChars, share);
    console.log(`Deposition ${id}: ${parts.length} parts to tag (${skipped} already tagged), ${batches.length} batches`);
    console.log(`  pilot (${pilot.batches} batches, ${pilot.parts} parts): ~${pilot.inputTokens} in + ~${pilot.outputTokens} out tokens ≈ ${usd(pilot.costUsd)}`);
    console.log(`  full  (${full.batches} batches, ${full.parts} parts): ~${full.inputTokens} in + ~${full.outputTokens} out tokens ≈ ${usd(full.costUsd)}`);
  }
}

// The listed parts that belong to the deposition and still need tagging, and their estimated cost.
async function listedParts(db: Database, depositionId: number, list: string) {
  const wanted = new Set(list.split(",").map(Number));
  const { parts } = await partsToTag(db, depositionId);
  const chosen = parts.filter((p) => wanted.has(p.id));
  const { share, basis } = await outputShare(db);
  return { ids: chosen.map((p) => p.id), estimate: estimateCost(batchesOf(chosen), JSON.stringify(EXTRACTION_JSON_SCHEMA).length, share), basis };
}

// Parts whose batch failed or was refused during this run: counted, not retried by the same run.
const failedThisRun = new Set<number>();

// The full run under a persistent budget (costs/budget.ts): each batch reserves its worst-case cost
// before it is sent, so the run stops before any call the budget can't cover. The budget is stored,
// so a later run, or a run after a crash, spends from the same remaining amount.
async function tagAll(db: Database, depositionId: number, budgetName: string, budgetLimit: number) {
  const budgetId = await ensureBudget(db, budgetName, budgetLimit);
  await reconcileStale(db, budgetId, STALE_RESERVATION_MS);
  const model = anthropicClaimModel();
  const totals = { attempted: 0, tagged: 0, failed: 0, refused: 0, verified: 0, approximate: 0, rejected: 0, calls: 0 };
  for (;;) {
    const { parts } = await partsToTag(db, depositionId);
    const remaining = parts.filter((p) => !failedThisRun.has(p.id));
    if (remaining.length === 0) break;
    const batch = remaining.slice(0, BATCH_SIZE).map((p) => p.id);
    let result;
    try {
      result = await tagClaims(db, depositionId, model, { only: batch, budgetId });
    } catch (error) {
      if (!(error instanceof BudgetExceeded)) throw error;
      console.log(`Stopped before calling: ${error.message} ${remaining.length} parts left untagged.`);
      break;
    }
    if (result.parts.tagged === 0) for (const id of batch) failedThisRun.add(id);
    totals.calls += result.llmCallIds.length;
    for (const k of ["attempted", "tagged", "failed", "refused"] as const) totals[k] += result.parts[k];
    for (const k of ["verified", "approximate", "rejected"] as const) totals[k] += result.claims[k];
  }
  const b = await budgetStatus(db, budgetId);
  console.log(`Deposition ${depositionId}: ${JSON.stringify(totals)}`);
  console.log(`Budget "${b.name}": spent ${usd(b.spentUsd)} (reconciled), reserved ${usd(b.reservedUsd)}, available ${usd(b.availableUsd)} of ${usd(b.limitUsd)}`);
}

async function tag(db: Database, witnessId: number, depositionId: number, pilot: boolean, list?: string) {
  const only = list ? (await listedParts(db, depositionId, list)).ids : pilot ? (await pilotSample(db, witnessId, depositionId)).map((p) => p.id) : undefined;
  const result = await tagClaims(db, depositionId, anthropicClaimModel(), only ? { only } : {});
  const calls = result.llmCallIds.length
    ? await db.select({ cost: llmCalls.costUsd, input: llmCalls.inputTokens, output: llmCalls.outputTokens, read: llmCalls.cacheReadTokens, write: llmCalls.cacheWrite5mTokens }).from(llmCalls).where(inArray(llmCalls.id, result.llmCallIds))
    : [];
  const sum = (f: (c: (typeof calls)[number]) => number | null) => calls.reduce((n, c) => n + (f(c) ?? 0), 0);
  console.log(`Tagged deposition ${depositionId} with ${EXTRACTOR_VERSION}${only ? ` (${only.length} chosen parts)` : ""}`);
  console.log(`  parts: ${JSON.stringify(result.parts)}`);
  console.log(`  claims: ${JSON.stringify(result.claims)}`);
  console.log(`  ${calls.length} calls: ${sum((c) => c.input)} in, ${sum((c) => c.write)} cache-write, ${sum((c) => c.read)} cache-read, ${sum((c) => c.output)} out tokens; actual cost ${usd(sum((c) => c.cost))}`);
}

async function report(db: Database, target: { caseId: number; witnessId: number }, depositionId: number, limit: number, version: string) {
  const deps = (await readyDepositions(db, target)).map((d) => d.id);
  console.log(`Path A report, ${version}. Signals are reasons to adjudicate, not contradictions.\n`);
  for (const id of deps) {
    const tagging = await db.select({ status: claimTagging.status, n: sql<number>`count(*)::int` }).from(claimTagging).where(and(eq(claimTagging.depositionId, id), eq(claimTagging.extractorVersion, version))).groupBy(claimTagging.status);
    const statuses = await db.select({ status: claims.status, reason: claims.rejectionReason, n: sql<number>`count(*)::int` }).from(claims).where(and(eq(claims.depositionId, id), eq(claims.extractorVersion, version))).groupBy(claims.status, claims.rejectionReason);
    const { parts: untagged } = await partsToTag(db, id);
    console.log(`Deposition ${id}: parts ${JSON.stringify(Object.fromEntries(tagging.map((t) => [t.status, t.n])))}, not yet tagged ${untagged.length}`);
    console.log(`  claims ${JSON.stringify(Object.fromEntries(statuses.map((s) => [s.reason ? `rejected: ${s.reason}` : s.status, s.n])))}`);
  }
  const [cost] = await db.select({ calls: sql<number>`count(*)::int`, priced: sql<string>`coalesce(sum(${llmCalls.costUsd}), 0)`, unpriced: sql<number>`(count(*) filter (where ${llmCalls.costUsd} is null))::int` }).from(llmCalls).where(eq(llmCalls.stage, "claim_tagging"));
  console.log(`Claim-tagging calls recorded: ${cost.calls}, actual cost ${usd(Number(cost.priced))}${cost.unpriced ? `, ${cost.unpriced} unpriced` : ""}\n`);

  const fixtures = await checkClaimFixtures(db, "data/eval/claim-fixtures.json", version);
  const tally = Object.fromEntries(["pass", "fail", "not_tagged", "anchor_not_found"].map((o) => [o, fixtures.filter((f) => f.outcome === o).length]));
  console.log(`Claim fixtures ${JSON.stringify(tally)}`);
  for (const f of fixtures) console.log(`  ${f.outcome.padEnd(10)} ${f.name}\n             ${f.detail}`);
  console.log();

  const pathA = await findPathA(db, { witnessId: target.witnessId, depositionId, extractorVersion: version });
  const pathB = await findPathB(db, { witnessId: target.witnessId, depositionId, mode: "rare_terms" });
  const key = (p: { a: { depositionId: number; groupId: number }; b: { depositionId: number; groupId: number } }) => `${p.a.depositionId}:${p.a.groupId}|${p.b.depositionId}:${p.b.groupId}`;
  const inB = new Set(pathB.pairs.map(key));
  const onlyA = pathA.filter((p) => !inB.has(key(p)));
  const bySignal = Object.fromEntries(["opposite_polarity", "different_value", "recollection_change"].map((s) => [s, pathA.filter((p) => p.signal === s).length]));
  console.log(`Path A: ${pathA.length} pairs ${JSON.stringify(bySignal)}; ${onlyA.length} not in Path B's ${pathB.pairs.length} (rare_terms)`);
  console.log("No recall claim: that needs independently reviewed labels.\n");

  const shown = onlyA.slice(0, limit);
  const ids = shown.flatMap((p) => [p.claimA, p.claimB]);
  const claimRows = ids.length ? await db.select().from(claims).where(inArray(claims.id, ids)) : [];
  const byId = new Map(claimRows.map((c) => [c.id, c]));
  const lineIds = claimRows.flatMap((c) => c.evidenceLineIds);
  const lineRows = lineIds.length ? await db.select({ id: lines.id, page: lines.printedPage, line: lines.lineNo }).from(lines).where(inArray(lines.id, lineIds)) : [];
  const at = new Map(lineRows.map((l) => [l.id, `${l.page}:${l.line}`]));
  console.log(`Path A-only pairs, top ${shown.length}:`);
  for (const p of shown) {
    console.log(`#${p.rank} ${p.signal}  ${p.predicate}  shared: ${p.sharedEntities.join(", ") || "(object)"}`);
    for (const id of [p.claimA, p.claimB]) {
      const c = byId.get(id)!;
      const where = c.evidenceLineIds.map((l) => at.get(l)).filter(Boolean);
      console.log(`   deposition ${c.depositionId} ${where[0] ?? ""}${where.length > 1 ? `–${where[where.length - 1]}` : ""} [${c.status}, ${c.epistemic}, ${c.polarity}] "${c.keyPhrase}"${c.answerPhrase ? ` → "${c.answerPhrase}"` : ""}`);
    }
  }
}

async function main() {
  const args = readArgs();
  const { db, pool } = connect();
  try {
    const target = await resolveWitness(db, { caseId: args.caseId, caseName: args.case, witnessName: args.witness });
    if (args.command === "estimate") return await estimate(db, target);
    const version = args.version ?? EXTRACTOR_VERSION;
    if (args.command === "reverify") {
      for (const { id } of await readyDepositions(db, target)) console.log(`Deposition ${id}:`, JSON.stringify(await reverifyClaims(db, id, version)));
      return;
    }
    const depositionId = await resolveDeposition(db, target, args.deposition);
    if (args.command === "report") return await report(db, target, depositionId, args.limit, version);
    if (args.command === "sample") {
      if (!args.parts) return await sample(db, target.witnessId, depositionId);
      const { ids, estimate: est, basis } = await listedParts(db, depositionId, args.parts);
      console.log(`Listed parts for deposition ${depositionId} under ${EXTRACTOR_VERSION}: ${ids.join(", ") || "none to tag"}`);
      console.log(`  ${est.batches} batches, ~${est.inputTokens} in + ~${est.outputTokens} out tokens ≈ ${usd(est.costUsd)} (${basis}; no API call)`);
      return;
    }
    if ([args.pilot, args.all, !!args.parts].filter(Boolean).length !== 1) throw new Error(`tag makes paid API calls: choose one of --pilot, --all or --parts.\n${USAGE}`);
    if (args.deposition === undefined) throw new Error(`tag needs --deposition <id>.\n${USAGE}`);
    if (args.all) {
      if (!args.budgetName || args.budgetLimit === undefined) throw new Error("tag --all needs --budget-name <name> --budget-limit <usd>: a stored budget the runs spend from.");
      await tagAll(db, depositionId, args.budgetName, args.budgetLimit);
      return;
    }
    await tag(db, target.witnessId, depositionId, args.pilot, args.parts);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
