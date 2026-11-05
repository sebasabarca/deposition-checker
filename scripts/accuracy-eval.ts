// Real-model accuracy evaluation of packet-v1 against stretch-v2 (EXPERIMENTAL, disposable databases only).
//
//   freeze --db <_rehearsal_ db>      trace every labelled pair through production retrieval (both contracts),
//                                     then render, with production code, every request that holds a labelled pair
//                                     ("production") plus requests for labelled pairs retrieval lost ("oracle");
//                                     writes data/raw/accuracy-eval/frozen/ once, never overwritten
//   plan                              calls, tokens and worst-case cost of every planned run
//   run --set labelled|pilot [--contract packet-v1|stretch-v2] --label <r1> --approved-usd <n> --execute --db <db>
//                                     PAID (also needs ALLOW_PAID_CALLS=true). Sends through the production
//                                     adjudicator (adjudicate/packetModel.ts) with production recovery rounds.
//                                     "pilot" re-sends the frozen 49 stretch-v2 pilot requests unchanged.
//   score                             every run read back with production readers; writes score.json
//
// Budget: one ceiling for the whole evaluation (TOTAL_CAP_USD), across every set, contract and run, read from every
// calls.jsonl under data/raw/accuracy-eval/runs/. Each request reserves its worst case before it is sent; a possibly
// billed failure is counted at its worst case and never re-sent. One process at a time (a lock file).
//
// Labels: only the developer-decided Simpson-Resnick pairs (data/eval/simpson-resnick-cross-v2.json) are scored as
// ground truth. limo/SUV (hutchinson-discrepancies-v1.json) is Claude-proposed and unverified: reported, never in
// a percentage. Exploratory pairs are not scored.

import "dotenv/config";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { and, eq, isNull, sql } from "drizzle-orm";
import { buildIssuePacket, resolvePassages } from "../server/src/adjudicate/packetLoad";
import { anthropicPacketAdjudicator } from "../server/src/adjudicate/packetModel";
import { maxOutputTokensFor, PACKET_MODEL, PACKET_PROMPTS, type IssuePacket, type PacketPassage } from "../server/src/adjudicate/packetPrompt";
import { parseVerdictsLenient, VERDICT_SCHEMAS } from "../server/src/adjudicate/packetSchema";
import { classifyFailure } from "../server/src/adjudicate/requests";
import { mockStretchReply, readStretchReply } from "../server/src/adjudicate/stretch";
import { mockPacketReply } from "../server/src/eval/mockPacketModel";
import { callCost, inputTokenBound, maxRequestCost, recordCall, tokensFromUsage } from "../server/src/costs";
import { connect } from "../server/src/db/client";
import { depositions, witnesses } from "../server/src/db/schema";
import { buildCasePool, type CaseItem } from "../server/src/retrieve/casePool";
import { pairKey } from "../server/src/retrieve/frozen";
import { PACKET_LIMITS, splitPacketSet } from "../server/src/retrieve/packetSplit";
import { buildStretchSet } from "../server/src/retrieve/stretchSet";
import { MAX_RECOVERY_ROUNDS, verifyPacketReply } from "../server/src/verify/packet";

const TOTAL_CAP_USD = 6; // the developer's ceiling for this whole evaluation (2026-11-05)
const OUT = "data/raw/accuracy-eval";
const FROZEN = path.join(OUT, "frozen");
const RUNS = path.join(OUT, "runs");
const PILOT = path.resolve("../deposition-checker/data/raw/candidate-reduction/stretch-pilot-v2/frozen"); // the main checkout's data, read only
const CONTRACTS = ["packet-v1", "stretch-v2"] as const;
type Contract = (typeof CONTRACTS)[number];
const FLAG = ["direct", "inferential", "needs_more_context"]; // what a lawyer is shown for review, in both contracts
const CONFLICT = ["direct", "inferential"];

const sha = (x: string | Buffer) => createHash("sha256").update(x).digest("hex");
const jl = <T>(f: string) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : []);
const groupBy = <T>(xs: readonly T[], f: (x: T) => string) => { const m = new Map<string, T[]>(); for (const x of xs) (m.get(f(x)) ?? m.set(f(x), []).get(f(x))!).push(x); return m; };
const pos = (p: string) => { const [pg, ln] = p.split(":").map(Number); return pg * 100000 + ln; };

