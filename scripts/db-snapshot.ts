// Full-database snapshot and restore, for evidence corrections (docs/evidence-correction.md). No model call.
// Uses pg_dump/pg_restore from PATH, or inside the Postgres container named by PG_DOCKER_CONTAINER.
//
//   npx tsx scripts/db-snapshot.ts dump --db <name> --out data/raw/<dir>/<name>.dump
//     Custom-format dump of the whole database (every schema: data, ledger, quarantine, pg-boss jobs), then its
//     SHA-256 and the archive's table of contents are checked readable. Never writes to the database.
//   npx tsx scripts/db-snapshot.ts restore --file <dump> --into <new _rehearsal_ name>
//     Restores into a NEW database it creates; refuses an existing one, so it can never overwrite a database.
//   npx tsx scripts/db-snapshot.ts verify --a <db> --b <db>
//     Compares two databases: every table's rows (by hash), the guard triggers and functions, constraints, the
//     migration ledger, epochs, quarantine and reviews; then the integrity checks of every document.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import pg from "pg";
import { connect } from "../server/src/db/client";
import { integrity } from "../server/src/evidence";

const base = () => new URL(process.env.DATABASE_URL!);
const urlOf = (db: string) => { const u = base(); u.pathname = `/${db}`; return u.toString(); };
const CONTAINER = process.env.PG_DOCKER_CONTAINER ?? "deposition-checker-db-1";
const onPath = (bin: string) => { try { execFileSync("which", [bin], { stdio: "ignore" }); return true; } catch { return false; } };

// Runs a Postgres client tool with the connection's credentials in its environment, never on the command line.
// A dump file to read is passed by path (copied into the container when the tools run there): pg_restore --list
// reads only the archive's table of contents, so feeding it on stdin would break the pipe.
function tool(bin: "pg_dump" | "pg_restore", args: string[], file?: string): Buffer {
  const u = base();
  const env = { PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGHOST: u.hostname, PGPORT: u.port || "5432" };
  if (onPath(bin)) return execFileSync(bin, [...args, ...(file ? [file] : [])], { env: { ...process.env, ...env }, maxBuffer: 2 ** 31 });
  const inside = file ? `/tmp/${path.basename(file)}` : null;
  if (file) execFileSync("docker", ["cp", file, `${CONTAINER}:${inside}`]);
  try {
    return execFileSync("docker", ["exec", "-e", `PGUSER=${env.PGUSER}`, "-e", `PGPASSWORD=${env.PGPASSWORD}`, CONTAINER, bin, "-h", "localhost", ...args, ...(inside ? [inside] : [])], { maxBuffer: 2 ** 31 });
  } finally {
    if (inside) execFileSync("docker", ["exec", CONTAINER, "rm", "-f", inside]);
  }
}

async function fingerprint(db: string) {
  const c = new pg.Client({ connectionString: urlOf(db) });
  await c.connect();
  try {
    const tables = (await c.query("select schemaname s, tablename t from pg_tables where schemaname in ('public', 'drizzle', 'pgboss') order by 1, 2")).rows as { s: string; t: string }[];
    const rows: Record<string, string> = {};
    for (const { s, t } of tables) { const r = (await c.query(`select count(*)::int n, md5(coalesce(string_agg(md5(x::text), '' order by md5(x::text)), '')) h from "${s}"."${t}" x`)).rows[0]; rows[`${s}.${t}`] = `${r.n}:${r.h}`; }
    const one = async (q: string) => (await c.query(q)).rows;
    return {
      rows,
      triggers: (await one("select count(*)::int n from pg_trigger where tgname like '%evidence_guard%'"))[0].n as number,
      functions: (await one("select string_agg(proname, ',' order by proname) f from pg_proc where proname like 'evidence_guard%'"))[0].f as string,
      constraints: (await one("select count(*)::int n, count(*) filter (where not convalidated)::int invalid from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public'"))[0],
      ledger: await one("select id, kind, status, plan_hash from evidence_migrations order by id"),
      epochs: await one("select id::int, evidence_epoch, evidence_hold from depositions where evidence_epoch > 0 or evidence_hold is not null order by id"),
      quarantine: (await one("select kind, count(*)::int n from evidence_quarantine group by 1 order by 1")),
      reviews: (await one("select review_state, count(*)::int n from findings group by 1 order by 1")),
      documents: (await one("select id::int from depositions order by id")).map((r) => r.id as number),
    };
  } finally { await c.end(); }
}

