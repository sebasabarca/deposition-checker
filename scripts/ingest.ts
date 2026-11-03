// Ingests one deposition PDF from the command line (development only; the finished app ingests
// uploads in a background job). Creates the org, case and witness if they don't exist yet.
//
//   npx tsx scripts/ingest.ts <file.pdf> --case "U.S. v. Oracle" --witness "Lawrence Ellison" [--taken-on 2004-01-20]
//     [--session-of <deposition id>]
// --session-of stores the file as the next part of that deposition's session (one sitting split over
// several files). Without it the file is a session of its own: files are never joined by witness or date.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";
import { connect } from "../server/src/db/client";
import { eq } from "drizzle-orm";
import { depositions } from "../server/src/db/schema";
import { nextSessionPart } from "../server/src/evidence";
import { ingestFile } from "../server/src/ingest";
import { findOrCreateWitness } from "./cases";

const Args = z.object({
  file: z.string().min(1),
  case: z.string().trim().min(1),
  witness: z.string().trim().min(1),
  takenOn: z.iso.date().nullable(),
  sessionOf: z.coerce.number().int().positive().nullable(),
});

function readArgs() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { case: { type: "string" }, witness: { type: "string" }, "taken-on": { type: "string" }, "session-of": { type: "string" } },
  });
  const parsed = Args.safeParse({ file: positionals[0], case: values.case, witness: values.witness, takenOn: values["taken-on"] ?? null, sessionOf: values["session-of"] ?? null });
  if (!parsed.success) {
    throw new Error(
      `${z.prettifyError(parsed.error)}\nUsage: npx tsx scripts/ingest.ts <file.pdf> --case <name> --witness <name> [--taken-on YYYY-MM-DD] [--session-of <deposition id>]`,
    );
  }
  return parsed.data;
}

async function main() {
  const args = readArgs();
  const data = new Uint8Array(readFileSync(args.file));
  const { db, pool } = connect();
  try {
    const target = await findOrCreateWitness(db, args.case, args.witness);
    let session: { id: number; part: number } | undefined;
    if (args.sessionOf !== null) {
      const [other] = await db.select({ sessionId: depositions.sessionId, caseId: depositions.caseId, witnessId: depositions.witnessId }).from(depositions).where(eq(depositions.id, args.sessionOf));
      if (!other) throw new Error(`No deposition ${args.sessionOf}.`);
      if (other.caseId !== target.caseId || other.witnessId !== target.witnessId) throw new Error(`Deposition ${args.sessionOf} is another case's or witness's session.`);
      session = { id: other.sessionId, part: await nextSessionPart(db, other.sessionId) };
    }
    const result = await ingestFile(db, data, { ...target, takenOn: args.takenOn, witnessName: args.witness, session });
    const { counts, reasons } = result.attempt;

    if (result.outcome === "kept_previous") {
      console.log(`${args.file}: this attempt was ${result.attempt.status}; kept the ready deposition already stored`);
    } else {
      console.log(`${args.file}: ${result.status}${result.outcome === "replaced" ? " (replaced the previous ingestion of this file)" : ""}`);
    }
    console.log(`  deposition ${result.depositionId} in "${args.case}", witness "${args.witness}"${session ? `, part ${session.part} of session ${session.id}` : ""}`);
    console.log(`  pages read: ${counts.text} text, ${counts.blank} blank, ${counts.needs_ocr} need OCR, ${counts.failed} failed`);
    console.log(`  stored: ${result.lines} lines, ${result.exchanges} exchanges in ${result.parts} parts`);
    for (const reason of reasons) console.log(`  - ${reason}`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