// ---------------------------------------------------------------- labels
type Side = { witness: string; takenOn: string; has: (p: string) => boolean; lines: string[] };
type Label = { id: string; truth: "review_worthy" | "no_conflict"; verified: boolean; development: string | null; caseName: string; a: Side; b: Side; note: string };
// Labels used while designing or tuning either contract (seen in the stretch pilots or the verifier design).
const DEVELOPMENT: Record<string, string> = {
  C01: "stretch pilots v1/v2 target", C02: "stretch pilots v1/v2 target", "CW-001": "stretch pilots v1/v2 target",
  C08: "stretch pilots v1/v2 control; verify-v1 root-cause analysis", "NC-001": "stretch pilots v1/v2 control",
  C07: "verifier pilot item (after stretch-v2 was frozen)", N03: "verifier pilot item (after stretch-v2 was frozen)", "NC-002": "verifier pilot item (after stretch-v2 was frozen)",
  "limo-suv": "development case for every contract",
};
const EVAL_CASE = "Simpson-Resnick accuracy eval (3 sessions)";
function loadLabels(): Label[] {
  const sr = JSON.parse(readFileSync("data/eval/simpson-resnick-cross-v2.json", "utf8"));
  const docs = sr.documents as Record<string, { witness: string; takenOn: string; sha256: string }>;
  const side = (s: { document: string; part?: number; lines: number[] }): Side => {
    const set = new Set(s.lines.map((l) => `${s.part ?? 0}:${l}`));
    return { witness: docs[s.document].witness, takenOn: docs[s.document].takenOn, has: (p) => set.has(p), lines: [...set] };
  };
  const out: Label[] = [];
  for (const p of sr.comparisons[0].pairs) {
    if (p.expected === "exploratory") continue;
    out.push({ id: p.id, truth: p.expected === "no_conflict" ? "no_conflict" : "review_worthy", verified: true, development: DEVELOPMENT[p.id] ?? null, caseName: EVAL_CASE, a: side(p.a), b: side(p.b), note: p.note });
  }
  const h = JSON.parse(readFileSync("data/eval/hutchinson-discrepancies-v1.json", "utf8"));
  const limo = h.discrepancies.find((d: { id: string }) => d.id === "limo-suv");
  const ranges = (rs: { document: string; from: string; to: string }[]): Side => {
    const doc = h.documents[rs[0].document];
    const norm = (x: string) => x.split(":").map(Number).join(":");
    return { witness: "Cassidy Hutchinson", takenOn: doc.takenOn ?? rs[0].document.slice(-10), has: (p) => rs.some((r) => pos(p) >= pos(norm(r.from)) && pos(p) <= pos(norm(r.to))), lines: rs.map((r) => `${r.from}-${r.to}`) };
  };
  out.push({ id: "limo-suv", truth: "review_worthy", verified: false, development: DEVELOPMENT["limo-suv"], caseName: "Cassidy Hutchinson", a: ranges(limo.a), b: ranges(limo.b), note: limo.classification.decidedBy });
  return out;
}

// ---------------------------------------------------------------- freeze
type Spec = { id: string; items: string[]; pairs: [string, string][] };
type Frozen = { id: string; contract: Contract; caseId: number; set: "production" | "oracle"; spec: Spec; passages: [string, PacketPassage][]; packet: IssuePacket; text: string; textSha256: string; pairs: number; labelPairs: { label: string; pairId: string }[]; worstUsd: number };
const worstOf = (contract: Contract, text: string, pairs: number) => maxRequestCost(PACKET_MODEL, { inputTokens: inputTokenBound(PACKET_PROMPTS[contract].system.length + JSON.stringify(PACKET_PROMPTS[contract].jsonSchema).length + text.length), maxOutputTokens: maxOutputTokensFor(pairs) });
const keyOfPair = (packet: IssuePacket, pairId: string) => { const pr = packet.pairs.find((p) => p.pairId === pairId)!; const k = (id: string) => packet.passages.find((x) => x.id === id)!.key; return pairKey(k(pr.a), k(pr.b)); };

