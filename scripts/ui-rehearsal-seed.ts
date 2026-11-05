// Seeds a DISPOSABLE database for checking the lawyer UI's quarantine states in a browser (names must contain
// "_rehearsal_"): a verified reviewer, the hand-written demo case (synthetic testimony), a confirmed, a dismissed
// and an unreviewed finding, then a quarantine of one confirmed and one unreviewed finding. No model call.
//   npx tsx scripts/ui-rehearsal-seed.ts --db <x_rehearsal_ui> --uploads <dir> --out data/raw/<file>.json
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { hashPassword } from "../server/src/auth";
import { connect } from "../server/src/db/client";
import { candidates, findings, orgs, users } from "../server/src/db/schema";
import { quarantineFindings } from "../server/src/evidence";
import { seedDemoCase } from "./demo-case-seed";

const { values: v } = parseArgs({ options: { db: { type: "string" }, uploads: { type: "string" }, out: { type: "string" } } });
if (!/_rehearsal_/.test(v.db!)) throw new Error(`${v.db} is not a disposable rehearsal database`);
const url = (db: string) => { const u = new URL(process.env.DATABASE_URL!); u.pathname = `/${db}`; return u.toString(); };
async function main() {
  const admin = new pg.Client({ connectionString: url("postgres") });
  await admin.connect();
  await admin.query(`drop database if exists "${v.db}"`);
  await admin.query(`create database "${v.db}"`);
  await admin.end();
  const { db, pool } = connect(url(v.db!), { max: 2 });
  await migrate(db, { migrationsFolder: "drizzle" });
  const [org] = await db.insert(orgs).values({ name: "UI rehearsal" }).returning();
  const password = `Rehearsal-${Math.random().toString(36).slice(2)}!9`;
  await db.insert(users).values({ orgId: org.id, email: "reviewer@rehearsal.test", name: "Rehearsal Reviewer", passwordHash: await hashPassword(password), emailVerifiedAt: new Date() });
  const seeded = await seedDemoCase(db, org.id, v.uploads);
  const analysisId = seeded.analyses[0];
  const rows = await db.select({ id: findings.id, dep: candidates.depositionA }).from(findings).innerJoin(candidates, eq(candidates.id, findings.candidateId)).where(eq(candidates.candidateSet, `analysis-${analysisId}`)).orderBy(findings.id);
  const [conf, dism, unrev, keepCurrent, stale409] = rows.map((r) => r.id);
  await db.update(findings).set({ reviewState: "confirmed", reviewNote: "Kept: the dates conflict.", reviewedAt: new Date("2026-10-20T15:00:00Z") }).where(eq(findings.id, conf));
  await db.update(findings).set({ reviewState: "dismissed", reviewNote: "Different events.", reviewedAt: new Date("2026-10-21T15:00:00Z") }).where(eq(findings.id, dism));
  const q = await quarantineFindings(db, rows[0].dep, "source re-read by parser r12: a line its packet showed changed speaker or exchange", [conf, unrev]);
  writeFileSync(v.out!, JSON.stringify({ analysisId, caseId: seeded.caseId, email: "reviewer@rehearsal.test", password, findings: { quarantinedConfirmed: conf, quarantinedUnreviewed: unrev, currentDismissed: dism, currentUnreviewed: keepCurrent, toQuarantineWhileOpen: stale409 }, dep: rows[0].dep, quarantine: q, all: rows.length }, null, 1));
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
