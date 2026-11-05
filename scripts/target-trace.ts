// Where each known contradiction is lost between stored testimony and what the model is shown, on production's
// whole-case pipeline (retrieve/casePool.ts buildCasePool, as a case run calls it). No model call, writes nothing.
//
//   npx tsx scripts/target-trace.ts --db <a _rehearsal_ or _test database> [--json <out file under data/raw/>] [--pads 0,2,4,6]
//
// --pads: an offline prototype. For each stretch padding (eligible items added on each side of every stretch,
// retrieve/stretchSet.ts pad), whether the target's decisive lines fall in an item of the target's own unit (so a
// stretch-v2 request would show them as citable testimony), and the case's stretch requests, input tokens and
// projected cost at that padding. Retrieval is unchanged; only what each request shows grows.
//
// Stages, for each target side pair, with MiniLM off (the case-run default) and on (local model files):
//   1. eligible   each side's lines fall in an eligible answer group (an item), or which exclusion took them
//   2. pool       the pair is in the fused candidate pool at the default per-item cut (5); if not, the smallest
//                 cut that admits it (ranking loss)
//   3. triage     kept, or deferred with its stage and reason
//   4. request    the packet-v1 issue packet or the stretch-v2 request holding it, or why none does
//   5. shown      whether the decisive lines (when the target names them) are in what that request shows: as
//                 citable exchange lines, as context only, or not at all
// Targets: experiments/candidate-reduction/fixtures/known-targets-v1.json (branch experiment/candidate-reduction,
// 31590cd), by session date and page:line; the limo/SUV decisive lines are the September 34:19-34:24 ("the Beast
// or the Presidential SUV") that its verify-v1 design names. Copied here, not edited there.

import "dotenv/config";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { buildIssuePacket, resolvePassages } from "../server/src/adjudicate/packetLoad";
import type { IssuePacket } from "../server/src/adjudicate/packetPrompt";
import { connect } from "../server/src/db/client";
import { depositions, exchangeLines, exchanges, lines, witnesses } from "../server/src/db/schema";
import { buildCasePool, type CaseItem, type CasePoolResult } from "../server/src/retrieve/casePool";
import { PACKET_LIMITS, splitPacketSet } from "../server/src/retrieve/packetSplit";
import { buildStretchSet, buildUnits, STRETCH_SETTINGS } from "../server/src/retrieve/stretchSet";
import { INSTRUCTION_TOKENS } from "../server/src/retrieve/grouping";
import { projectCost, STRETCH_COST_ASSUMPTIONS } from "../server/src/eval/screeningBenchmark";
import { BATCH_MULTIPLIER } from "../server/src/costs/pricing";

type Range = { witness: string; takenOn: string; from: string; to: string };
type Target = { id: string; caseName: string; sides: { a: Range; b: Range }[]; decisive?: Range[] };
const r = (witness: string, takenOn: string, span: string): Range => { const [from, to] = span.split("-"); return { witness, takenOn, from, to }; };
const SIMPSON = "O.J. Simpson", RESNICK = "Faye Resnick", HUTCHINSON = "Cassidy Hutchinson";
export const TARGETS: Target[] = [
  { id: "limo-suv", caseName: "Cassidy Hutchinson", sides: [{ a: r(HUTCHINSON, "2022-06-20", "5:6-6:14"), b: r(HUTCHINSON, "2022-09-15", "33:6-33:13") }], decisive: [r(HUTCHINSON, "2022-09-15", "34:19-34:24")] },
  // A probe, not a label: the June answer against the September answer holding the decisive words, as a pair.
  { id: "limo-suv probe: decisive answer as a side", caseName: "Cassidy Hutchinson", sides: [{ a: r(HUTCHINSON, "2022-06-20", "5:6-6:14"), b: r(HUTCHINSON, "2022-09-15", "34:18-35:12") }] },
  { id: "C01", caseName: "Simpson-Resnick (Stage 2 pilot)", sides: [{ a: r(SIMPSON, "1996-01-23", "1:560-1:561"), b: r(RESNICK, "1996-02-11", "0:781-0:782") }, { a: r(SIMPSON, "1996-01-23", "1:562-1:563"), b: r(RESNICK, "1996-02-11", "0:781-0:782") }], decisive: [r(SIMPSON, "1996-01-23", "1:562-1:563")] },
  { id: "C02", caseName: "Simpson-Resnick (Stage 2 pilot)", sides: [{ a: r(SIMPSON, "1996-01-23", "1:587-1:588"), b: r(RESNICK, "1996-02-11", "0:802-0:803") }, { a: r(SIMPSON, "1996-01-23", "1:589-1:590"), b: r(RESNICK, "1996-02-11", "0:802-0:803") }] },
];
const CUTS = [7, 10, 15, 25, 50];