async function freeze(dbName: string) {
  if (existsSync(path.join(FROZEN, "manifest.json"))) throw new Error(`${FROZEN} is frozen; it is never overwritten`);
  const { db, pool } = connectTo(dbName);
  const labels = loadLabels();
  const trace: unknown[] = [];
  const frozen: Frozen[] = [];
  try {
    for (const caseName of [...new Set(labels.map((l) => l.caseName))]) {
      const [kase] = (await db.execute<{ id: number }>(sql`select id from cases where name = ${caseName} order by id desc limit 1`)).rows;
      if (!kase) throw new Error(`case "${caseName}" is not in ${dbName}`);
      const caseId = Number(kase.id);
      const built = await buildCasePool(db, pool, caseId, { minilm: "off" }); // the case-run default
      const byKey = new Map(built.items.map((i) => [i.key, i]));
      const names = new Map((await db.select({ id: witnesses.id, name: witnesses.name }).from(witnesses)).map((w) => [w.id, w.name]));
      const sets = { "packet-v1": splitPacketSet(built.packets, built.items, PACKET_LIMITS), "stretch-v2": buildStretchSet(built.triage.kept, built.items) };
      const rank = new Map(built.pool.candidates.map((c, i) => [pairKey(c.a, c.b), i + 1]));
      const deferred = new Map(built.triage.deferred.map((d) => [pairKey(d.a, d.b), `${d.stage}: ${d.reason}`]));
      const kept = new Set(built.triage.kept.map((c) => pairKey(c.a, c.b)));
      const docOf = async (s: Side) => (await db.select({ id: depositions.id }).from(depositions).innerJoin(witnesses, eq(witnesses.id, depositions.witnessId))
        .where(and(eq(depositions.caseId, caseId), eq(witnesses.name, s.witness), eq(depositions.takenOn, s.takenOn), isNull(depositions.excludedReason))))[0]?.id ?? null;
      const chosen = { "packet-v1": new Set<string>(), "stretch-v2": new Set<string>() };
      const oraclePairs: { label: string; a: string; b: string }[] = [];
      for (const l of labels.filter((x) => x.caseName === caseName)) {
        const sides = await Promise.all([l.a, l.b].map(async (s) => {
          const dep = await docOf(s);
          const stored = dep === null ? 0 : Number((await db.execute<{ n: number }>(sql`select count(*)::int as n from lines where deposition_id = ${dep}`)).rows[0].n);
          const keys = built.items.filter((i) => i.depositionId === dep && i.positions.some(s.has)).map((i) => i.key);
          const linesInItems = new Set(built.items.filter((i) => i.depositionId === dep).flatMap((i) => i.positions.filter(s.has)));
          return { dep, storedLines: stored, keys, labelledLines: s.lines.length, labelledLinesInEligibleItems: linesInItems.size };
        }));
        const pairs = sides[0].keys.flatMap((a) => sides[1].keys.map((b) => ({ a, b, k: pairKey(a, b) })));
        const rows = pairs.map((p) => ({
          pair: p.k, poolRank: rank.get(p.k) ?? null, triage: kept.has(p.k) ? "kept" : (deferred.get(p.k) ?? (rank.has(p.k) ? "?" : "not in pool")),
          packetV1: sets["packet-v1"].packets.find((x) => x.pairs.some(([a, b]) => pairKey(a, b) === p.k))?.id ?? null,
          stretchV2: sets["stretch-v2"].packets.find((x) => x.pairs.some(([a, b]) => pairKey(a, b) === p.k))?.id ?? null,
        }));
        for (const r of rows) { if (r.packetV1) chosen["packet-v1"].add(r.packetV1); if (r.stretchV2) chosen["stretch-v2"].add(r.stretchV2); }
        for (const p of pairs) if (!kept.has(p.k)) oraclePairs.push({ label: l.id, a: p.a, b: p.b });
        trace.push({ label: l.id, truth: l.truth, verified: l.verified, caseId, sides: sides.map((s) => ({ depositionId: s.dep, storedLines: s.storedLines, labelledLines: s.labelledLines, labelledLinesInEligibleItems: s.labelledLinesInEligibleItems, items: s.keys })), sidePairs: rows.length, inPool: rows.filter((r) => r.poolRank).length, kept: rows.filter((r) => r.triage === "kept").length, pairs: rows });
      }

      // Rendered exactly as jobs/caseRun.ts entryContext + nextStep do: stored lines, witness names, allItems for stretch.
      const render = async (contract: Contract, spec: Spec, indexKeys: string[], set: Frozen["set"]) => {
        const stretch = contract === "stretch-v2";
        const paired = [...new Set(spec.pairs.flat())];
        const held = new Set(spec.items.flatMap((k) => byKey.get(k)!.exchangeIds));
        const keys = stretch ? [...new Set([...paired, ...indexKeys.filter((k) => byKey.get(k)!.exchangeIds.some((x) => held.has(x)))])] : paired;
        const items = keys.map((k) => { const i = byKey.get(k)! as CaseItem; return { key: k, document: i.document, session: i.session, groupId: i.groupId, positions: i.positions, sourceHash: i.sourceHash, depositionId: i.depositionId, witnessId: i.witnessId, sessionId: i.sessionId, exchangeIds: i.exchangeIds, witness: names.get(i.witnessId) ?? "", question: "", answer: "", context: "" }; });
        const { passages, unresolved } = await resolvePassages(db, items, new Map(keys.map((k) => [byKey.get(k)!.document, byKey.get(k)!.depositionId])));
        if (unresolved.length) throw new Error(`${spec.id}: passages not resolved`);
        const b = buildIssuePacket({ id: spec.id, issue: "", items: keys, pairs: spec.pairs, inputTokens: 0 }, passages, { allItems: stretch });
        if (b.unbuilt.length || !b.packet) throw new Error(`${spec.id}: packet not built`);
        const text = PACKET_PROMPTS[contract].format(b.packet);
        const labelPairs = b.packet.pairs.flatMap((pr) => trace.filter((t) => (t as { caseId: number }).caseId === caseId).flatMap((t) => ((t as { pairs: { pair: string }[] }).pairs.some((x) => x.pair === keyOfPair(b.packet!, pr.pairId)) ? [{ label: (t as { label: string }).label, pairId: pr.pairId }] : [])));
        frozen.push({ id: `${contract}/${set}/${caseId}/${spec.id}`, contract, caseId, set, spec: { ...spec, items: keys }, passages: [...passages.entries()], packet: b.packet, text, textSha256: sha(text), pairs: b.packet.pairs.length, labelPairs, worstUsd: worstOf(contract, text, b.packet.pairs.length) });
      };
      for (const contract of CONTRACTS) {
        const set = sets[contract];
        const indexKeys = built.items.filter((i) => set.packets.some((p) => p.items.includes(i.key))).map((i) => i.key);
        for (const p of set.packets.filter((x) => chosen[contract].has(x.id))) await render(contract, { id: p.id, items: p.items, pairs: p.pairs }, indexKeys, "production");
      }
      // Oracle: the labelled pairs retrieval did not keep, given to each contract as its own requests (packet-v1:
      // up to 8 pairs a packet, as PACKET_LIMITS; stretch-v2: the production stretch builder over these pairs only).
      if (oraclePairs.length) {
        const byLabel = groupBy(oraclePairs, (p) => p.label);
        for (const [label, ps] of byLabel) for (let i = 0; i < ps.length; i += PACKET_LIMITS.maxPairs) {
          const chunk = ps.slice(i, i + PACKET_LIMITS.maxPairs).map((p) => [p.a, p.b] as [string, string]);
          await render("packet-v1", { id: `oracle-${label}-${i / PACKET_LIMITS.maxPairs + 1}`, items: [...new Set(chunk.flat())], pairs: chunk }, [], "oracle");
        }
        const os = buildStretchSet(oraclePairs, built.items);
        const indexKeys = built.items.filter((i) => os.packets.some((p) => p.items.includes(i.key))).map((i) => i.key);
        for (const p of os.packets) await render("stretch-v2", { id: `oracle-${p.id}`, items: p.items, pairs: p.pairs }, indexKeys, "oracle");
      }
      trace.push({ caseId, caseName, items: built.items.length, poolPairs: built.pool.candidates.length, kept: built.triage.kept.length, requests: { "packet-v1": sets["packet-v1"].packets.length, "stretch-v2": sets["stretch-v2"].packets.length }, sourceHash: built.sourceHash });
    }
  } finally {
    await pool.end();
  }
  mkdirSync(FROZEN, { recursive: true });
  writeFileSync(path.join(FROZEN, "trace.json"), JSON.stringify(trace, null, 1));
  writeFileSync(path.join(FROZEN, "requests.jsonl"), frozen.map((f) => JSON.stringify(f)).join("\n") + "\n");
  const manifest = {
    version: "accuracy-eval-v1", frozenOn: new Date().toISOString(), db: dbName, capUsd: TOTAL_CAP_USD,
    prompts: Object.fromEntries(CONTRACTS.map((c) => [c, { system: sha(PACKET_PROMPTS[c].system), schema: sha(JSON.stringify(PACKET_PROMPTS[c].jsonSchema)) }])),
    model: PACKET_MODEL, requests: Object.fromEntries(frozen.map((f) => [f.id, f.textSha256])),
    scoring: {
      flag: "a pair is flagged when packet-v1 answers direct, inferential or needs_more_context, or stretch-v2 reports it (flagged or flagged_unverified); conflict = direct or inferential",
      detected: "a developer-labelled review-worthy pair is detected when any of its side pairs (an item holding a labelled line on each side) is flagged; verified when that flag's citation is verified on both sides",
      falsePositive: "any flag on a side pair of a developer-labelled no_conflict control",
      unverifiedLabels: "limo-suv is reported alone and never enters a rate",
      everythingElse: "flags on unlabelled pairs are counted, never scored as right or wrong",
    },
  };
  writeFileSync(path.join(FROZEN, "manifest.json"), JSON.stringify(manifest, null, 1));
  console.log(JSON.stringify({ requests: frozen.length, byContract: Object.fromEntries(CONTRACTS.map((c) => [c, frozen.filter((f) => f.contract === c).map((f) => f.id)])) }, null, 1));
}

