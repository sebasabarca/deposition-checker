// Rehearses the evidence correction (server/src/evidence/correction.ts) on a DISPOSABLE copy of a database. No
// model call. Every command refuses a database whose name lacks "_rehearsal_" (or names a batch database), so it
// can never touch a working one; `create` copies a working database as a template and never writes to it.
//
//   npx tsx scripts/evidence-rehearsal.ts create --template deposition_checker --name deposition_checker_rehearsal_x
//     Copies the database, then applies this branch's migrations to the copy (0039: ledger, quarantine, guards).
//   npx tsx scripts/evidence-rehearsal.ts splits --db <copy> --uploads <dir> --backup data/raw/<dir> --out data/raw/<file>.json
//     For every document holding a confirmed bare-Q line (tests/fixtures/segments-v2-confirmed.json): interruption
//     and recovery, worker coordination, dry run, execute, the split checks, idempotence, rollback, and execute again.
//   npx tsx scripts/evidence-rehearsal.ts findings --db <copy> --uploads <dir> --backup data/raw/<dir> --out data/raw/<file>.json
//     Every document with findings: what correcting it would do, and the quarantine policy for its category.
//   npx tsx scripts/evidence-rehearsal.ts drop --name <copy>

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { analysisFindings } from "../server/src/api/analyses";
import { connect, type Database } from "../server/src/db/client";
import { verdicts } from "../server/src/db/schema";
import { applyCorrection, documentHash, heldDocuments, integrity, isEvidenceOnHold, parserAudit, planCorrection, quarantineFindings, releaseHold, rollbackCorrection, standingOf, verdictNotQuarantined } from "../server/src/evidence";

const urlOf = (db: string) => { const u = new URL(process.env.DATABASE_URL!); u.pathname = `/${db}`; return u.toString(); };
const disposable = (db: string) => { if (!/_rehearsal_/.test(db) || /_batch_/.test(db)) throw new Error(`${db} is not a disposable rehearsal database`); return db; };
const underRaw = (p: string) => { const r = path.resolve(p); if (!r.startsWith(path.resolve("data/raw") + path.sep)) throw new Error(`${p}: rehearsal output holds testimony; write it under data/raw/`); return r; };
type Fixture = { witness: string; fileSha256: string; ref: string };
const FIXTURE = (JSON.parse(readFileSync("tests/fixtures/segments-v2-confirmed.json", "utf8")) as { cases: Fixture[] }).cases;

// Row count and content hash of every table, to compare whole databases.
async function fingerprint(c: pg.Client) {
  const tables = (await c.query("select tablename from pg_tables where schemaname = 'public' order by 1")).rows.map((r) => r.tablename as string);
  const out: Record<string, string> = {};
  for (const t of tables) { const r = (await c.query(`select count(*)::int n, md5(coalesce(string_agg(md5(x::text), '' order by md5(x::text)), '')) h from "${t}" x`)).rows[0]; out[t] = `${r.n}:${r.h}`; }
  return out;
}
const differing = (a: Record<string, string>, b: Record<string, string>) => Object.keys({ ...a, ...b }).filter((k) => a[k] !== b[k]);

// The split checks on one corrected document: for each expected line, its bare-Q turn is the attorney's, owned
// by exactly one exchange as its question, and that exchange holds its answer (after any colloquy); no line's turn is
// left in no exchange or shown by two groups.
async function splitChecks(c: pg.Client, dep: number, refs: string[]) {
  const per = [];
  for (const ref of refs) {
    const [page, line] = ref.split(":").map(Number);
    const segs = (await c.query(`select s.seq, s.speaker_role role, substr(l.raw_text, s.start_offset + 1, s.end_offset - s.start_offset) text, l.id line_id
      from line_segments s join lines l on l.id = s.line_id where l.deposition_id = $1 and l.printed_page = $2 and l.line_no = $3 order by s.seq`, [dep, page, line])).rows;
    const bareQ = segs.find((s) => /^Q\s+[A-Z]/.test(s.text));
    const owners = bareQ ? (await c.query(`select x.exchange_id, x.role, e.group_id from exchange_lines x join exchanges e on e.id = x.exchange_id where x.line_id = $1 and $2 between x.segment_from and x.segment_to`, [bareQ.line_id, bareQ.seq])).rows : [];
    const groups = new Set(owners.map((o) => o.group_id));
    // The answer to it: the first line after it in its exchange that isn't colloquy (an objection may come between).
    const next = owners.length ? (await c.query(`select x.role from exchange_lines x join lines l on l.id = x.line_id where x.exchange_id = $1 and l.deposition_id = $2 and l.id > $3 and x.role <> 'context' order by l.id limit 1`, [owners[0].exchange_id, dep, bareQ.line_id])).rows[0] : null;
    per.push({ ref, segments: segs.length, bareQRole: bareQ?.role ?? null, ownedByGroups: groups.size, ownerRoles: [...new Set(owners.map((o) => o.role))], answeredInSameExchange: next?.role ?? null,
      ok: segs.length >= 2 && bareQ?.role === "attorney" && groups.size === 1 && owners.every((o) => o.role === "question") && next?.role === "answer" });
  }
  const [orphans] = (await c.query(`select count(*)::int n from line_segments s where s.deposition_id = $1 and not exists (select 1 from exchange_lines x where x.line_id = s.line_id and (x.segment_from is null or s.seq between x.segment_from and x.segment_to))`, [dep])).rows;
  return { lines: per, allOk: per.every((p) => p.ok), turnsInNoExchange: orphans.n };
}

