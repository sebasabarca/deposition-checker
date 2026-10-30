// Adjudication from the CLI, one stored candidate at a time (development only).
//
//   npx tsx scripts/adjudicate.ts persist --set <name> (--case-id <id> | --case <name>) --witness <name> [--deposition <id>]
//     Runs Path A and Path B as they are (read-only), merges and selects (budget 300, cap 3), and
//     stores every candidate, selected and deferred, in a new named set. No API call.
//   npx tsx scripts/adjudicate.ts fixtures
//     Stores the synthetic evaluation suites (eval/synthetic.ts: webb-synthetic-v1, development, and
//     whitfield-synthetic-v1, held out) as fixture cases with one candidate per case, and lists them
//     with their labels. No API call.
//   npx tsx scripts/adjudicate.ts list --set <name> [--status selected] [--limit 20]
//     Candidates with their page:line references and status. No API call.
//   npx tsx scripts/adjudicate.ts show --candidate <id>
//     The packet exactly as the model would see it, and any stored verdicts and findings. No API call.
//   npx tsx scripts/adjudicate.ts estimate --candidate <ids>
//     Each packet's size, its worst-case cost (what the budget reserves) and, once enough calls are
//     recorded, its expected cost from measured usage. No API call.
//   npx tsx scripts/adjudicate.ts run --candidate <id> --budget-name <name> --budget-limit <usd> [--effort medium] [--prompt adjudicate-v1|adjudicate-v2] [--allow-repeat]
//     PAID: one Sonnet call. Reserves the worst case from the stored budget first, then stores the
//     call, the verdict as received, and the finding with code's checks and score.

import "dotenv/config";
import { parseArgs } from "node:util";
import { eq, and, asc, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  ADJUDICATION_MODEL,
  adjudicateCandidate,
  anthropicAdjudicator,
  DEFAULT_EFFORT,
  EFFORTS,
  formatPacket,
  loadPacket,
  maxPacketCost,
  persistCandidates,
  DEFAULT_PROMPT_VERSION,
  MAX_OUTPUT_TOKENS,
  PROMPT_VERSIONS,
} from "../server/src/adjudicate";
import { coldCacheCost, expectedPacketCost, measure, measuredSamples, MIN_MEASURED_CALLS } from "../server/src/adjudicate/estimate";
import { EXTRACTOR_VERSION } from "../server/src/claims";
import { BudgetExceeded, budgetStatus, ensureBudget, reconcileStale } from "../server/src/costs";
import { connect, type Database } from "../server/src/db/client";
import { candidates, findings, lines, verdicts, exchanges } from "../server/src/db/schema";
import { SYNTHETIC_SUITES } from "../server/src/eval/synthetic";
import { storeSynthetic } from "../server/src/eval/syntheticStore";
import { findPathA, findPathB, mergeCandidates, selectCandidates } from "../server/src/retrieve";
import { resolveDeposition, resolveWitness } from "./cases";

const PATH_B_MODE = "rare_terms" as const;
const STALE_RESERVATION_MS = 15 * 60 * 1000;

const Args = z.object({
  command: z.enum(["persist", "fixtures", "list", "show", "estimate", "run"]),
  set: z.string().min(1).optional(),
  caseId: z.coerce.number().int().positive().optional(),
  case: z.string().optional(),
  witness: z.string().optional(),
  deposition: z.coerce.number().int().positive().optional(),
  status: z.enum(["selected", "deferred", "audit", "adjudicated"]).optional(),
  limit: z.coerce.number().int().positive().default(20),
  candidate: z.string().optional(),
  budgetName: z.string().min(1).optional(),
  budgetLimit: z.coerce.number().positive().optional(),
  effort: z.enum(EFFORTS).default(DEFAULT_EFFORT),
  prompt: z.enum(PROMPT_VERSIONS).default(DEFAULT_PROMPT_VERSION),
  allowRepeat: z.boolean().default(false),
});
type Args = z.infer<typeof Args>;

const usd = (n: number | null) => (n === null ? "unpriced" : `$${n.toFixed(4)}`);
const ids = (s: string | undefined) => (s ?? "").split(",").filter(Boolean).map((x) => z.coerce.number().int().positive().parse(x));

