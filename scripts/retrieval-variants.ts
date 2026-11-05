// Bounded retrieval variants on production's case pool (retrieve/casePool.ts), measured against labelled pairs.
// Free and read-only: no model call, writes nothing to the database.
//
//   npx tsx scripts/retrieval-variants.ts --db <_rehearsal_ db> --set tuning|limo|heldout [--variants a,b] [--json data/raw/<f>]
//
// Sets: tuning = the 16 developer-decided Simpson-Resnick pairs (case "Simpson-Resnick accuracy eval (3 sessions)");
// limo = limo/SUV (unverified; reported only); heldout = independent-cross-v1, 48 synthetic pairs (AI-written, blind
// AI review, developer-resolved), all 20 transcripts as one 20-session case. The held-out set is never used to choose
// a variant: `--set heldout` refuses to run unless --variants names the variants chosen beforehand.
//
// Per variant: labels whose evidence reaches the pool and survives triage (a label counts when any of its side pairs
// does), positives covered, controls admitted, pool and kept pairs, partners per item, packet-v1 and stretch-v2
// requests, and the projected fast-mode model cost of a whole-case run (the case-run estimate's own projection).

import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { and, eq, isNull, sql } from "drizzle-orm";
import { connect } from "../server/src/db/client";
import { depositions, witnesses } from "../server/src/db/schema";
import { COST_ASSUMPTIONS, projectCost, STRETCH_COST_ASSUMPTIONS } from "../server/src/eval/screeningBenchmark";
import { buildCasePool, type CaseSelection } from "../server/src/retrieve/casePool";
import { pairKey } from "../server/src/retrieve/frozen";
import { INSTRUCTION_TOKENS } from "../server/src/retrieve/grouping";
import { PACKET_LIMITS, splitPacketSet } from "../server/src/retrieve/packetSplit";
import { buildStretchSet } from "../server/src/retrieve/stretchSet";

type Variant = { id: string; perItem: number; minilm: "off" | "auto"; selection?: CaseSelection; note: string };
export const VARIANTS: Variant[] = [
  { id: "baseline", perItem: 5, minilm: "off", note: "production today: fused top 5 per item across all other sessions" },
  { id: "top10", perItem: 10, minilm: "off", note: "reference: a wider global cut" },
  { id: "top15", perItem: 15, minilm: "off", note: "reference: a wider global cut" },
  { id: "session2", perItem: 5, minilm: "off", selection: { perSession: 2 }, note: "top 5 + best 2 in every other session" },
  { id: "session3", perItem: 5, minilm: "off", selection: { perSession: 3 }, note: "top 5 + best 3 in every other session" },
  { id: "witness2", perItem: 5, minilm: "off", selection: { perWitness: 2 }, note: "top 5 + best 2 from every other witness" },
  { id: "witness3", perItem: 5, minilm: "off", selection: { perWitness: 3 }, note: "top 5 + best 3 from every other witness" },
  { id: "session2-floor0.5", perItem: 5, minilm: "off", selection: { perSession: 2, minShare: 0.5 }, note: "session2, quota partners only at >= 0.5 x the item's 5th fused score" },
  { id: "session2-floor0.7", perItem: 5, minilm: "off", selection: { perSession: 2, minShare: 0.7 }, note: "session2, quota partners only at >= 0.7 x the item's 5th fused score" },
  { id: "session2-floor0.85", perItem: 5, minilm: "off", selection: { perSession: 2, minShare: 0.85 }, note: "session2, quota partners only at >= 0.85 x the item's 5th fused score" },
  { id: "path1", perItem: 5, minilm: "off", selection: { perPath: 1 }, note: "top 5 + each path's own best partner" },
  { id: "path2", perItem: 5, minilm: "off", selection: { perPath: 2 }, note: "top 5 + each path's own best 2" },
  { id: "minilm", perItem: 5, minilm: "auto", note: "top 5 with the MiniLM path added (local model files)" },
  { id: "minilm-session2", perItem: 5, minilm: "auto", selection: { perSession: 2 }, note: "MiniLM + best 2 in every other session" },
];

