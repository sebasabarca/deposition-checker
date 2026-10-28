// Previews Path B's candidate pairs for a witness, with both passages at their page:line, for
// labelling. Read-only. Passages are printed from the stored source lines, never derived text.
//
//   npx tsx scripts/pathb.ts (--case-id <id> | --case <name>) --witness <name> [--deposition <id>]
//     [--mode all_terms|rare_terms] [--limit 15] [--lines 8]

import "dotenv/config";
import { parseArgs } from "node:util";
import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { connect, type Database } from "../server/src/db/client";
import { depositions, exchangeLines, exchanges, lines } from "../server/src/db/schema";
import { findPathB } from "../server/src/retrieve";
import { resolveDeposition, resolveWitness } from "./cases";

const USAGE =
  "Usage: npx tsx scripts/pathb.ts (--case-id <id> | --case <name>) --witness <name> [--deposition <id>] [--mode all_terms|rare_terms] [--limit 15] [--lines 8]";

const Args = z.object({
  caseId: z.coerce.number().int().positive().optional(),
  case: z.string().trim().min(1).optional(),
  witness: z.string().trim().min(1),
  deposition: z.coerce.number().int().positive().optional(),
  mode: z.enum(["all_terms", "rare_terms"]).default("all_terms"),
  limit: z.coerce.number().int().nonnegative().default(15),
  lines: z.coerce.number().int().positive().default(8),
});

function readArgs() {
  const { values } = parseArgs({
    options: {
      "case-id": { type: "string" },
      case: { type: "string" },
      witness: { type: "string" },
      deposition: { type: "string" },
      mode: { type: "string" },
      limit: { type: "string" },
      lines: { type: "string" },
    },
  });
  const parsed = Args.safeParse({ ...values, caseId: values["case-id"] });
  if (!parsed.success) throw new Error(`${z.prettifyError(parsed.error)}\n${USAGE}`);
  return parsed.data;
}

// Each exchange part's deposition and its member lines, in transcript order.
async function passages(db: Database, ids: number[]) {
  const rows = await db
    .select({
      exchangeId: exchangeLines.exchangeId,
      depositionId: exchanges.depositionId,
      fileSha256: depositions.fileSha256,
      page: lines.printedPage,
      line: lines.lineNo,
      text: lines.rawText,
    })
    .from(exchangeLines)
    .innerJoin(lines, eq(lines.id, exchangeLines.lineId))
    .innerJoin(exchanges, eq(exchanges.id, exchangeLines.exchangeId))
    .innerJoin(depositions, eq(depositions.id, exchanges.depositionId))
    .where(inArray(exchangeLines.exchangeId, ids))
    .orderBy(asc(lines.printedPage), asc(lines.lineNo));
  const byExchange = new Map<number, typeof rows>();
  for (const r of rows) byExchange.set(r.exchangeId, [...(byExchange.get(r.exchangeId) ?? []), r]);
  return byExchange;
}

async function main() {
  const args = readArgs();
  const { db, pool } = connect();
  try {
    const target = await resolveWitness(db, { caseId: args.caseId, caseName: args.case, witnessName: args.witness });
    const depositionId = await resolveDeposition(db, target, args.deposition);

    const started = performance.now();
    const { pairs, counts } = await findPathB(db, { witnessId: target.witnessId, depositionId, mode: args.mode });
    const ms = Math.round(performance.now() - started);

    console.log(`Path B, ${args.mode}: deposition ${depositionId} against ${args.witness}'s other sessions, both directions (${ms} ms)`);
    console.log(
      `  ${counts.exchanges} exchange parts: ${counts.procedural} procedural, ${counts.tooFewTerms} with too few terms, ${counts.queried} queried`,
    );
    console.log(`  ${pairs.length} pairs of logical exchanges; showing the top ${Math.min(args.limit, pairs.length)}`);
    console.log("  Score: share of the smaller exchange's distinctive vocabulary found in the other (0–1). Retrieval relevance, not contradiction.\n");

    const shown = pairs.slice(0, args.limit);
    const text = await passages(db, shown.flatMap((p) => [p.exchangeA, p.exchangeB]));
    for (const pair of shown) {
      console.log(`#${pair.rank}  score ${pair.score.toFixed(4)}  found by ${pair.foundBy}  shared: ${pair.sharedTerms.join(", ")}`);
      for (const [side, id, logical] of [["A", pair.exchangeA, pair.a], ["B", pair.exchangeB, pair.b]] as const) {
        const own = text.get(id) ?? [];
        const first = own[0];
        const last = own[own.length - 1];
        console.log(
          `  ${side}  deposition ${logical.depositionId} (file ${first?.fileSha256.slice(0, 12)}), ${first?.page}:${first?.line}–${last?.page}:${last?.line}, exchange ${logical.groupId} part ${id}`,
        );
        for (const l of own.slice(0, args.lines)) console.log(`     ${`${l.page}:${l.line}`.padEnd(7)} ${l.text}`);
        if (own.length > args.lines) console.log(`     … ${own.length - args.lines} more lines`);
      }
      console.log();
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