function connectTo(dbName: string) {
  if (!/_rehearsal_|_test$/.test(dbName)) throw new Error("--db must name a disposable database (_rehearsal_ or _test)");
  const u = new URL(process.env.DATABASE_URL!);
  u.pathname = `/${dbName}`;
  return connect(u.toString(), { max: 4 });
}

// ---------------------------------------------------------------- plan
type Pilot = { id: string; text: string; textSha256: string; pairs: number; maxTokens: number };
function loadPilot(): Pilot[] {
  const manifest = JSON.parse(readFileSync(path.join(PILOT, "manifest.json"), "utf8"));
  const reqs = jl<Pilot>(path.join(PILOT, "requests.jsonl"));
  const changed = reqs.filter((r) => sha(r.text) !== manifest.requests[r.id] || r.maxTokens !== maxOutputTokensFor(r.pairs));
  if (changed.length || sha(PACKET_PROMPTS["stretch-v2"].system) !== manifest.prompt.systemSha256 || sha(JSON.stringify(PACKET_PROMPTS["stretch-v2"].jsonSchema)) !== manifest.prompt.schemaSha256) throw new Error("the frozen pilot no longer matches the production stretch-v2 request");
  return reqs;
}
function loadFrozen() {
  const manifest = JSON.parse(readFileSync(path.join(FROZEN, "manifest.json"), "utf8"));
  const reqs = jl<Frozen>(path.join(FROZEN, "requests.jsonl"));
  const changed = reqs.filter((r) => sha(r.text) !== manifest.requests[r.id] || sha(PACKET_PROMPTS[r.contract].system) !== manifest.prompts[r.contract].system);
  if (changed.length) throw new Error(`frozen requests changed: ${changed.map((r) => r.id).join(", ")}`);
  return reqs;
}
function plan() {
  const reqs = loadFrozen();
  const pilot = loadPilot();
  const per = (c: Contract) => { const r = reqs.filter((x) => x.contract === c); return { requests: r.length, production: r.filter((x) => x.set === "production").length, oracle: r.filter((x) => x.set === "oracle").length, pairs: r.reduce((n, x) => n + x.pairs, 0), chars: r.reduce((n, x) => n + x.text.length, 0), worstUsd: +r.reduce((n, x) => n + x.worstUsd, 0).toFixed(2) }; };
  const out = { capUsd: TOTAL_CAP_USD, spentUsd: +spent().toFixed(4), labelled: Object.fromEntries(CONTRACTS.map((c) => [c, per(c)])), pilot: { requests: pilot.length, pairs: pilot.reduce((n, r) => n + r.pairs, 0), worstUsd: +pilot.reduce((n, r) => n + worstOf("stretch-v2", r.text, r.pairs), 0).toFixed(2), measuredLastRunUsd: 0.7849 } };
  console.log(JSON.stringify(out, null, 1));
}