type Side = { witness: string; takenOn: string; has: (p: string) => boolean };
type Label = { id: string; truth: "positive" | "control"; a: Side; b: Side };
const pos = (p: string) => { const [pg, ln] = p.split(":").map(Number); return pg * 100000 + ln; };
const inRange = (from: string, to: string) => (p: string) => pos(p) >= pos(from) && pos(p) <= pos(to);

function labelsOf(set: string): { caseName: string; labels: Label[] } {
  if (set === "tuning") {
    const sr = JSON.parse(readFileSync("data/eval/simpson-resnick-cross-v2.json", "utf8"));
    const side = (s: { document: string; part?: number; lines: number[] }): Side => { const d = sr.documents[s.document]; const lines = new Set(s.lines.map((l) => `${s.part ?? 0}:${l}`)); return { witness: d.witness, takenOn: d.takenOn, has: (p) => lines.has(p) }; };
    return { caseName: "Simpson-Resnick accuracy eval (3 sessions)", labels: sr.comparisons[0].pairs.filter((p: { expected: string }) => p.expected !== "exploratory").map((p: { id: string; expected: string; a: never; b: never }) => ({ id: p.id, truth: p.expected === "no_conflict" ? "control" : "positive", a: side(p.a), b: side(p.b) })) };
  }
  if (set === "limo") {
    const h = JSON.parse(readFileSync("data/eval/hutchinson-discrepancies-v1.json", "utf8")).discrepancies.find((d: { id: string }) => d.id === "limo-suv");
    const side = (rs: { document: string; from: string; to: string }[]): Side => ({ witness: "Cassidy Hutchinson", takenOn: rs[0].document.slice(-10), has: (p) => rs.some((r) => inRange(r.from.split(":").map(Number).join(":"), r.to.split(":").map(Number).join(":"))(p)) });
    return { caseName: "Cassidy Hutchinson", labels: [{ id: "limo-suv (unverified)", truth: "positive", a: side(h.a), b: side(h.b) }] };
  }
  if (set === "heldout") {
    const f = JSON.parse(readFileSync("data/eval/independent-cross-v1-fixture.json", "utf8"));
    const side = (s: { document: string; from: string; to: string }): Side => ({ witness: f.documents[s.document].witness, takenOn: f.documents[s.document].takenOn, has: inRange(s.from, s.to) });
    return { caseName: "independent-cross-v1 (20 sessions, held out)", labels: f.items.map((i: { id: string; category: string; sides: never[] }) => ({ id: i.id, truth: i.category === "no_conflict" ? "control" : "positive", a: side(i.sides[0]), b: side(i.sides[1]) })) };
  }
  throw new Error("--set tuning|limo|heldout");
}