async function splits(db: Database, c: pg.Client, uploadsDir: string, backupDir: string) {
  const startPrint = await fingerprint(c);
  const docs = (await c.query("select d.id, d.file_sha256 sha, d.parser_version parser, w.name witness from depositions d join witnesses w on w.id = d.witness_id where d.file_sha256 = any($1) order by d.id", [[...new Set(FIXTURE.map((f) => f.fileSha256))]])).rows;
  const out = [];
  for (const d of docs) {
    const dep = Number(d.id);
    const expect = { lines: FIXTURE.filter((f) => f.fileSha256 === d.sha).map((f) => f.ref) };
    const o = { uploadsDir, backupDir, expect };
    const r: Record<string, unknown> = { documentId: dep, witness: d.witness, fromParser: d.parser, expectedLines: expect.lines };
    const before = await documentHash(db, dep);
    const turnsBefore = (await splitChecks(c, dep, [])).turnsInNoExchange;
    r.integrityBefore = await integrity(db, dep);
    // Unexpected differences are rejected: an expectation missing one line.
    r.missingLineRejected = (await planCorrection(db, dep, { ...o, expect: { lines: expect.lines.slice(1) } })).outcome;
    const dry = await planCorrection(db, dep, o);
    r.dryRun = { outcome: dry.outcome, detail: dry.detail?.slice(0, 300), plan: dry.plan && { ...dry.plan, exchanges: { ...dry.plan.exchanges, removed: dry.plan.exchanges.removed.length, added: dry.plan.exchanges.added.length } }, unchanged: (await documentHash(db, dep)) === before };
    if (dry.outcome !== "dry_run") { out.push(r); continue; }
    // Interruption: a failure inside the transaction changes nothing and releases the hold.
    const failure = await applyCorrection(db, dep, { ...o, planHash: dry.planHash, failAfter: "quarantine" }).then((x) => x.outcome, (e) => String(e).slice(0, 80));
    r.failureInsideTransaction = { error: failure, unchanged: (await documentHash(db, dep)) === before, held: (await heldDocuments(db, [dep])).length > 0 };
    // Interruption after the hold (the process died): workers refused, explicit recovery.
    await applyCorrection(db, dep, { ...o, planHash: dry.planHash, failAfter: "hold" }).catch(() => undefined);
    const [held] = await heldDocuments(db, [dep]);
    const write = await db.execute(sql`update exchanges set flags = flags where deposition_id = ${dep}`).then(() => "accepted", (e) => (isEvidenceOnHold(e) ? "refused (VE001)" : String(e)));
    const replanned = (await planCorrection(db, dep, o)).outcome;
    await releaseHold(db, held.hold!);
    r.interruptedAfterHold = { heldBy: held.hold, workerWrite: write, dryRunWhileHeld: replanned, released: (await heldDocuments(db, [dep])).length === 0, unchanged: (await documentHash(db, dep)) === before };
    // Worker coordination: an unfinished analysis of the case refuses the hold.
    const [{ id: blocker }] = (await c.query("insert into analyses (case_id, witness_id, deposition_a, deposition_b, mode, prompt_version, effort, max_candidates, budget_usd) select d.case_id, d.witness_id, d.id, (select id from depositions x where x.case_id = d.case_id and x.id <> d.id limit 1), 'demo', 'adjudicate-v1', 'medium', 1, 0 from depositions d where d.id = $1 returning id", [dep])).rows;
    r.holdWithUnfinishedAnalysis = (await applyCorrection(db, dep, { ...o, planHash: dry.planHash })).outcome;
    await c.query("delete from analyses where id = $1", [blocker]);
    // Execute.
    const applied = await applyCorrection(db, dep, { ...o, planHash: dry.planHash });
    r.applied = { outcome: applied.outcome, migrationId: applied.migrationId, integrityAfter: applied.integrityAfter };
    r.splitChecks = await splitChecks(c, dep, expect.lines);
    r.turnsInNoExchange = { before: turnsBefore, after: (r.splitChecks as { turnsInNoExchange: number }).turnsInNoExchange };
    r.integrityNow = await integrity(db, dep);
    // Idempotence.
    r.duplicate = (await applyCorrection(db, dep, { ...o, planHash: dry.planHash })).outcome;
    const again = await planCorrection(db, dep, { uploadsDir, backupDir });
    r.freshDryRun = { outcome: again.outcome, changedLines: again.plan?.changedLines.length, removed: again.plan?.exchanges.removed.length, added: again.plan?.exchanges.added.length, rekeyed: again.plan?.units.rekeyed, quarantined: again.plan?.quarantine.findings.length };
    // Rollback, exact; then execute again (the corrected state is what production would keep).
    const after = await documentHash(db, dep);
    await rollbackCorrection(db, applied.migrationId!);
    r.rollbackExact = (await documentHash(db, dep)) === before;
    const redo = await planCorrection(db, dep, o);
    const reapplied = await applyCorrection(db, dep, { ...o, planHash: redo.planHash });
    r.reapplied = { outcome: reapplied.outcome, samePlan: redo.planHash === dry.planHash, sameResult: (await documentHash(db, dep)) === after };
    out.push(r);
    console.log(dep, JSON.stringify({ dry: dry.outcome, applied: applied.outcome, splitsOk: (r.splitChecks as { allOk: boolean }).allOk, duplicate: r.duplicate, rollbackExact: r.rollbackExact, reapplied: reapplied.outcome }));
  }
  // Only the corrected documents' evidence changed (plus the ledger and quarantine tables).
  const changed = differing(startPrint, await fingerprint(c));
  return { documents: out, tablesChanged: changed };
}