const pos = (p: string) => { const [pg, ln] = p.split(":").map(Number); return pg * 100000 + ln; };
const inRange = (p: string, x: Range) => pos(p) >= pos(x.from) && pos(p) <= pos(x.to);
const pk = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

async function main() {
  const { values } = parseArgs({ options: { db: { type: "string" }, json: { type: "string" }, pads: { type: "string" } } });
  const pads = values.pads ? values.pads.split(",").map(Number) : [];
  if (!values.db || !/_rehearsal_|_test$/.test(values.db)) throw new Error("--db must name a disposable database (_rehearsal_ or _test): the trace never reads the working database");
  const u = new URL(process.env.DATABASE_URL!); u.pathname = `/${values.db}`;
  const { db, pool } = connect(u.toString(), { max: 4 });
  const out: unknown[] = [];
  try {
    for (const t of TARGETS) {
      const [kase] = await db.execute<{ id: number }>(sql`select id from cases where name = ${t.caseName} order by id desc limit 1`).then((x) => x.rows);
      if (!kase) { out.push({ target: t.id, problem: `case "${t.caseName}" not in ${values.db}` }); continue; }
      const docOf = async (x: Range) => (await db.select({ id: depositions.id }).from(depositions).innerJoin(witnesses, eq(witnesses.id, depositions.witnessId))
        .where(and(eq(depositions.caseId, Number(kase.id)), eq(witnesses.name, x.witness), eq(depositions.takenOn, x.takenOn), isNull(depositions.excludedReason))).orderBy(asc(depositions.id)))[0]?.id ?? null;
      for (const minilm of ["off", "auto"] as const) {
        const built = await buildCasePool(db, pool, Number(kase.id), { minilm });
        const minilmUsed = built.paths.some((p) => p.name.includes("minilm") && p.available);
        const sides = await Promise.all(t.sides.map(async (s) => ({ a: await locate(s.a, built, await docOf(s.a)), b: await locate(s.b, built, await docOf(s.b)) })));
        const packetSet = splitPacketSet(built.packets, built.items, PACKET_LIMITS);
        const stretchSet = buildStretchSet(built.triage.kept, built.items);
        const rows = [];
        for (const s of sides) {
          const row: Record<string, unknown> = { a: s.a, b: s.b };
          rows.push(row);
          if (!s.a.keys.length || !s.b.keys.length) { row.lostAt = "eligibility"; continue; }
          // Any item of side a with any item of side b (a range may span two answer groups).
          const combos = s.a.keys.flatMap((ka) => s.b.keys.map((kb) => [ka, kb] as [string, string]));
          const rank = built.pool.candidates.findIndex((c) => combos.some(([x, y]) => pk(c.a, c.b) === pk(x, y)));
          if (rank < 0) {
            let admittedAt: number | null = null;
            for (const cut of CUTS) {
              const wider = await buildCasePool(db, pool, Number(kase.id), { minilm, perItem: cut });
              if (wider.pool.candidates.some((c) => combos.some(([x, y]) => pk(c.a, c.b) === pk(x, y)))) { admittedAt = cut; break; }
            }
            Object.assign(row, { lostAt: "pool (per-item fused cut)", poolPairs: built.pool.candidates.length, admittedAtPerItemCut: admittedAt ?? `> ${CUTS.at(-1)}` });
            continue;
          }
          const c = built.pool.candidates[rank];
          row.pool = { mergedRank: rank + 1, of: built.pool.candidates.length, fused: Number(c.fused.toFixed(4)), paths: Object.fromEntries(Object.entries(c.ranks).filter(([, v]) => v[0] !== null || v[1] !== null)) };
          const deferred = built.triage.deferred.find((d) => pk(d.a, d.b) === pk(c.a, c.b));
          if (deferred) { Object.assign(row, { lostAt: "triage", triage: deferred }); continue; }
          row.triage = "kept";
          const packet = packetSet.packets.find((p) => p.pairs.some(([x, y]) => pk(x, y) === pk(c.a, c.b)));
          const uncovered = packetSet.uncovered.find((x) => pk(x.a, x.b) === pk(c.a, c.b));
          const stretch = stretchSet.packets.find((p) => p.pairs.some(([x, y]) => pk(x, y) === pk(c.a, c.b)));
          row.packetV1 = packet ? { packet: packet.id, items: packet.items.length, pairs: packet.pairs.length, shown: t.decisive ? await shown(db, built, packet.items, packet.pairs, false, t.decisive) : null } : { uncovered: uncovered?.reason ?? "not found" };
          row.stretchV2 = stretch ? { request: stretch.id, items: stretch.items.length, pairs: stretch.pairs.length, shown: t.decisive ? await shown(db, built, stretch.items, stretch.pairs, true, t.decisive) : null } : { uncovered: "not found" };
          row.lostAt = null;
        }
        const padding = pads.map((pad) => {
          const set = buildStretchSet(built.triage.kept, built.items, { ...STRETCH_SETTINGS, pad });
          const sized = set.packets.map((p) => ({ passageTokens: p.inputTokens - INSTRUCTION_TOKENS, pairs: p.pairs.length }));
          const at = new Map(built.items.map((i) => [i.key, i]));
          const units = buildUnits(built.triage.kept, at, STRETCH_SETTINGS.gap, pad);
          // The decisive item(s), and whether each retrieved side pair's own unit shows them.
          const decisiveKeys = (t.decisive ?? []).flatMap((d) => { const ds = sides.flatMap((sd) => [sd.a, sd.b]).filter((x) => x.range.startsWith(`${d.witness} ${d.takenOn} `) && "depositionId" in x).map((x) => (x as { depositionId: number }).depositionId); return built.items.filter((i) => ds.includes(i.depositionId) && i.positions.some((q) => inRange(q, d))).map((i) => i.key); });
          const shownInOwnUnit = sides.map((sd) => {
            const combos = sd.a.keys.flatMap((ka) => sd.b.keys.map((kb) => pk(ka, kb)));
            const u = units.find((x) => x.pairs.some(([a, b]) => combos.includes(pk(a, b))));
            return u ? decisiveKeys.map((k) => ({ key: k, citable: u.xKeys.includes(k) || u.yKeys.includes(k) })) : "pair not kept";
          });
          return { pad, requests: set.packets.length, itemTokens: sized.reduce((n, p) => n + p.passageTokens, 0), projectedFastUsd: Number(projectCost(sized, true, STRETCH_COST_ASSUMPTIONS).toFixed(2)), projectedEconomyUsd: Number((projectCost(sized, false, STRETCH_COST_ASSUMPTIONS) * BATCH_MULTIPLIER).toFixed(2)), decisive: shownInOwnUnit };
        });
        out.push({ target: t.id, minilm, minilmUsed, items: built.items.length, poolPairs: built.pool.candidates.length, kept: built.triage.kept.length, sides: rows, ...(pads.length ? { padding } : {}) });
      }
    }
  } finally {
    await pool.end();
  }
  const text = JSON.stringify(out, null, 1);
  if (values.json) {
    const file = path.resolve(values.json);
    if (!file.startsWith(path.resolve("data/raw") + path.sep)) throw new Error("--json holds testimony references: write it under data/raw/");
    writeFileSync(file, text);
  }
  console.log(text);

  // Which item(s) hold a side's lines, or which exclusion took them.
  async function locate(x: Range, built: CasePoolResult, depositionId: number | null) {
    if (depositionId === null) return { range: `${x.witness} ${x.takenOn} ${x.from}-${x.to}`, keys: [] as string[], problem: "no included deposition for this session" };
    const keys = built.items.filter((i: CaseItem) => i.depositionId === depositionId && i.positions.some((p) => inRange(p, x))).map((i) => i.key);
    const groups = (await db.selectDistinct({ g: exchanges.groupId, p: lines.printedPage, l: lines.lineNo }).from(lines)
      .innerJoin(exchangeLines, eq(exchangeLines.lineId, lines.id)).innerJoin(exchanges, eq(exchanges.id, exchangeLines.exchangeId))
      .where(eq(lines.depositionId, depositionId))).filter((row) => inRange(`${row.p}:${row.l}`, x)).map((row) => row.g);
    const excluded = built.excluded.filter((e) => e.depositionId === depositionId && groups.includes(e.groupId)).map((e) => ({ groupId: e.groupId, class: e.class, reason: e.reason }));
    return { range: `${x.witness} ${x.takenOn} ${x.from}-${x.to}`, depositionId, keys, excluded };
  }

  // Whether the decisive lines are in the request's passages as the case run would build them.
  async function shown(db2: typeof db, built: CasePoolResult, items: string[], pairs: [string, string][], allItems: boolean, decisive: Range[]) {
    const byKey = new Map(built.items.map((i) => [i.key, i]));
    const keys = allItems ? items : [...new Set(pairs.flat())];
    // As the case run does (jobs/caseRun.ts entryContext): items carry the witness's name, not its pool key.
    const names = new Map((await db2.select({ id: witnesses.id, name: witnesses.name }).from(witnesses)).map((w) => [w.id, w.name]));
    const frozen = keys.map((k) => { const i = byKey.get(k)!; return { ...i, witness: names.get(i.witnessId) ?? "" }; });
    const { passages, unresolved } = await resolvePassages(db2, frozen, new Map(frozen.map((i) => [i.document, i.depositionId])));
    if (unresolved.length) throw new Error(`passages not resolved: ${JSON.stringify(unresolved.slice(0, 3))}`);
    const built2 = buildIssuePacket({ id: "trace", issue: "", items: keys, pairs, inputTokens: 0 }, passages, { allItems });
    const packet = built2.packet as IssuePacket;
    const decisiveDocs = await Promise.all(decisive.map(async (d) => ({ d, dep: (await db2.select({ id: depositions.id }).from(depositions).innerJoin(witnesses, eq(witnesses.id, depositions.witnessId)).where(and(inArray(depositions.id, [...new Set(frozen.map((i) => i.depositionId))]), eq(witnesses.name, d.witness), eq(depositions.takenOn, d.takenOn))))[0]?.id ?? null })));
    return decisiveDocs.map(({ d, dep }) => {
      const ps = packet.passages.filter((p) => p.depositionId === dep);
      const citable = ps.some((p) => p.lines.some((l) => inRange(`${l.page}:${l.line}`, d)));
      const context = ps.some((p) => [...p.before, ...p.after].some((l) => inRange(`${l.page}:${l.line}`, d)));
      return { lines: `${d.from}-${d.to}`, shown: citable ? "citable" : context ? "context only" : "not shown", passagesFromThatSession: ps.length };
    });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