async function main() {
  const { values } = parseArgs({ options: { db: { type: "string" }, set: { type: "string" }, variants: { type: "string" }, json: { type: "string" } } });
  if (!values.db || !/_rehearsal_|_test$/.test(values.db)) throw new Error("--db must name a disposable database");
  if (values.set === "heldout" && !values.variants) throw new Error("held-out set: name the variants chosen on the tuning set (--variants)");
  const chosen = values.variants ? values.variants.split(",") : VARIANTS.map((v) => v.id);
  const variants = VARIANTS.filter((v) => chosen.includes(v.id));
  const { caseName, labels } = labelsOf(values.set ?? "");
  const u = new URL(process.env.DATABASE_URL!); u.pathname = `/${values.db}`;
  const { db, pool } = connect(u.toString(), { max: 4 });
  const out: Record<string, unknown>[] = [];
  try {
    const [kase] = (await db.execute<{ id: number }>(sql`select id from cases where name = ${caseName} order by id desc limit 1`)).rows;
    if (!kase) throw new Error(`case "${caseName}" not in ${values.db}`);
    const caseId = Number(kase.id);
    const docs = new Map<string, number | null>();
    const docOf = async (s: Side) => {
      const k = `${s.witness}|${s.takenOn}`;
      if (!docs.has(k)) docs.set(k, (await db.select({ id: depositions.id }).from(depositions).innerJoin(witnesses, eq(witnesses.id, depositions.witnessId)).where(and(eq(depositions.caseId, caseId), eq(witnesses.name, s.witness), eq(depositions.takenOn, s.takenOn), isNull(depositions.excludedReason))))[0]?.id ?? null);
      return docs.get(k)!;
    };
    for (const v of variants) {
      const started = performance.now();
      const built = await buildCasePool(db, pool, caseId, { perItem: v.perItem, minilm: v.minilm, selection: v.selection });
      const ms = Math.round(performance.now() - started);
      const inPool = new Set(built.pool.candidates.map((c) => pairKey(c.a, c.b)));
      const kept = new Set(built.triage.kept.map((c) => pairKey(c.a, c.b)));
      const per = await Promise.all(labels.map(async (l) => {
        const [da, dbb] = [await docOf(l.a), await docOf(l.b)];
        const ka = built.items.filter((i) => i.depositionId === da && i.positions.some(l.a.has)).map((i) => i.key);
        const kb = built.items.filter((i) => i.depositionId === dbb && i.positions.some(l.b.has)).map((i) => i.key);
        const pairs = ka.flatMap((a) => kb.map((b) => pairKey(a, b)));
        return { id: l.id, truth: l.truth, items: ka.length > 0 && kb.length > 0, sidePairs: pairs.length, inPool: pairs.filter((p) => inPool.has(p)).length, kept: pairs.filter((p) => kept.has(p)).length };
      }));
      const packets = splitPacketSet(built.packets, built.items, PACKET_LIMITS);
      const stretches = buildStretchSet(built.triage.kept, built.items);
      const size = (ps: { inputTokens: number; pairs: unknown[] }[]) => ps.map((p) => ({ passageTokens: p.inputTokens - INSTRUCTION_TOKENS, pairs: p.pairs.length }));
      const pos_ = per.filter((x) => x.truth === "positive"), ctl = per.filter((x) => x.truth === "control");
      out.push({
        variant: v.id, note: v.note, minilmUsed: built.paths.some((p) => p.name.includes("minilm") && p.available), buildMs: ms,
        positivesKept: `${pos_.filter((x) => x.kept).length}/${pos_.length}`, positivesInPool: pos_.filter((x) => x.inPool).length, controlsKept: `${ctl.filter((x) => x.kept).length}/${ctl.length}`,
        items: built.items.length, sessions: new Set(built.items.map((i) => i.session)).size, poolPairs: built.pool.candidates.length, keptPairs: built.triage.kept.length, pairsPerItem: +(built.pool.candidates.length / built.items.length).toFixed(2),
        packetV1Requests: packets.packets.length, stretchRequests: stretches.packets.length,
        projectedFastUsd: { packetV1: +projectCost(size(packets.packets), true, COST_ASSUMPTIONS).toFixed(2), stretchV2: +projectCost(size(stretches.packets), true, STRETCH_COST_ASSUMPTIONS).toFixed(2) },
        labels: per.map((x) => `${x.id}:${x.truth[0]}:${x.kept ? "kept" : x.inPool ? "deferred" : x.items ? "lost" : "no item"}`).join(" "),
      });
      console.error(`${v.id} done in ${ms} ms`);
    }
  } finally {
    await pool.end();
  }
  const text = JSON.stringify(out, null, 1);
  if (values.json) {
    const file = path.resolve(values.json);
    if (!file.startsWith(path.resolve("data/raw") + path.sep)) throw new Error("--json: write under data/raw/");
    writeFileSync(file, text);
  }
  console.log(text);
}
main().catch((e) => { console.error(e); process.exit(1); });
