// Benchmarks migration 0039's guards on DISPOSABLE databases (names must contain "_rehearsal_"). No model call.
// Run the same workload on two fresh databases migrated to 0039, one with the guard triggers dropped ("before"),
// so the only difference is the guards; then the correction itself on a copy of a working database.
//
//   npx tsx scripts/evidence-bench.ts write --db <x_rehearsal_y> [--without-guards] --out data/raw/<file>.json
//   npx tsx scripts/evidence-bench.ts correct --db <copy of a working db, _rehearsal_> --document-id <id> --uploads <dir> --out data/raw/<file>.json

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { syncUnits } from "../server/src/claims/facts/store";
import { connect, type Database } from "../server/src/db/client";
import { candidates, cases, exchanges, findings, orgs, verdicts, witnesses } from "../server/src/db/schema";
import { applyCorrection, captureEpochs, correctInPlace, planCorrection, rollbackCorrection, withEvidenceFence } from "../server/src/evidence";
import { readDeposition, saveDeposition } from "../server/src/ingest";
import { storeUpload } from "../server/src/ingest/uploads";

const urlOf = (db: string) => { const u = new URL(process.env.DATABASE_URL!); u.pathname = `/${db}`; return u.toString(); };
const disposable = (db: string) => { if (!/_rehearsal_/.test(db) || /_batch_/.test(db)) throw new Error(`${db} is not a disposable rehearsal database`); return db; };
const FILE = "data/raw/simpson/o_j_simpson_january_23_1996_day_2.txt";
const ms = (t: bigint) => Number(process.hrtime.bigint() - t) / 1e6;
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return Number(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(2)); };
async function timed<T>(fn: () => Promise<T>) { const t = process.hrtime.bigint(); const r = await fn(); return { r, ms: Number(ms(t).toFixed(1)) }; }

// Samples, every 20 ms while fn runs, how many sessions wait on a lock.
async function withLockSampling<T>(c: pg.Client, fn: () => Promise<T>) {
  let running = true;
  const samples: number[] = [];
  const sampler = (async () => { while (running) { samples.push(Number((await c.query("select count(*)::int n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()")).rows[0].n)); await new Promise((r) => setTimeout(r, 20)); } })();
  try { return { r: await fn(), lockWaits: { samples: samples.length, withWaiters: samples.filter((n) => n > 0).length, maxWaiting: Math.max(0, ...samples) } }; } finally { running = false; await sampler; }
}

async function writes(db: Database, c: pg.Client, guards: boolean) {
  if (!guards) await c.query(`do $$ declare t record; begin for t in select tgname, tgrelid::regclass r from pg_trigger where tgname like '%evidence_guard%' loop execute format('drop trigger %I on %s', t.tgname, t.r); end loop; end $$`);
  const triggers = Number((await c.query("select count(*)::int n from pg_trigger where tgname like '%evidence_guard%'")).rows[0].n);
  const data = new Uint8Array(readFileSync(FILE));
  const read = await readDeposition(data, undefined, undefined, "O.J. Simpson");
  const uploads = path.resolve("data/raw/bench-uploads");
  const { fileSha256, storageKey } = await storeUpload(data, uploads);
  const [org] = await db.insert(orgs).values({ name: "Bench" }).returning();
  const out: Record<string, unknown> = { guards, triggers, lines: read.exchanges!.lines.length, exchanges: read.exchanges!.parts.length };

  // 1. Bulk transcript ingestion: the same parsed file saved 3 times, each in its own case.
  const ingest: number[] = [];
  let dep = 0;
  for (let i = 0; i < 3; i++) {
    const [k] = await db.insert(cases).values({ orgId: org.id, name: `Bench ${i}` }).returning();
    const [w] = await db.insert(witnesses).values({ caseId: k.id, name: "O.J. Simpson" }).returning();
    const t = await timed(() => saveDeposition(db, { caseId: k.id, witnessId: w.id, takenOn: "1996-01-23", fileSha256, storageKey, read }));
    ingest.push(t.ms);
    if ("depositionId" in t.r) dep = t.r.depositionId;
  }
  out.ingestion = { runsMs: ingest, medianMs: pct(ingest, 50), linesPerSecond: Math.round((read.exchanges!.lines.length / pct(ingest, 50)) * 1000) };

  // 2. Fact units: the sync's inserts, then 1,000 single-unit updates as extraction makes them.
  const sync = await timed(() => syncUnits(db, dep));
  const keys = (await c.query("select unit_key from fact_units where deposition_id = $1 limit 1000", [dep])).rows.map((r) => r.unit_key as string);
  const lat: number[] = [];
  const upd = await timed(async () => { for (const k of keys) { const t = process.hrtime.bigint(); await c.query("update fact_units set attempts = attempts + 1 where unit_key = $1", [k]); lat.push(ms(t)); } });
  out.factUnits = { inserted: sync.r.units.length, syncMs: sync.ms, updates: keys.length, updatesMs: upd.ms, updateP50Ms: pct(lat, 50), updateP95Ms: pct(lat, 95) };

  // 3. Candidates, verdicts and findings in batches of 500 (5,000 each).
  const parts = await db.select({ id: exchanges.id, g: exchanges.groupId }).from(exchanges).where(eq(exchanges.depositionId, dep)).orderBy(exchanges.groupId);
  const [k] = await c.query("select case_id, witness_id from depositions where id = $1", [dep]).then((r) => r.rows);
  const pairs = Array.from({ length: 5000 }, (_, i) => [parts[i % 100], parts[100 + i]] as const).filter(([a, b]) => a && b && a.g < b.g);
  const rows = pairs.map(([a, b], i) => ({ candidateSet: `bench-${i % 10}`, witnessId: Number(k.witness_id), depositionA: dep, groupA: a.g, depositionB: dep, groupB: b.g, exchangeA: a.id, exchangeB: b.id, sources: ["direct"], rrfScore: 0, mergedRank: i, evidence: [] }));
  const cand = await timed(async () => { const ids: number[] = []; for (let i = 0; i < rows.length; i += 500) ids.push(...(await db.insert(candidates).values(rows.slice(i, i + 500)).returning({ id: candidates.id })).map((r) => r.id)); return ids; });
  const verd = await timed(async () => { const ids: number[] = []; for (let i = 0; i < cand.r.length; i += 500) ids.push(...(await db.insert(verdicts).values(cand.r.slice(i, i + 500).map((id) => ({ candidateId: id, model: "fixture", promptVersion: "x", effort: "low", status: "valid" as const, parsed: {}, packet: {}, origin: "fixture" }))).returning({ id: verdicts.id })).map((r) => r.id)); return ids; });
  const find = await timed(async () => { for (let i = 0; i < verd.r.length; i += 500) await db.insert(findings).values(verd.r.slice(i, i + 500).map((v, j) => ({ caseId: Number(k.case_id), candidateId: cand.r[i + j], verdictId: v, type: "direct", evidenceStatus: "verified", attributionA: "clear", attributionB: "clear", factors: [], caps: [], checks: {}, rubricVersion: "x", priority: "high" }))); });
  const perSec = (n: number, t: number) => Math.round((n / t) * 1000);
  out.persistence = { rows: rows.length, candidatesMs: cand.ms, verdictsMs: verd.ms, findingsMs: find.ms, candidatesPerSecond: perSec(rows.length, cand.ms), verdictsPerSecond: perSec(rows.length, verd.ms), findingsPerSecond: perSec(rows.length, find.ms) };

  // 4. Concurrent background writes: 8 workers, 200 single-row inserts each, into the same deposition.
  const concurrent = async (label: string, through: (f: (on: Database) => Promise<void>) => Promise<void>) => {
    const lat: number[] = [];
    const run = await withLockSampling(c, () => timed(() => Promise.all(Array.from({ length: 8 }, (_, w) => through(async (on) => {
      for (let i = 0; i < 200; i++) { const t = process.hrtime.bigint(); await on.insert(candidates).values({ ...rows[i], candidateSet: `${label}-${w}-${i}` }); lat.push(ms(t)); }
    })))));
    return { inserts: lat.length, totalMs: run.r.ms, perSecond: perSec(lat.length, run.r.ms), p50Ms: pct(lat, 50), p95Ms: pct(lat, 95), p99Ms: pct(lat, 99), lockWaits: run.lockWaits };
  };
  out.concurrent = await concurrent("plain", (f) => f(db));
  // The same through job connections that declare evidence epochs (the epoch check runs too).
  if (guards) { const epochs = await captureEpochs(db, [dep]); out.concurrentFenced = await concurrent("fenced", (f) => withEvidenceFence(db, epochs, f)); }
  return out;
}