// ---------------------------------------------------------------- run (paid; gated)
type CallLog = { at?: string; id: string; round?: number; attempt?: number; outcome: string; usage?: Anthropic.Usage; costUsd?: number; uncertainCostUsd?: number; requestId?: string | null; stopReason?: string | null; error?: string };
const spent = () => (existsSync(RUNS) ? readdirSync(RUNS) : []).reduce((n, d) => n + jl<CallLog>(path.join(RUNS, d, "calls.jsonl")).reduce((m, c) => m + (c.costUsd ?? 0) + (c.uncertainCostUsd ?? 0), 0), 0);

async function run(o: { set: "labelled" | "pilot"; contract: Contract; label: string; approvedUsd: number; execute: boolean; dbName: string; concurrency: number; mock: boolean; resume: boolean }) {
  // --mock: the production mock replies (free), under mock-runs/, to check this runner and the scorer end to end.
  if (o.mock && o.set === "pilot") throw new Error("--mock covers the labelled set only");
  if (!o.mock) {
  if (process.env.ALLOW_PAID_CALLS !== "true") throw new Error("paid run refused: ALLOW_PAID_CALLS=true is not set on this command");
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("paid run refused: ANTHROPIC_API_KEY is not set");
  if (!o.execute || !(o.approvedUsd > 0)) throw new Error("paid run refused: --execute and --approved-usd <n> are both required");
  }
  const root = o.mock ? path.join(OUT, "mock-runs") : RUNS;
  const contract: Contract = o.set === "pilot" ? "stretch-v2" : o.contract;
  const dir = path.join(root, `${o.set}-${contract}-${o.label}`);
  if (existsSync(path.join(dir, "replies.jsonl")) && !o.resume) throw new Error(`${dir} already holds replies: pass --resume, or use a new --label`);
  // Resume: a request with any reply, or with a possibly billed failure, is never sent again.
  const done = new Set([...jl<{ id: string }>(path.join(dir, "replies.jsonl")).map((x) => x.id), ...jl<CallLog & { billable?: boolean }>(path.join(dir, "calls.jsonl")).filter((c) => c.billable).map((c) => c.id)]);
  mkdirSync(dir, { recursive: true });
  const lock = path.join(root, ".lock");
  writeFileSync(lock, String(process.pid), { flag: "wx" }); // throws if another run holds it
  const { db, pool } = connectTo(o.dbName);
  const model = anthropicPacketAdjudicator(new Anthropic({ maxRetries: 0, apiKey: o.mock ? "mock" : undefined }), contract);
  const ceiling = o.mock ? Infinity : Math.min(TOTAL_CAP_USD, spent() + o.approvedUsd);
  let reserved = 0;
  let stopped: string | null = null;
  const log = (f: string, x: unknown) => appendFileSync(path.join(dir, f), JSON.stringify(x) + "\n");

  // One request, with production's retries: none after a possibly billed failure, up to 2 after a 429 or 529.
  const send = async (id: string, round: number, text: string, pairs: number, mock?: () => string): Promise<string | null | "stopped"> => {
    const worst = worstOf(contract, text, pairs);
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (stopped) return "stopped";
      // Over the ceiling with requests in flight: wait for them to settle (their reservations become actual costs).
      while (!stopped && reserved > 0 && spent() + reserved + worst > ceiling) await new Promise((ok) => setTimeout(ok, 1000));
      if (stopped) return "stopped";
      if (mock) { const t = mock(); log("calls.jsonl", { id, round, attempt, outcome: "ok", mock: true, costUsd: 0 }); return t; }
      if (spent() + reserved + worst > ceiling) { stopped = `stopped before the ceiling: spent $${spent().toFixed(4)}, reserved $${reserved.toFixed(4)}, next request's worst case $${worst.toFixed(4)}, ceiling $${ceiling.toFixed(2)}`; log("calls.jsonl", { id, round, outcome: "stopped_at_cap", detail: stopped }); return "stopped"; }
      reserved += worst;
      try {
        const r = await model.adjudicate(text, pairs);
        const usd = callCost(r.model, tokensFromUsage(r.usage))?.costUsd ?? worst; // an unpriced model counts at its worst case
        await recordCall(db, { jobId: null, stage: "adjudication", model: r.model, usage: r.usage, attempt, items: pairs, rawOutput: r.text, effort: model.effort, latencyMs: r.latencyMs });
        log("calls.jsonl", { at: new Date().toISOString(), id, round, attempt, outcome: "ok", stopReason: r.stopReason, requestId: r.requestId, usage: r.usage, costUsd: usd, latencyMs: r.latencyMs });
        return r.text;
      } catch (e) {
        const f = classifyFailure(e);
        const uncertain = f.billable ? worst : 0;
        log("calls.jsonl", { at: new Date().toISOString(), id, round, attempt, outcome: f.kind, billable: f.billable, uncertainCostUsd: uncertain, error: e instanceof Error ? e.message : String(e) });
        if (f.kind === "spend_limit") { stopped = "provider spend limit"; return "stopped"; }
        if (f.billable || attempt === 3 || (f.kind !== "rate_limited" && f.kind !== "overloaded")) return null;
        await new Promise((ok) => setTimeout(ok, f.retryAfterMs ?? 30_000));
      } finally {
        reserved -= worst;
      }
    }
    return null;
  };

  const jobs: (() => Promise<void>)[] = [];
  if (o.set === "pilot") {
    for (const r of loadPilot().filter((x) => !done.has(x.id))) jobs.push(async () => {
      const text = await send(r.id, 0, r.text, r.pairs);
      if (text === "stopped") return;
      // The experiment's reply format, so its own scorer (stretch/v2/pilot.ts score, repeat.ts) reads this run unchanged.
      log("replies.jsonl", { arm: "stretch-v2", run: 1, id: r.id, recovery: false, text });
    });
  } else {
    for (const r of loadFrozen().filter((x) => x.contract === contract && !done.has(x.id))) jobs.push(async () => {
      const passages = new Map(r.passages);
      let packet = r.packet, text: string | null = r.text;
      for (let round = 0; round <= MAX_RECOVERY_ROUNDS; round++) {
        if (round > 0) {
          const b = buildIssuePacket({ id: r.spec.id, issue: "", items: r.spec.items, pairs: packet.pairs.map((p) => keyOfPair(packet, p.pairId).split("|") as [string, string]), inputTokens: 0 }, passages, { allItems: contract === "stretch-v2" });
          packet = b.packet!;
          text = PACKET_PROMPTS[contract].format(packet);
        }
        const p = packet;
        const reply = await send(r.id, round, text!, packet.pairs.length, o.mock ? () => (contract === "stretch-v2" ? mockStretchReply(p) : mockPacketReply(p)).text : undefined);
        if (reply === "stopped") return;
        log("replies.jsonl", { id: r.id, round, pairs: packet.pairs.map((p) => ({ pairId: p.pairId, key: keyOfPair(packet, p.pairId) })), text: reply });
        const left = unanswered(contract, packet, reply);
        if (!left.length) return;
        // Production's recovery: the same evidence, only the pairs still without an answer.
        packet = { ...packet, pairs: packet.pairs.filter((p) => left.includes(p.pairId)) };
      }
    });
  }
  try {
    let next = 0;
    await Promise.all(Array.from({ length: Math.max(1, o.concurrency) }, async () => { while (next < jobs.length && !stopped) await jobs[next++](); }));
  } finally {
    await pool.end();
    rmSync(lock);
  }
  console.log(`${dir}: total evaluation spend $${spent().toFixed(4)} of $${TOTAL_CAP_USD}${stopped ? `; ${stopped}` : ""}`);
}

