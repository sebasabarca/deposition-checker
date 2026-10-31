// Hybrid retrieval from the command line (development only).
//
//   npx tsx scripts/hybrid.ts estimate (--case-id <id> | --case <name>) --witness <name> [--deposition <id>]
//     What a card run would send, and its expected and worst-case cost. No API call.
//   npx tsx scripts/hybrid.ts report (--case-id …) --witness <name>
//     Stored card coverage, rejection reasons and topic map report. No API call.
//   npx tsx scripts/hybrid.ts pool (--case-id …) --witness <name> --a <id> --b <id> [--capacity 300] [--mode rare_terms|all_terms]
//     Both paths and the union for two sessions: counts only, nothing saved. No API call.
//   npx tsx scripts/hybrid.ts discovery [--distractors 60] [--capacity 30] [--mode rare_terms|all_terms]
//     The synthetic discovery evaluation with the mock models, in TEST_DATABASE_URL, which it WIPES.
//     Measures the pipeline, not Haiku. No API call.
//   npx tsx scripts/hybrid.ts cards … --deposition <id> --budget-name <n> --budget-limit <usd> [--max-chunks 2]
//     Extracts statement cards with Haiku: PAID API CALLS, under a stored budget.
//   npx tsx scripts/hybrid.ts screen (--case-id …) --witness <name>
//     Screens stored noAssertion results and lists the parts now suspected. No API call.
//   npx tsx scripts/hybrid.ts cards … --deposition <id> --targeted [--parts <ids>] --budget-name <n> --budget-limit <usd>
//     Re-extracts suspected parts with context: PAID API CALLS, under a stored budget.
//   npx tsx scripts/hybrid.ts topics … --budget-name <n> --budget-limit <usd>
//     Builds the witness's topic map with Haiku: A PAID API CALL, under a stored budget.

//   ALLOW_PAID_CALLS=true npx tsx scripts/hybrid.ts analysis (--case-id …) --witness <name> --a <id> --b <id> --budget-limit <usd> [--capacity 300]
//     A live hybrid analysis on the stored cards and map, run here through the job code: PAID SONNET
//     CALLS, one pair per request, ten at a time. Calls no Haiku model.

import "dotenv/config";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { anthropicCardModel, anthropicTopicModel, buildTopicMap, CARD_EXTRACTOR_VERSION, cardSummary, CARDS_MODEL, estimateCards, extractCards, latestMapVersion, mapMembers, plannedChunks, screenStoredNoAssertions, topicReport, TOPICS_MODEL } from "../server/src/claims";
import { budgetStatus, ensureBudget } from "../server/src/costs";
import { connect, type Database } from "../server/src/db/client";
import { anthropicAdjudicator, DEFAULT_EFFORT, DEFAULT_PROMPT_VERSION, DEFAULT_STRATEGY, STRATEGIES, type PromptVersion } from "../server/src/adjudicate";
import type { Effort } from "../server/src/adjudicate/prompt";
import { analysisView } from "../server/src/api/analyses";
import { analyses, budgets, depositions } from "../server/src/db/schema";
import { paidCallsAllowed, runAnalysis } from "../server/src/jobs";
import { mockCardModel, mockTopicModel, runDiscovery } from "../server/src/eval";
import { SYNTHETIC_SUITES } from "../server/src/eval/synthetic";
import { findPathB, findTopicPairs, unionCandidates } from "../server/src/retrieve";
import { emptyTables, openTestDatabase } from "../tests/db/database";
import { resolveDeposition, resolveWitness } from "./cases";

const Args = z.object({
  command: z.enum(["estimate", "report", "pool", "discovery", "cards", "topics", "screen", "analysis"]),
  caseId: z.coerce.number().int().positive().optional(),
  case: z.string().trim().min(1).optional(),
  witness: z.string().trim().min(1).optional(),
  deposition: z.coerce.number().int().positive().optional(),
  a: z.coerce.number().int().positive().optional(),
  b: z.coerce.number().int().positive().optional(),
  capacity: z.coerce.number().int().positive().optional(),
  distractors: z.coerce.number().int().nonnegative().default(60),
  mode: z.enum(["rare_terms", "all_terms"]).default("rare_terms"),
  parts: z.string().regex(/^\d+(,\d+)*$/).optional(),
  targeted: z.boolean().default(false),
  maxChunks: z.coerce.number().int().positive().optional(),
  budgetName: z.string().min(1).optional(),
  budgetLimit: z.coerce.number().positive().optional(),
});
type Args = z.infer<typeof Args>;

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

async function discovery(args: Args) {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error("discovery needs TEST_DATABASE_URL naming a database ending in _test.");
  const { db, pool } = await openTestDatabase();
  for (const suite of SYNTHETIC_SUITES) {
    await emptyTables(db);
    print({ note: "synthetic, mock models: measures the pipeline, not Haiku", ...(await runDiscovery(db, suite, { distractorsPerSession: args.distractors, capacity: args.capacity ?? 30, mode: args.mode, cards: mockCardModel(), topics: mockTopicModel() })) });
  }
  await pool.end();
}