const CATEGORY = (r: { outcome: string; detail?: string }) =>
  r.outcome === "dry_run" ? "correctable in place" : /isn't available/.test(r.detail ?? "") ? "stored file missing" : /text or position/.test(r.detail ?? "") ? "source text changes" : /refer to would change/.test(r.detail ?? "") ? "referenced exchanges change" : r.outcome;

async function findings(db: Database, c: pg.Client, uploadsDir: string, backupDir: string) {
  const audit = await parserAudit(db);
  const docs = (await c.query(`select d.id::int dep, d.parser_version parser, d.excluded_reason excluded, ca.name case_name, w.name witness, count(distinct f.id)::int findings,
      count(distinct f.id) filter (where f.review_state <> 'unreviewed')::int reviewed, array_agg(distinct f.id) ids
    from depositions d join cases ca on ca.id = d.case_id join witnesses w on w.id = d.witness_id join candidates c on c.deposition_a = d.id or c.deposition_b = d.id join findings f on f.candidate_id = c.id
    group by 1, 2, 3, 4, 5 order by 1`)).rows as { dep: number; parser: string; excluded: string | null; case_name: string; witness: string; findings: number; reviewed: number; ids: number[] }[];
  const reviewsBefore = new Map((await c.query("select id::int, review_state, review_note, reviewed_at from findings")).rows.map((f) => [f.id, JSON.stringify(f)]));
  type Row = Omit<(typeof docs)[number], "ids"> & { current: boolean | undefined; category: string; detail: string | undefined; wouldQuarantine: number | null; requiresReview: number[] };
  const rows: Row[] = [];
  for (const d of docs) {
    const dry = await planCorrection(db, d.dep, { uploadsDir, backupDir }).catch((e) => ({ outcome: "error", detail: String(e).slice(0, 200), plan: undefined, correction: undefined }));
    const requiresReview = ((dry.correction as { findings?: { requiresReview?: { findingId: number }[] } } | undefined)?.findings?.requiresReview ?? []).map((x) => x.findingId);
    rows.push({ dep: d.dep, parser: d.parser, excluded: d.excluded, case_name: d.case_name, witness: d.witness, findings: d.findings, reviewed: d.reviewed, current: audit.find((a) => a.documentId === d.dep)?.current, category: CATEGORY(dry), detail: dry.detail?.slice(0, 200), wouldQuarantine: dry.plan?.quarantine.findings.length ?? null, requiresReview });
  }
  // The policies, applied automatically where they can be.
  const policy = (r: Row) =>
    r.excluded === "legacy_parse" ? "quarantine all: superseded parse"
    : r.category === "source text changes" ? "quarantine all: the current parser reads different text; revalidate after a versioned re-read"
    : r.category === "referenced exchanges change" ? "quarantine all: findings sit on exchanges a correction must replace; revalidate after a versioned re-read"
    : r.category === "stored file missing" ? "cannot be applied automatically: the file can't be re-read (labelled, kept)"
    : r.category === "correctable in place" ? (r.wouldQuarantine ? "correct in place: the correction quarantines its own" : "none: correcting changes nothing these findings rely on")
    : "investigate";
  const applied = [];
  for (const r of rows) {
    const p = policy(r);
    if (p.startsWith("quarantine all")) applied.push({ dep: r.dep, policy: p, ...(await quarantineFindings(db, r.dep, p.replace(/^quarantine all: /, ""))) });
  }
  // What the policies did: every quarantined finding keeps its review, its verdict is never replayed, and the
  // findings API shows it in its own group.
  const all = (await c.query("select id::int from findings")).rows.map((x) => x.id as number);
  const standing = await standingOf(db, all);
  const quarantined = all.filter((id) => standing.get(id)!.state === "quarantined");
  const reviewsKept = (await c.query("select id::int, review_state, review_note, reviewed_at from findings")).rows.every((f) => reviewsBefore.get(f.id) === JSON.stringify(f));
  const confirmedQuarantined = (await c.query("select count(*)::int n from findings where review_state = 'confirmed' and id = any($1)", [quarantined])).rows[0].n;
  const replayable = (await db.select({ id: verdicts.id }).from(verdicts).where(verdictNotQuarantined(verdicts.id))).length;
  const quarantinedVerdicts = (await c.query("select count(distinct q.row_id)::int n from evidence_quarantine q join evidence_migrations m on m.id = q.migration_id where q.kind = 'verdict' and m.status = 'applied'")).rows[0].n;
  const analysesWith = (await c.query("select distinct c.job_id::int a from candidates c join findings f on f.candidate_id = c.id where f.id = any($1) and c.job_id is not null", [quarantined])).rows.map((x) => x.a as number);
  let shownInQuarantineGroup = 0;
  for (const a of analysesWith) shownInQuarantineGroup += (await analysisFindings(db, a)).groups.find((g) => g.group === "quarantined")!.findings.length;
  return {
    documents: rows, applied,
    summary: { findings: all.length, quarantined: quarantined.length, confirmedQuarantined, reviewsUnchanged: reviewsKept, verdictsQuarantined: quarantinedVerdicts, verdictsReplayable: replayable, shownInQuarantineGroup, analysesChecked: analysesWith.length },
  };
}