async function refs(db: Database, partIds: number[]) {
  const rows = partIds.length
    ? await db
        .select({ id: exchanges.id, page: lines.printedPage, line: lines.lineNo })
        .from(exchanges)
        .innerJoin(lines, eq(lines.id, exchanges.firstLineId))
        .where(inArray(exchanges.id, partIds))
    : [];
  return new Map(rows.map((r) => [r.id, `${r.page}:${r.line}`]));
}

async function persist(db: Database, args: Args) {
  if (!args.set) throw new Error("persist needs --set <name>.");
  const target = await resolveWitness(db, { caseId: args.caseId, caseName: args.case, witnessName: args.witness ?? "" });
  const depositionId = await resolveDeposition(db, target, args.deposition);
  const pathA = await findPathA(db, { witnessId: target.witnessId, depositionId, extractorVersion: EXTRACTOR_VERSION });
  const pathB = await findPathB(db, { witnessId: target.witnessId, depositionId, mode: PATH_B_MODE });
  const { selected, deferred } = selectCandidates(mergeCandidates({ claims: pathA, fulltext: pathB.pairs }));
  const saved = await persistCandidates(db, { set: args.set, witnessId: target.witnessId, selected, deferred });
  console.log(`Set "${args.set}": ${saved.selected} selected, ${saved.deferred} deferred (Path A ${pathA.length} pairs, Path B ${PATH_B_MODE} ${pathB.pairs.length}).`);
}

async function fixtures(db: Database) {
  for (const suite of SYNTHETIC_SUITES) {
    const ids = await storeSynthetic(db, suite);
    console.log(`Set ${suite.set} (${suite.split}):`);
    for (const c of suite.cases) console.log(`  #${ids.get(c.id)}  ${c.id}  ${c.kind}  label ${c.label} (also defensible: ${c.acceptable.join(", ")})  ${c.why}`);
  }
}

async function list(db: Database, args: Args) {
  if (!args.set) throw new Error("list needs --set <name>.");
  const rows = await db
    .select()
    .from(candidates)
    .where(args.status ? and(eq(candidates.candidateSet, args.set), eq(candidates.status, args.status)) : eq(candidates.candidateSet, args.set))
    .orderBy(asc(candidates.mergedRank))
    .limit(args.limit);
  const at = await refs(db, rows.flatMap((r) => [r.exchangeA, r.exchangeB]));
  for (const r of rows) {
    console.log(`#${r.id}  rank ${r.mergedRank}  ${r.status}${r.deferredReason ? ` (${r.deferredReason})` : ""}  [${r.sources.join("+")}]  D${r.depositionA} ${at.get(r.exchangeA)}  <->  D${r.depositionB} ${at.get(r.exchangeB)}`);
  }
}

async function show(db: Database, args: Args) {
  for (const id of ids(args.candidate)) {
    const packet = await loadPacket(db, id);
    console.log(`=== Candidate ${id} ===\n${formatPacket(packet)}\n`);
    const vs = await db.select().from(verdicts).where(eq(verdicts.candidateId, id)).orderBy(asc(verdicts.id));
    for (const v of vs) {
      console.log(`Verdict ${v.id}: ${v.status} (${v.model}, ${v.promptVersion}, effort ${v.effort})${v.error ? `: ${v.error}` : ""}${v.consistencyIssues.length ? ` inconsistent: ${v.consistencyIssues.join(", ")}` : ""}`);
      if (v.parsed) console.log(JSON.stringify(v.parsed, null, 2));
      const [f] = await db.select().from(findings).where(eq(findings.verdictId, v.id));
      if (f) {
        console.log(`Finding ${f.id}: ${f.type}, evidence ${f.evidenceStatus}, attribution ${f.attributionA}/${f.attributionB}, ` + (f.score === null ? `unscored (${f.unscoredReason})` : `score ${f.score} ${f.band}`) + `, priority ${f.priority}`);
        for (const x of f.factors as { component: string; label: string; points: number; max: number; origin: string }[]) console.log(`  ${x.component} ${String(x.points).padStart(3)}/${x.max}  ${x.label}  [${x.origin}]`);
        for (const c of f.caps as { rule: string; limit: number; binding: boolean }[]) console.log(`  cap ${c.limit} ${c.rule}${c.binding ? " (binding)" : ""}`);
      }
    }
  }
}