async function sessionsOf(db: Database, witnessId: number) {
  return (await db.select({ id: depositions.id, status: depositions.status }).from(depositions).where(eq(depositions.witnessId, witnessId))).filter((d) => d.status === "ready").map((d) => d.id);
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { targeted: { type: "boolean" }, ...Object.fromEntries(["case-id", "case", "witness", "deposition", "a", "b", "capacity", "distractors", "mode", "max-chunks", "parts", "budget-name", "budget-limit"].map((k) => [k, { type: "string" as const }])) } });
  const args = Args.parse({ ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k.replace(/-(\w)/g, (_, c: string) => c.toUpperCase()), v])), command: positionals[0] });
  if (args.command === "discovery") return discovery(args);

  const { db, pool } = connect();
  try {
    const { caseId, witnessId } = await resolveWitness(db, { caseId: args.caseId, caseName: args.case, witnessName: args.witness! });
    const sessions = args.deposition ? [args.deposition] : await sessionsOf(db, witnessId);
    switch (args.command) {
      case "estimate": {
        const perSession = [];
        for (const id of sessions) perSession.push({ depositionId: id, ...estimateCards(await plannedChunks(db, id)) });
        print({ model: CARDS_MODEL, extractorVersion: CARD_EXTRACTOR_VERSION, sessions: perSession, expectedUsd: perSession.reduce((n, s) => n + s.expectedUsd, 0), worstCaseUsd: perSession.reduce((n, s) => n + s.worstCaseUsd, 0) });
        break;
      }
      case "screen": {
        for (const id of sessions) print({ depositionId: id, suspected: await screenStoredNoAssertions(db, id) });
        break;
      }
      case "report": {
        const mapVersion = await latestMapVersion(db, witnessId);
        print({ extractorVersion: CARD_EXTRACTOR_VERSION, cards: await Promise.all(sessions.map((d) => cardSummary(db, d))), mapVersion, topics: mapVersion === null ? null : topicReport(await mapMembers(db, witnessId, mapVersion)) });
        break;
      }
      case "pool": {
        if (!args.a || !args.b) throw new Error("pool needs --a and --b.");
        const pathA = await findTopicPairs(db, { witnessId, depositionIds: [args.a, args.b], extractorVersion: CARD_EXTRACTOR_VERSION });
        const pathB = (await findPathB(db, { witnessId, depositionId: args.b, mode: args.mode })).pairs.filter((p) => p.a.depositionId === args.a || p.b.depositionId === args.a);
        print({ cards: pathA.cards, mapVersion: pathA.mapVersion, ...unionCandidates({ topics: pathA.pairs, fulltext: pathB }, { capacity: args.capacity ?? 300 }).counts });
        break;
      }
      case "analysis": {
        if (!args.a || !args.b || !args.budgetLimit) throw new Error("analysis needs --a, --b and --budget-limit.");
        if (!paidCallsAllowed(process.env)) throw new Error("analysis needs ANTHROPIC_API_KEY and ALLOW_PAID_CALLS=true.");
        const strategy = STRATEGIES[DEFAULT_STRATEGY];
        const [row] = await db.insert(analyses).values({ caseId, witnessId, depositionA: args.a, depositionB: args.b, mode: "live", retrieval: "hybrid", promptVersion: DEFAULT_PROMPT_VERSION, effort: DEFAULT_EFFORT, maxCandidates: args.capacity ?? 300, budgetUsd: args.budgetLimit, strategy: strategy.id, candidatesPerRequest: strategy.candidatesPerRequest, maxConcurrency: strategy.maxConcurrency }).returning();
        const [budget] = await db.insert(budgets).values({ name: `analysis-${row.id}`, limitUsd: args.budgetLimit }).returning();
        await db.update(analyses).set({ budgetId: budget.id }).where(eq(analyses.id, row.id));
        const outcome = await runAnalysis(db, row.id, { liveAdjudicator: (a) => anthropicAdjudicator(a.effort as Effort, a.promptVersion as PromptVersion), useStoredCards: true });
        print({ analysisId: row.id, outcome, view: await analysisView(db, row.id) });
        break;
      }
      case "cards":
      case "topics": {
        if (!args.budgetName || !args.budgetLimit) throw new Error("Paid commands need --budget-name and --budget-limit.");
        if (args.command === "cards" && !args.deposition) throw new Error("cards needs --deposition.");
        const budgetId = await ensureBudget(db, args.budgetName, args.budgetLimit);
        if (args.command === "cards") print(await extractCards(db, await resolveDeposition(db, { caseId, witnessId }, args.deposition), anthropicCardModel(), { budgetId, maxChunks: args.maxChunks, targeted: args.targeted, only: args.parts?.split(",").map(Number) }));
        else print({ model: TOPICS_MODEL, ...(await buildTopicMap(db, witnessId, anthropicTopicModel(), { budgetId })) });
        print(await budgetStatus(db, budgetId));
        break;
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
