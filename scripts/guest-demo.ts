// Prepares the database for the public read-only demo (guest mode, server/src/guest.ts). No model call.
// It prunes a RESTORED COPY down to one case and one finished analysis, so the copy holds nothing else:
//
//   npx tsx scripts/db-snapshot.ts dump --db <source> --out data/raw/guest-demo/source.dump
//   npx tsx scripts/db-snapshot.ts restore --file data/raw/guest-demo/source.dump --into <name>_rehearsal_guest
//   npx tsx scripts/guest-demo.ts --db <name>_rehearsal_guest --case <id> --run <id> --email guest@demo.example.test \
//     [--uploads-out data/raw/guest-demo/uploads]
//
// In the copy: every other case is deleted (as the app deletes one), and the case's other analyses; the case moves
// to a new "Demo" organization whose only member is the guest account (no password; it opens only through guest
// mode); every other account, organization, session and token goes; model-call records nothing points at any more
// are deleted (run #38's costs stay), and the job queue is emptied. The case's PDFs are copied to --uploads-out.
// It refuses a database without "_rehearsal_" in its name, so it can never prune a working database.

import "dotenv/config";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { and, eq, ne, sql } from "drizzle-orm";
import { deleteCase, removeCaseRuns } from "../server/src/api/remove";
import { connect, withTransaction } from "../server/src/db/client";
import { caseRuns, cases, depositions, orgs, users } from "../server/src/db/schema";
import { guestEmail } from "../server/src/guest";
import { UPLOADS_DIR } from "../server/src/ingest";

async function main() {
  const { values: args } = parseArgs({ options: { db: { type: "string" }, case: { type: "string" }, run: { type: "string" }, email: { type: "string" }, "uploads-out": { type: "string" } } });
  const caseId = Number(args.case);
  const runId = Number(args.run);
  if (!args.db?.includes("_rehearsal_")) throw new Error("--db must be a restored copy: its name must contain _rehearsal_.");
  if (!Number.isInteger(caseId) || !Number.isInteger(runId)) throw new Error("--case and --run take ids.");
  const email = guestEmail({ GUEST_MODE: "true", GUEST_EMAIL: args.email });
  if (!email) throw new Error("--email must be an address at example.test (a reserved domain, never a real person's).");

  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${args.db}`;
  process.env.DATABASE_URL = url.toString();
  const { db, pool } = connect();

  const [run] = await db.select().from(caseRuns).where(and(eq(caseRuns.id, runId), eq(caseRuns.caseId, caseId)));
  if (!run || run.status !== "completed") throw new Error(`Run #${runId} isn't a completed analysis of case ${caseId}.`);

  // shortcut: candidates has no index on exchange_a/_b, so each deleted exchange scans it; temporary indexes on this
  // copy only (dropped below). A migration adding them would speed up the app's own case delete too.
  const TEMP_INDEXES = ["exchange_a", "exchange_b"];
  for (const col of TEMP_INDEXES) await db.execute(sql.raw(`create index if not exists guest_demo_tmp_${col} on candidates (${col})`));

  // Other cases, exactly as the app deletes them; their files are left alone (a scratch folder stands in for uploads).
  const others = await db.select({ id: cases.id }).from(cases).where(ne(cases.id, caseId));
  for (const { id } of others) {
    const removed = await deleteCase(db, pool, id, path.join(process.env.TMPDIR ?? "/tmp", "guest-demo-no-uploads"));
    if (removed.outcome === "running") throw new Error(`Case ${id} has an analysis running in this copy; nothing more was pruned.`);
  }

  await withTransaction(pool, async (tx) => {
    await removeCaseRuns(tx, (await tx.select({ id: caseRuns.id }).from(caseRuns).where(and(eq(caseRuns.caseId, caseId), ne(caseRuns.id, runId)))).map((r) => r.id));
    const [org] = await tx.insert(orgs).values({ name: "Demo" }).returning();
    await tx.update(cases).set({ orgId: org.id }).where(eq(cases.id, caseId));
    await tx.delete(users).where(sql`true`); // sessions and tokens cascade
    await tx.delete(orgs).where(ne(orgs.id, org.id));
    await tx.insert(users).values({ orgId: org.id, email, name: "Guest", passwordHash: "none", emailVerifiedAt: new Date(), onboardedAt: new Date() });
    // Requests and spending limits of anything else (experiments, other runs), then cost records nothing points at.
    await tx.execute(sql`delete from adjudication_requests a where candidate_set is distinct from ${`case-run-${runId}`} and not exists (select 1 from verdicts v where v.request_id = a.id)`);
    await tx.execute(sql`delete from budget_reservations r using budgets b where r.budget_id = b.id and b.name <> ${`case-run-${runId}`}`);
    await tx.execute(sql`delete from budgets where name <> ${`case-run-${runId}`}`);
    // Every foreign key into llm_calls, read from the catalog.
    const refs = await tx.execute<{ tbl: string; col: string }>(sql`
      select c.conrelid::regclass::text as tbl, a.attname as col from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
      where c.contype = 'f' and c.confrelid = 'llm_calls'::regclass`);
    const unused = refs.rows.map((r) => sql.raw(`and not exists (select 1 from ${r.tbl} x where x.${r.col} = l.id)`));
    await tx.execute(sql`delete from llm_calls l where true ${sql.join(unused, sql` `)}`);
  });
  await db.execute(sql`delete from pgboss.job`);
  for (const col of TEMP_INDEXES) await db.execute(sql.raw(`drop index guest_demo_tmp_${col}`));

  const files = await db.select({ key: depositions.storageKey }).from(depositions).where(eq(depositions.caseId, caseId));
  if (args["uploads-out"]) {
    await mkdir(args["uploads-out"], { recursive: true });
    for (const { key } of files) await copyFile(path.join(UPLOADS_DIR, key), path.join(args["uploads-out"], key));
  }

  // What is left, table by table, so the copy can be checked before it's published.
  const tables = await db.execute<{ name: string }>(sql`select table_name as name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`);
  const fresh = await db.execute<{ table: string; rows: string }>(sql.raw(
    tables.rows.map((t) => `select '${t.name}' as table, count(*)::text as rows from public."${t.name}"`).join(" union all ") + " order by 1"));
  console.log(fresh.rows.filter((r) => r.rows !== "0").map((r) => `${r.table}: ${r.rows}`).join("\n"));
  console.log(`\nKept case ${caseId} with run #${runId}; guest ${email}; ${files.length} PDFs${args["uploads-out"] ? ` copied to ${args["uploads-out"]}` : " (not copied: no --uploads-out)"}.`);
  await pool.end();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