async function correction(db: Database, dep: number, uploadsDir: string) {
  const backupDir = path.resolve("data/raw/bench-backups");
  const old = await timed(() => correctInPlace(db, dep, { uploadsDir, backupDir })); // the dry run production had
  const dry = await timed(() => planCorrection(db, dep, { uploadsDir, backupDir }));
  const expect = { lines: dry.r.plan!.changedLines };
  const plan = await timed(() => planCorrection(db, dep, { uploadsDir, backupDir, expect }));
  const apply = await timed(() => applyCorrection(db, dep, { uploadsDir, backupDir, expect, planHash: plan.r.planHash }));
  const back = await timed(() => rollbackCorrection(db, apply.r.migrationId!));
  const oldExec = await timed(() => correctInPlace(db, dep, { uploadsDir, backupDir, execute: true })); // the unsafe execute, for comparison
  return { documentId: dep, correctInPlaceDryRunMs: old.ms, correctInPlaceExecuteMs: oldExec.ms, safeDryRunMs: plan.ms, safeApplyMs: apply.ms, rollbackMs: back.ms, applied: apply.r.outcome, plan: { changedLines: expect.lines.length, removed: plan.r.plan!.exchanges.removed.length, rekeyed: plan.r.plan!.units.rekeyed } };
}

async function main() {
  const [cmd] = process.argv.slice(2);
  const { values: v } = parseArgs({ args: process.argv.slice(3), options: { db: { type: "string" }, "without-guards": { type: "boolean" }, "document-id": { type: "string" }, uploads: { type: "string" }, out: { type: "string" }, fresh: { type: "boolean" } } });
  const name = disposable(v.db!);
  const out = path.resolve(v.out!);
  if (!out.startsWith(path.resolve("data/raw") + path.sep)) throw new Error("write results under data/raw/");
  const c = new pg.Client({ connectionString: urlOf(name) });
  await c.connect();
  const { db, pool } = connect(urlOf(name), { max: 12 });
  if (v.fresh) await migrate(db, { migrationsFolder: "drizzle" });
  const r = cmd === "write" ? await writes(db, c, !v["without-guards"]) : cmd === "correct" ? await correction(db, Number(v["document-id"]), v.uploads!) : null;
  if (!r) throw new Error("usage: evidence-bench.ts write|correct");
  writeFileSync(out, JSON.stringify({ database: name, command: cmd, at: new Date().toISOString(), ...r }, null, 1));
  console.log(JSON.stringify(r));
  await pool.end();
  await c.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
