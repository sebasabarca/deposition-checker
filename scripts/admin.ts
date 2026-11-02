// Account administration, run by whoever operates Veridict:
//   npm run admin -- grant-analysis <email>    let this account start paid checks
//   npm run admin -- revoke-analysis <email>
//   npm run admin -- verify <email>            mark the email verified (when email isn't set up)
//   npm run admin -- claim-cases <email>       move every case no account owns into this account
// Paid checks stay off for new accounts until credits exist, so granting them is deliberate.

import "dotenv/config";
import { eq, notInArray, sql } from "drizzle-orm";
import { connect } from "../server/src/db/client";
import { cases, users } from "../server/src/db/schema";

const [command, rawEmail] = process.argv.slice(2);
const COMMANDS = ["grant-analysis", "revoke-analysis", "verify", "claim-cases"];

async function main() {
  if (!COMMANDS.includes(command) || !rawEmail) {
    console.error(`Usage: npm run admin -- <${COMMANDS.join("|")}> <email>`);
    process.exitCode = 1;
    return;
  }
  const { db, pool } = connect();
  try {
    const [user] = await db.select().from(users).where(eq(users.email, rawEmail.trim().toLowerCase()));
    if (!user) throw new Error(`No account uses ${rawEmail}.`);
    if (command === "grant-analysis" || command === "revoke-analysis") {
      await db.update(users).set({ analysisAccess: command === "grant-analysis" }).where(eq(users.id, user.id));
      console.log(`${user.email}: paid checks ${command === "grant-analysis" ? "enabled" : "disabled"}.`);
    } else if (command === "verify") {
      await db.update(users).set({ emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` }).where(eq(users.id, user.id));
      console.log(`${user.email}: email marked verified.`);
    } else {
      // Cases in workspaces with no account: the ones made before accounts existed.
      const moved = await db.update(cases).set({ orgId: user.orgId }).where(notInArray(cases.orgId, db.select({ org: users.orgId }).from(users))).returning({ id: cases.id });
      console.log(`${user.email}: ${moved.length} ${moved.length === 1 ? "case" : "cases"} moved into this account.`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