async function main() {
  const [cmd] = process.argv.slice(2);
  const { values: v } = parseArgs({ args: process.argv.slice(3), options: { template: { type: "string" }, name: { type: "string" }, db: { type: "string" }, uploads: { type: "string" }, backup: { type: "string" }, out: { type: "string" } } });
  if (cmd === "create" || cmd === "drop") {
    const admin = new pg.Client({ connectionString: urlOf("postgres") });
    await admin.connect();
    if (cmd === "create") {
      if (/_rehearsal_/.test(v.template!)) throw new Error("the template must be a working database");
      await admin.query(`create database "${disposable(v.name!)}" template "${v.template}"`);
      const { db, pool } = connect(urlOf(v.name!), { max: 1 });
      await migrate(db, { migrationsFolder: "drizzle" });
      await pool.end();
      console.log(`created ${v.name} from ${v.template}, migrated`);
    } else {
      await admin.query(`drop database if exists "${disposable(v.name!)}"`);
      console.log(`dropped ${v.name}`);
    }
    await admin.end();
    return;
  }
  const name = disposable(v.db!);
  const c = new pg.Client({ connectionString: urlOf(name) });
  await c.connect();
  const { db, pool } = connect(urlOf(name), { max: 4 });
  const backupDir = underRaw(v.backup!);
  mkdirSync(backupDir, { recursive: true });
  const result = cmd === "splits" ? await splits(db, c, v.uploads!, backupDir) : cmd === "findings" ? await findings(db, c, v.uploads!, backupDir) : null;
  if (!result) throw new Error("usage: evidence-rehearsal.ts create|splits|findings|drop");
  writeFileSync(underRaw(v.out!), JSON.stringify({ database: name, command: cmd, ...result }, null, 1));
  await pool.end();
  await c.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
