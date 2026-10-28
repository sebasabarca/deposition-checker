// Migrations applied to a database that already holds data, not only to an empty one.
// See tests/db/database.ts for when it runs.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, describe, expect, it } from "vitest";
import { openTestDatabase, TEST_DATABASE_URL } from "./database";

// A copy of drizzle/ that stops after the first `count` migrations.
function migrationsUpTo(count: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), "migrations-"));
  cpSync("drizzle", dir, { recursive: true });
  const journalPath = path.join(dir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, count) }));
  return dir;
}

describe.skipIf(!TEST_DATABASE_URL)("migrations on a populated database (Postgres)", () => {
  const folders: string[] = [];
  const pools: { end(): Promise<void> }[] = [];

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    for (const dir of folders) rmSync(dir, { recursive: true, force: true });
  });

  it("0001 fills exchanges.witness_id from each exchange's deposition", async () => {
    const before = migrationsUpTo(1);
    folders.push(before);
    const { db, pool } = await openTestDatabase(before);
    pools.push(pool);

    // Two witnesses with one ingested exchange each, written as 0000 left the tables.
    await db.execute(sql`
      insert into orgs (name) values ('Demo');
      insert into cases (org_id, name) values (1, 'U.S. v. Oracle');
      insert into witnesses (case_id, name) values (1, 'Lawrence Ellison'), (1, 'Safra Catz');
      insert into depositions (case_id, witness_id, file_sha256, storage_key, page_count, validation, parser_version, status)
        values (1, 1, repeat('a', 64), 'a.pdf', 1, '{}', 'v1', 'ready'),
               (1, 2, repeat('b', 64), 'b.pdf', 1, '{}', 'v1', 'ready');
      insert into lines (deposition_id, pdf_page, printed_page, line_no, speaker_role, raw_text, norm_text)
        values (1, 1, 161, 1, 'witness', 'Yes.', 'yes'), (2, 1, 9, 1, 'witness', 'No.', 'no');
      insert into exchanges (deposition_id, group_id, part_no, part_count, kind, first_line_id, last_line_id,
                             answer_line_count, question_text, answer_text, dialogue_text)
        values (1, 1, 1, 1, 'qa', 1, 1, 1, '', 'Yes.', 'A: Yes.'), (2, 1, 1, 1, 'qa', 2, 2, 1, '', 'No.', 'A: No.');
    `);

    await migrate(db, { migrationsFolder: "drizzle" });

    const rows = await db.execute<{ deposition_id: string; witness_id: string }>(
      sql`select deposition_id, witness_id from exchanges order by deposition_id`,
    );
    expect(rows.rows.map((r) => [Number(r.deposition_id), Number(r.witness_id)])).toEqual([
      [1, 1],
      [2, 2],
    ]);
    const column = await db.execute<{ is_nullable: string }>(
      sql`select is_nullable from information_schema.columns where table_name = 'exchanges' and column_name = 'witness_id'`,
    );
    expect(column.rows[0].is_nullable).toBe("NO");
  });

  it("0005 builds the full-text column for exchanges that already exist", async () => {
    const before = migrationsUpTo(5);
    folders.push(before);
    const { db, pool } = await openTestDatabase(before);
    pools.push(pool);

    await db.execute(sql`
      insert into orgs (name) values ('Demo');
      insert into cases (org_id, name) values (1, 'U.S. v. Oracle');
      insert into witnesses (case_id, name) values (1, 'Lawrence Ellison');
      insert into depositions (case_id, witness_id, file_sha256, storage_key, page_count, validation, parser_version, status)
        values (1, 1, repeat('a', 64), 'a.pdf', 1, '{}', 'v1', 'ready');
      insert into lines (deposition_id, pdf_page, printed_page, line_no, speaker_role, raw_text, norm_text)
        values (1, 1, 161, 1, 'witness', 'We outsourced it.', 'we outsourced it');
      insert into exchanges (deposition_id, witness_id, group_id, part_no, part_count, kind, first_line_id, last_line_id,
                             answer_line_count, question_text, answer_text, dialogue_text)
        values (1, 1, 1, 1, 1, 'qa', 1, 1, 1, 'Did Oracle buy the software?', 'We outsourced it.', '');
    `);

    await migrate(db, { migrationsFolder: "drizzle" });

    const rows = await db.execute<{ terms: string[] }>(sql`select tsvector_to_array(tsv) as terms from exchanges`);
    expect(rows.rows[0].terms.sort()).toEqual(["buy", "oracl", "outsourc", "softwar"]);
  });
});