// Pairs a reply left without an answer, as production reads it (jobs/caseRun.ts applyReply).
function unanswered(contract: Contract, packet: IssuePacket, text: string | null): string[] {
  if (contract === "stretch-v2") return readStretchReply(packet, text).pairs.filter((p) => p.status === "incomplete").map((p) => p.pairId);
  const v = verifyPacketReply(packet, parseVerdictsLenient(text, VERDICT_SCHEMAS["packet-v1"]));
  return v.pairs.filter((p) => p.status !== "answered" || !p.verdict).map((p) => p.pairId);
}

// ---------------------------------------------------------------- score
type PairResult = { key: string; request: string; status: string; flag: boolean; conflict: boolean; outcome: string | null; citation: string | null; attributionOk: boolean | null };
function readRun(contract: Contract, dir: string, reqs: Frozen[]) {
  const replies = jl<{ id: string; round: number; pairs: { pairId: string; key: string }[]; text: string | null }>(path.join(dir, "replies.jsonl"));
  const results = new Map<string, PairResult>();
  for (const r of reqs.filter((x) => x.contract === contract)) {
    for (const rep of replies.filter((x) => x.id === r.id).sort((a, b) => a.round - b.round)) {
      const keys = new Set(rep.pairs.map((p) => p.pairId));
      const packet = { ...r.packet, pairs: r.packet.pairs.filter((p) => keys.has(p.pairId)) };
      const v = contract === "stretch-v2" ? readStretchReply(packet, rep.text) : null;
      const ver = v ? v.verification : verifyPacketReply(packet, parseVerdictsLenient(rep.text, VERDICT_SCHEMAS["packet-v1"]));
      for (const p of packet.pairs) {
        const key = keyOfPair(r.packet, p.pairId);
        const pv = ver.pairs.find((x) => x.pairId === p.pairId);
        const sp = v?.pairs.find((x) => x.pairId === p.pairId);
        const outcome = pv?.status === "answered" && pv.verdict ? (pv.verdict as { outcome: string }).outcome : null;
        const status = sp ? sp.status : outcome ?? pv?.status ?? "missing";
        if (status === "incomplete" || (!sp && !outcome)) { if (!results.has(`${r.id}|${key}`)) results.set(`${r.id}|${key}`, { key, request: r.id, status, flag: false, conflict: false, outcome: null, citation: null, attributionOk: null }); continue; }
        const flag = sp ? sp.status === "flagged" || sp.status === "flagged_unverified" : FLAG.includes(outcome!);
        const att = pv?.attribution;
        results.set(`${r.id}|${key}`, { key, request: r.id, status, flag, conflict: flag && !!outcome && CONFLICT.includes(outcome), outcome, citation: flag ? (pv?.source?.status ?? "unverified") : null, attributionOk: flag && att ? !!att.a && !!att.b && !att.a.attributionError && !att.b.attributionError : null });
      }
    }
  }
  return [...results.values()];
}