async function main() {
  const [cmd] = process.argv.slice(2);
  const { values: v } = parseArgs({ args: process.argv.slice(3), options: { db: { type: "string" }, out: { type: "string" }, file: { type: "string" }, into: { type: "string" }, a: { type: "string" }, b: { type: "string" } } });
  if (cmd === "dump") {
    const out = path.resolve(v.out!);
    if (!out.startsWith(path.resolve("data/raw") + path.sep)) throw new Error("A dump holds testimony: write it under data/raw/.");
    mkdirSync(path.dirname(out), { recursive: true });
    const dump = tool("pg_dump", ["-Fc", "-d", v.db!]);
    writeFileSync(out, dump);
    const sha = createHash("sha256").update(readFileSync(out)).digest("hex");
    const toc = tool("pg_restore", ["--list"], out).toString();
    writeFileSync(`${out}.sha256`, `${sha}  ${path.basename(out)}\n`);
    console.log(JSON.stringify({ file: out, bytes: dump.length, sha256: sha, tocEntries: toc.split("\n").filter((l) => l && !l.startsWith(";")).length }));
  } else if (cmd === "restore") {
    const into = v.into!;
    if (!/_rehearsal_/.test(into) || /_batch_/.test(into)) throw new Error(`${into} is not a disposable rehearsal database`);
    // The dump is checked before anything is created.
    const file = readFileSync(v.file!);
    const [line] = readFileSync(`${v.file}.sha256`, "utf8").split("\n");
    const sha = createHash("sha256").update(file).digest("hex");
    if (line.split(/\s+/)[0] !== sha) throw new Error(`The dump's SHA-256 is ${sha}, not the recorded ${line.split(/\s+/)[0]}: refusing to restore it.`);
    const admin = new pg.Client({ connectionString: urlOf("postgres") });
    await admin.connect();
    if ((await admin.query("select 1 from pg_database where datname = $1", [into])).rowCount) throw new Error(`${into} exists: a restore never overwrites a database.`);
    await admin.query(`create database "${into}"`);
    await admin.end();
    tool("pg_restore", ["--exit-on-error", "--no-owner", "-d", into], path.resolve(v.file!));
    console.log(JSON.stringify({ restored: into, sha256: sha }));
  } else if (cmd === "verify") {
    const [a, b] = [await fingerprint(v.a!), await fingerprint(v.b!)];
    const differing = Object.keys({ ...a.rows, ...b.rows }).filter((k) => a.rows[k] !== b.rows[k]);
    const same = (k: keyof typeof a) => JSON.stringify(a[k]) === JSON.stringify(b[k]);
    const { db, pool } = connect(urlOf(v.b!), { max: 2 });
    const broken = [];
    for (const d of b.documents) { const r = await integrity(db, d); if (Object.values(r).some((n) => n > 0)) broken.push({ document: d, ...r }); }
    await pool.end();
    console.log(JSON.stringify({ tables: Object.keys(b.rows).length, tablesDiffering: differing, triggers: [a.triggers, b.triggers], functions: same("functions"), constraints: b.constraints, ledger: same("ledger") ? b.ledger.length : "differs", epochs: same("epochs") ? b.epochs : "differs", quarantine: same("quarantine") ? b.quarantine : "differs", reviews: same("reviews") ? b.reviews : "differs", documentsChecked: b.documents.length, brokenReferences: broken }, null, 1));
  } else throw new Error("usage: db-snapshot.ts dump|restore|verify");
}
main().catch((e) => { console.error(String(e).replace(/PGPASSWORD=\S+/g, "PGPASSWORD=***")); process.exit(1); });
