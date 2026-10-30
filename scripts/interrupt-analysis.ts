// Closes out an analysis whose worker is gone (development only): marks it interrupted, and counts any
// request it left open at its full reservation, since that request may have been billed. No API call.
//
//   npx tsx scripts/interrupt-analysis.ts --analysis <id>

import "dotenv/config";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { connect } from "../server/src/db/client";
import { analyses } from "../server/src/db/schema";
import { interruptAnalysis, TERMINAL } from "../server/src/jobs";

async function main() {
  const { values } = parseArgs({ options: { analysis: { type: "string" } } });
  const id = Number(values.analysis);
  if (!Number.isInteger(id) || id < 1) throw new Error("Usage: npx tsx scripts/interrupt-analysis.ts --analysis <id>");
  const { db, pool } = connect();
  try {
    const [a] = await db.select().from(analyses).where(eq(analyses.id, id));
    if (!a) throw new Error(`No analysis ${id}.`);
    if (TERMINAL.includes(a.status)) return console.log(`Analysis ${id} is already ${a.status}; nothing changed.`);
    await interruptAnalysis(db, a, "Stopped by hand on October 30 with its worker. Completed findings are kept. One request was in flight: it is counted in full in case it was billed.");
    console.log(`Analysis ${id} is now interrupted.`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