function score(mock = false) {
  const RUNS_ = mock ? path.join(OUT, "mock-runs") : RUNS;
  const reqs = loadFrozen();
  const trace = JSON.parse(readFileSync(path.join(FROZEN, "trace.json"), "utf8")) as { label?: string; truth: string; verified: boolean; pairs: { pair: string }[] }[];
  const labels = trace.filter((t) => t.label);
  const runs = (existsSync(RUNS_) ? readdirSync(RUNS_) : []).filter((d) => d.startsWith("labelled-"));
  const cost = (dir: string) => jl<CallLog>(path.join(RUNS_, dir, "calls.jsonl")).reduce((a, c) => ({ calls: a.calls + (c.outcome === "ok" ? 1 : 0), failures: a.failures + (c.outcome !== "ok" && c.outcome !== "stopped_at_cap" ? 1 : 0), usd: a.usd + (c.costUsd ?? 0) + (c.uncertainCostUsd ?? 0), input: a.input + (c.usage?.input_tokens ?? 0), cacheRead: a.cacheRead + (c.usage?.cache_read_input_tokens ?? 0), cacheWrite: a.cacheWrite + (c.usage?.cache_creation_input_tokens ?? 0), output: a.output + (c.usage?.output_tokens ?? 0) }), { calls: 0, failures: 0, usd: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
  const out: Record<string, unknown> = {};
  const views: Record<string, PairResult[]> = {};
  for (const d of runs) {
    const contract = CONTRACTS.find((c) => d.startsWith(`labelled-${c}-`))!;
    const res = readRun(contract, path.join(RUNS_, d), reqs);
    views[d] = res;
    // Near: a flag that is not on a labelled side pair but has each side within 2 answer groups of a labelled item
    // of that side, in the same deposition (the frozen benchmark's "related" rule). Reported apart, never as detected.
    const at = new Map(reqs.flatMap((r) => r.passages.map(([, p]) => [p.key, { dep: p.depositionId, g: Number(p.groupId) }] as const)));
    const near = (x: string, y: string) => { const a = at.get(x), b = at.get(y); return !!a && !!b && a.dep === b.dep && Math.abs(a.g - b.g) <= 2; };
    const perLabel = labels.map((l) => {
      const keys = new Set(l.pairs.map((p) => p.pair));
      const sideA = [...new Set(l.pairs.map((p) => p.pair.split("|")[0]))], sideB = [...new Set(l.pairs.map((p) => p.pair.split("|")[1]))];
      const nearFlags = res.filter((x) => x.flag && !keys.has(x.key) && (() => { const [p, q] = x.key.split("|"); return (sideA.some((k) => near(k, p)) && sideB.some((k) => near(k, q))) || (sideA.some((k) => near(k, q)) && sideB.some((k) => near(k, p))); })()).map((x) => ({ pair: x.key, request: x.request, outcome: x.outcome, citation: x.citation }));
      const mine = res.filter((x) => keys.has(x.key));
      const by = (set: Frozen["set"]) => mine.filter((x) => reqs.find((r) => r.id === x.request)!.set === set);
      const sum = (xs: PairResult[]) => ({ sidePairsRead: xs.length, flagged: xs.filter((x) => x.flag).length, flaggedVerified: xs.filter((x) => x.flag && x.citation === "verified").length, conflict: xs.filter((x) => x.conflict).length, unanswered: xs.filter((x) => x.status === "incomplete" || x.outcome === null && !x.flag && x.status !== "no_conflict_identified" && x.status !== "unclear").length, outcomes: Object.fromEntries([...groupBy(xs, (x) => x.status)].map(([k, v]) => [k, v.length])) });
      return { label: l.label, truth: l.truth, verified: l.verified, production: sum(by("production")), oracle: sum(by("oracle")), nearFlags };
    });
    const labelled = new Set(labels.flatMap((l) => l.pairs.map((p) => p.pair)));
    const flags = res.filter((x) => x.flag);
    const verifiedPositives = perLabel.filter((l) => l.verified && l.truth === "review_worthy");
    const controls = perLabel.filter((l) => l.verified && l.truth === "no_conflict");
    const c = cost(d);
    const detected = (set: "production" | "oracle") => verifiedPositives.filter((l) => l[set].flagged > 0).map((l) => l.label);
    out[d] = {
      contract, cost: { ...c, usd: +c.usd.toFixed(4), perRequest: +(c.usd / Math.max(1, c.calls)).toFixed(4), perFlag: flags.length ? +(c.usd / flags.length).toFixed(4) : null },
      verifiedPositives: { n: verifiedPositives.length, detectedProduction: detected("production"), detectedOracle: detected("oracle"), detectedAnyVerifiedCitation: verifiedPositives.filter((l) => l.production.flaggedVerified + l.oracle.flaggedVerified > 0).map((l) => l.label) },
      nearOnly: { positives: verifiedPositives.filter((l) => l.production.flagged + l.oracle.flagged === 0 && l.nearFlags.length).map((l) => l.label), controls: controls.filter((l) => l.production.flagged + l.oracle.flagged === 0 && l.nearFlags.length).map((l) => l.label) },
      verifiedControls: { n: controls.length, flaggedProduction: controls.filter((l) => l.production.flagged > 0).map((l) => l.label), flaggedOracle: controls.filter((l) => l.oracle.flagged > 0).map((l) => l.label) },
      unverified: perLabel.filter((l) => !l.verified),
      flags: { total: flags.length, onLabelledPairs: flags.filter((x) => labelled.has(x.key)).length, unlabelled: flags.filter((x) => !labelled.has(x.key)).length, citationVerified: flags.filter((x) => x.citation === "verified").length, attributionOk: flags.filter((x) => x.attributionOk === true).length, attributionChecked: flags.filter((x) => x.attributionOk !== null).length },
      pairsRead: res.length, statuses: Object.fromEntries([...groupBy(res, (x) => x.status)].map(([k, v]) => [k, v.length])),
      perLabel,
    };
  }
  // Repeatability: the same frozen requests, run twice, per contract: pair-level flag agreement and Cohen's kappa.
  const rep: Record<string, unknown> = {};
  for (const c of CONTRACTS) {
    const ds = runs.filter((d) => d.startsWith(`labelled-${c}-`)).sort();
    if (ds.length < 2) continue;
    const [x, y] = [views[ds[0]], views[ds[1]]].map((v) => new Map(v.map((p) => [`${p.request}|${p.key}`, p.flag])));
    const both = [...x.keys()].filter((k) => y.has(k));
    const n = both.length, a = both.filter((k) => x.get(k) && y.get(k)).length, b = both.filter((k) => x.get(k) && !y.get(k)).length, cc = both.filter((k) => !x.get(k) && y.get(k)).length, dd = n - a - b - cc;
    const po = (a + dd) / n, pe = ((a + b) * (a + cc) + (cc + dd) * (b + dd)) / (n * n);
    rep[c] = { runs: ds.slice(0, 2), pairsInBoth: n, flaggedBoth: a, flaggedFirstOnly: b, flaggedSecondOnly: cc, flaggedNeither: dd, agreement: +po.toFixed(3), kappa: pe === 1 ? null : +((po - pe) / (1 - pe)).toFixed(3) };
  }
  const result = { scoredOn: new Date().toISOString(), spentUsd: +spent().toFixed(4), runs: out, repeatability: rep };
  writeFileSync(path.join(OUT, mock ? "score-mock.json" : "score.json"), JSON.stringify(result, null, 1));
  console.log(JSON.stringify(result, (k, v) => (k === "perLabel" ? undefined : v), 1));
}

async function main() {
  const [cmd] = process.argv.slice(2);
  const { values } = parseArgs({ args: process.argv.slice(3), options: { db: { type: "string" }, set: { type: "string" }, contract: { type: "string" }, label: { type: "string" }, "approved-usd": { type: "string" }, execute: { type: "boolean" }, concurrency: { type: "string", default: "3" }, mock: { type: "boolean" }, resume: { type: "boolean" } } });
  if (cmd === "freeze") return freeze(values.db ?? (() => { throw new Error("--db required"); })());
  if (cmd === "plan") return plan();
  if (cmd === "score") return score(!!values.mock);
  if (cmd === "run") {
    const set = values.set === "pilot" ? "pilot" : values.set === "labelled" ? "labelled" : (() => { throw new Error("--set labelled|pilot"); })();
    const contract = (values.contract ?? "stretch-v2") as Contract;
    if (!CONTRACTS.includes(contract)) throw new Error("--contract packet-v1|stretch-v2");
    return run({ set, contract, label: values.label ?? (() => { throw new Error("--label required"); })(), approvedUsd: Number(values["approved-usd"]), execute: !!values.execute, dbName: values.db ?? (() => { throw new Error("--db required"); })(), concurrency: Number(values.concurrency), mock: !!values.mock, resume: !!values.resume });
  }
  throw new Error("usage: accuracy-eval.ts freeze|plan|run|score");
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