async function estimate(db: Database, args: Args) {
  // Worst case: what the budget reserves, output at max_tokens (thinking included). Expected: from
  // measured calls of this prompt version only; none is shown until enough exist.
  const m = measure(await measuredSamples(db, ADJUDICATION_MODEL, args.prompt));
  let worst = 0;
  let median = 0;
  let high = 0;
  for (const id of ids(args.candidate)) {
    const text = formatPacket(await loadPacket(db, id));
    const max = maxPacketCost(ADJUDICATION_MODEL, text, args.prompt);
    const expected = m ? expectedPacketCost(ADJUDICATION_MODEL, text.length, m) : null;
    worst += max;
    median += expected?.median ?? 0;
    high += expected?.high ?? 0;
    console.log(`#${id}: packet ${text.length} chars; worst case ${usd(max)}` + (expected ? `, expected ${usd(expected.median)} (up to ${usd(expected.high)})` : ""));
  }
  console.log(`Total worst case ${usd(worst)}, if every call used its whole allowance (output at ${MAX_OUTPUT_TOKENS} max_tokens, thinking included). Run one at a time, a budget needs headroom for one call's worst case beyond what is spent.`);
  if (!m) return console.log(`No expected cost: fewer than ${MIN_MEASURED_CALLS} measured ${args.prompt} calls.`);
  console.log(
    `Expected ${usd(median)} (up to ${usd(high)}) with a warm cache, plus ${usd(coldCacheCost(ADJUDICATION_MODEL, m))} once for a cold cache. ` +
      `Measured from ${m.calls} calls: ${m.inputTokensPerChar.toFixed(3)} input tokens per packet character, ${m.promptTokens} cached prompt tokens, output median ${m.outputTokens.median}, max ${m.outputTokens.max}.`,
  );
}

async function run(db: Database, args: Args) {
  const [id] = ids(args.candidate);
  if (!id || ids(args.candidate).length !== 1) throw new Error("run takes exactly one --candidate <id>.");
  if (!args.budgetName || args.budgetLimit === undefined) throw new Error("run needs --budget-name <name> --budget-limit <usd>: a stored budget the runs spend from.");
  const budgetId = await ensureBudget(db, args.budgetName, args.budgetLimit);
  await reconcileStale(db, budgetId, STALE_RESERVATION_MS);
  try {
    const result = await adjudicateCandidate(db, id, anthropicAdjudicator(args.effort, args.prompt), { budgetId, allowRepeat: args.allowRepeat });
    console.log(`Candidate ${id}: ${args.prompt} verdict ${result.verdictId} ${result.status}${result.error ? ` (${result.error})` : ""}, call ${result.llmCallId} ${usd(result.costUsd)}`);
    if (result.assessed?.consistencyIssues.length) console.log(`  semantically inconsistent: ${result.assessed.consistencyIssues.join(", ")}`);
    if (result.assessed) {
      const { assessment: a, priority, checks } = result.assessed;
      console.log(`  evidence ${checks.source.status}; attribution ${checks.attribution.a.level}/${checks.attribution.b.level}; ` + (a.score === null ? `unscored (${a.unscoredReason})` : `score ${a.score} ${a.band}`) + `; priority ${priority}`);
    }
  } catch (error) {
    if (!(error instanceof BudgetExceeded)) throw error;
    console.log(`Not sent: ${error.message}`);
  }
  const b = await budgetStatus(db, budgetId);
  console.log(`Budget "${b.name}": spent ${usd(b.spentUsd)}, reserved ${usd(b.reservedUsd)}, available ${usd(b.availableUsd)} of ${usd(b.limitUsd)}`);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      set: { type: "string" },
      "case-id": { type: "string" },
      case: { type: "string" },
      witness: { type: "string" },
      deposition: { type: "string" },
      status: { type: "string" },
      limit: { type: "string" },
      candidate: { type: "string" },
      "budget-name": { type: "string" },
      "budget-limit": { type: "string" },
      effort: { type: "string" },
      prompt: { type: "string" },
      "allow-repeat": { type: "boolean" },
    },
  });
  const args = Args.parse({
    ...values,
    command: positionals[0],
    caseId: values["case-id"],
    budgetName: values["budget-name"],
    budgetLimit: values["budget-limit"],
    allowRepeat: values["allow-repeat"],
  });
  const { db, pool } = connect();
  try {
    await { persist, fixtures, list, show, estimate, run }[args.command](db, args);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
