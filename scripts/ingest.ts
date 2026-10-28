// Ingests one deposition PDF from the command line (development only; the finished app ingests
// uploads in a background job). Creates the org, case and witness if they don't exist yet.
//
//   npx tsx scripts/ingest.ts <file.pdf> --case "U.S. v. Oracle" --witness "Lawrence Ellison" [--taken-on 2004-01-20]

import "dotenv/config";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";
import { connect } from "../server/src/db/client";
import { ingestFile } from "../server/src/ingest";
import { findOrCreateWitness } from "./cases";

const Args = z.object({
  file: z.string().min(1),
  case: z.string().trim().min(1),
  witness: z.string().trim().min(1),
  takenOn: z.iso.date().nullable(),
});

function readArgs() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { case: { type: "string" }, witness: { type: "string" }, "taken-on": { type: "string" } },
  });
  const parsed = Args.safeParse({ file: positionals[0], case: values.case, witness: values.witness, takenOn: values["taken-on"] ?? null });
  if (!parsed.success) {
    throw new Error(
      `${z.prettifyError(parsed.error)}\nUsage: npx tsx scripts/ingest.ts <file.pdf> --case <name> --witness <name> [--taken-on YYYY-MM-DD]`,
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
    const result = await ingestFile(db, data, { ...target, takenOn: args.takenOn });
    const { counts, reasons } = result.attempt;

    if (result.outcome === "kept_previous") {
      console.log(`${args.file}: this attempt was ${result.attempt.status}; kept the ready deposition already stored`);
    } else {
      console.log(`${args.file}: ${result.status}${result.outcome === "replaced" ? " (replaced the previous ingestion of this file)" : ""}`);
    }
    console.log(`  deposition ${result.depositionId} in "${args.case}", witness "${args.witness}"`);
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
