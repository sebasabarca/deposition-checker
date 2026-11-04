// Seeds the hand-authored demonstration case into an account (scripts/demo-case-seed.ts). No model
// or API call, nothing deleted; a second run changes nothing.
//
//   npx tsx scripts/demo-case.ts --email <account email>

import "dotenv/config";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { connect } from "../server/src/db/client";
import { users } from "../server/src/db/schema";
import { DEMO_CASE_NAME } from "../server/src/data/demoCase";
import { seedDemoCase } from "./demo-case-seed";

async function main() {
  const { values } = parseArgs({ options: { email: { type: "string" } } });
  if (!values.email) {
    console.error("Usage: npx tsx scripts/demo-case.ts --email <account email>");
    process.exitCode = 1;
    return;
  }
  const { db, pool } = connect();
  try {
    const [user] = await db.select({ orgId: users.orgId }).from(users).where(eq(users.email, values.email.trim().toLowerCase()));
    if (!user) throw new Error(`No account uses ${values.email}. Register it in the app first.`);
    const seed = await seedDemoCase(db, user.orgId);
    console.log(`${seed.created ? "Seeded" : "Already present"}: "${DEMO_CASE_NAME}" (case ${seed.caseId}), ${seed.analyses.length} demo analyses, ${seed.findings} findings.`);
    console.log("Every finding is a hand-authored example assessment, labelled in the app as not produced by a model.");
  } finally {
    await pool.end();
  }
}

void main();
