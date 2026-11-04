// Milestone 2: pairwise versus packet adjudication on the same evidence pairs (docs/milestone-2-handoff.md).
//
//   sample   [--out data/eval/packet-pilot-v1.json] [--quota 30] [--seed 1]
//   subset   --from <sample> --packets c1:issue-31,c2:issue-5,... --out <file>
//            Freezes a smaller sample (the calibration) from a frozen one: same inputs, chosen packets only.
//   prepare-db --database pilot|rehearsal
//            Creates that persistent database if it is missing, applies migrations (never drops anything), and
//            loads both corpora's fixture documents once. Tests never touch it: its name doesn't end in _test.
//            Freezes the pilot sample from both frozen corpora's within-case packets: no database, no API.
//   dry-run  [--sample data/eval/packet-pilot-v1.json] [--out data/raw/packet-pilot/dry-run] [--database test|rehearsal]
//            Loads both corpora's fixture documents into TEST_DATABASE_URL (WIPES it), builds every sampled
//            packet and its pairwise requests from stored lines, runs both arms with the label-blind mock
//            model, verifies and scores them, and prices the paid pilot from the actual serialized requests.
//            No API call. The report quotes testimony, so it goes under the git-ignored data/raw/.
//   compare  --runs <dir>,<dir>,... --sample <file> [--out <file under data/raw>]
//            Read-only, no database: scores each run's pairs.json (from rescore) on the same sample's packets
//            (by corpus and packet id, main requests only) with exact-match and review-oriented metrics.
//   rescore  --run <report dir> --database pilot|rehearsal
//            Read-only: rebuilds the run's requests from that database, re-verifies its saved replies and writes
//            pairs.json (every pair's outcome, citations and attribution readings, by arm) into the run folder.
//   run      --sample <file> --approved-usd <n> --execute --database pilot [--arms pairwise,packet] [--out data/raw/packet-pilot/<dir>]
//            The paid pilot: needs ALLOW_PAID_CALLS=true on this command, ANTHROPIC_API_KEY and an approved
//            limit. Reserves each attempt's worst-case cost before sending it and stops before the limit would
//            be crossed; at most one retry per request, on a rate limit or overload; every call is recorded.
//            Run it only with the developer's explicit approval.
//            `run --mock --approved-usd <n> --database rehearsal` drives the same loop (gate, reservations, stop, log,
//            recording) with the label-blind mock instead of the API, in the rehearsal database: no API call.
//            A paid run uses only the pilot database; a rehearsal never does. Calls are recorded in the run's database.
//            --reuse <run dir>: a request identical to one that run answered (same arm, request id and SHA-256 of
//            its text, same model and prompt version) takes that saved reply instead of being sent again.
//            --repeat c1:<id>,...: those packets' requests are sent again, fresh, after the main pass, to measure
//            run-to-run variation; never reused, never scored as results. Main requests go labelled packets first
//            (targets, controls, exploratory, then random), so a stop at the cap loses unlabelled fill first.
//            --plan: print the plan and the finish check, send nothing.

import "dotenv/config";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { classifyFailure } from "../server/src/adjudicate/requests";
import { anthropicPacketAdjudicator, type PacketAdjudicator } from "../server/src/adjudicate/packetModel";
import { buildIssuePacket, pairwisePackets, resolvePassages } from "../server/src/adjudicate/packetLoad";
import { maxOutputTokensFor, PACKET_MODEL, PACKET_PROMPT_VERSION, PACKET_PROMPT_VERSION_V2, PACKET_PROMPT_VERSION_V3, PACKET_PROMPTS, type IssuePacket, type PromptVersionId } from "../server/src/adjudicate/packetPrompt";
import { parseVerdictsLenient, VERDICT_SCHEMAS } from "../server/src/adjudicate/packetSchema";
import { callCost, recordCall, tokensFromUsage } from "../server/src/costs";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { connect, type Database } from "../server/src/db/client";
import { PARSER_VERSION } from "../server/src/ingest";
import { loadEvidenceFixtures, openEvaluationDatabase, type EvidenceFixture } from "../server/src/eval/evidenceFixtures";
import { mockPacketReply, mockPacketReplyV2, mockPacketReplyV3 } from "../server/src/eval/mockPacketModel";
import { costOf, estimateRequestCost, labelFor, scoreArm, selectPilotSample, type PairResult } from "../server/src/eval/packetBenchmark";
import type { FrozenItem, FrozenPair } from "../server/src/retrieve/frozen";
import type { PacketSet } from "../server/src/retrieve/grouping";
import { verifyPacketReply, type AnyPairVerdict } from "../server/src/verify/packet";
import type { PairVerdict, PairVerdictV2 } from "../server/src/adjudicate/packetSchema";

const R = "data/raw/retrieval/round2/agent-6";
// The two corpora, as the Milestone 1 baseline evaluated them (docs/baseline-m1.md).
const CORPORA = {
  c1: { evidence: "real" as const, frozen: `${R}/frozen-v2`, benchmarks: [`${R}/frozen-v2/benchmark.json`, `${R}/heldout-c1v2.json`], packets: "data/raw/retrieval/m1-baseline/eval-c1/packets-pool-triaged-c1v2-default-within-case.json", fixture: "data/eval/evidence-fixtures-v1.json" },
  c2: { evidence: "synthetic" as const, frozen: `${R}/frozen-corpus2-v2`, benchmarks: [`${R}/frozen-corpus2-v2/benchmark.json`], packets: "data/raw/retrieval/m1-baseline/eval-c2/packets-pool-triaged-c2v2-default-within-case.json", fixture: "data/eval/independent-cross-v1-fixture.json" },
};
type CorpusId = keyof typeof CORPORA;
type Arm = "pairwise" | "packet";
const RETRIES = 1; // one retry per request, on a rate limit or overload only
// A model with no price can't be budgeted: refuse rather than count it as free.
const priced = (usd: number | null) => { if (usd === null) throw new Error(`${PACKET_MODEL} has no price in costs/pricing.ts`); return usd; };
// One request's worst case: input at one token per UTF-8 byte of system prompt, request and schema, which
// over-counts real tokens about three to four times and so also covers the cached system prompt's 1.25x
// cache-write rate and the structured-output framing; output at max_tokens; times (1 + retries).
// The contract this invocation runs (--prompt; packet-v1 by default). rescore takes it from the run's report.
let PROMPT: PromptVersionId = PACKET_PROMPT_VERSION;
const contract = () => PACKET_PROMPTS[PROMPT];
// Lenient for every contract: valid verdicts are kept and each malformed one is reported, never dropped.
const parseReply = (text: string | null) => parseVerdictsLenient<AnyPairVerdict>(text, VERDICT_SCHEMAS[PROMPT] as never);
const mockReply = (packet: IssuePacket) => (PROMPT === PACKET_PROMPT_VERSION_V3 ? mockPacketReplyV3(packet) : PROMPT === PACKET_PROMPT_VERSION_V2 ? mockPacketReplyV2(packet) : mockPacketReply(packet));
const schemaTextOf = () => JSON.stringify(contract().jsonSchema);
function estimateOne(r: { text: string; packet: IssuePacket }, retries = 0) {
  return estimateRequestCost({ systemChars: contract().system.length, userChars: r.text.length, schemaChars: schemaTextOf().length, systemBytes: Buffer.byteLength(contract().system), userBytes: Buffer.byteLength(r.text), schemaBytes: Buffer.byteLength(schemaTextOf()), maxOutputTokens: maxOutputTokensFor(r.packet.pairs.length), retries, pairs: r.packet.pairs.length, model: PACKET_MODEL });
}
function worstOf(r: { text: string; packet: IssuePacket }, retries: number) {
  return priced(estimateRequestCost({ systemChars: contract().system.length, userChars: r.text.length, schemaChars: schemaTextOf().length, systemBytes: Buffer.byteLength(contract().system), userBytes: Buffer.byteLength(r.text), schemaBytes: Buffer.byteLength(schemaTextOf()), maxOutputTokens: maxOutputTokensFor(r.packet.pairs.length), retries, pairs: r.packet.pairs.length, model: PACKET_MODEL }).worstCase.usd);
}

const readJson = <T>(p: string) => JSON.parse(readFileSync(p, "utf8")) as T;
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const labelsOf = (c: CorpusId) => CORPORA[c].benchmarks.flatMap((b) => readJson<{ pairs: FrozenPair[] }>(b).pairs);

type Sample = { version: string; createdOn: string; inputs: Record<string, string>; corpora: ReturnType<typeof selectPilotSample>[] };

// The persistent databases, on the same server as DATABASE_URL. Their names never end in _test, so the test
// suite's guards (tests/db/database.ts, openEvaluationDatabase) refuse to wipe them.
const PERSISTENT = { pilot: "deposition_checker_pilot", rehearsal: "deposition_checker_pilot_rehearsal" } as const;
type DatabaseName = "test" | keyof typeof PERSISTENT;
const fixtureCase = (c: CorpusId) => `packet-pilot fixtures ${c}`;

function persistentUrl(name: keyof typeof PERSISTENT) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL names the server the pilot databases live on.");
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = `/${PERSISTENT[name]}`;
  const forbidden = [process.env.DATABASE_URL, process.env.TEST_DATABASE_URL].filter(Boolean).map((u) => new URL(u!).pathname);
  if (url.pathname.endsWith("_test") || forbidden.includes(url.pathname)) throw new Error(`${url.pathname} would share a database with development or tests.`);
  return url.toString();
}

async function prepareDatabase(name: keyof typeof PERSISTENT) {
  const target = persistentUrl(name);
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  try {
    const exists = (await admin.query("select 1 from pg_database where datname = $1", [PERSISTENT[name]])).rowCount;
    if (!exists) await admin.query(`create database "${PERSISTENT[name]}"`);
    console.log(exists ? `${PERSISTENT[name]} exists` : `created ${PERSISTENT[name]}`);
  } finally {
    await admin.end();
  }
  const { db, pool } = connect(target);
  try {
    await migrate(db, { migrationsFolder: "drizzle" });
    for (const c of Object.keys(CORPORA) as CorpusId[]) {
      const found = await db.execute<{ id: number }>(sql`select id from cases where name = ${fixtureCase(c)}`);
      if (found.rows.length) { console.log(`${c}: fixtures already loaded (case ${found.rows[0].id})`); continue; }
      const loaded = await loadEvidenceFixtures(db, readJson(CORPORA[c].fixture));
      await db.execute(sql`update cases set name = ${fixtureCase(c)} where id = ${loaded.caseId}`);
      console.log(`${c}: loaded ${loaded.docId.size} documents into case ${loaded.caseId}`);
    }
  } finally {
    await pool.end();
  }
}

// A loaded corpus's fixture key -> deposition id, found by each fixture file's SHA-256 inside its case. Refuses
// a source-read file stored by another parser revision; resolvePassages still checks every position.
async function fixtureDocIds(db: Database, c: CorpusId): Promise<Map<string, number>> {
  const f = readJson<EvidenceFixture>(CORPORA[c].fixture);
  const rows = (await db.execute<{ id: number; sha: string; parser: string }>(sql`select d.id, d.file_sha256 as sha, d.parser_version as parser from depositions d join cases k on k.id = d.case_id where k.name = ${fixtureCase(c)}`)).rows;
  if (!rows.length) throw new Error(`${c}: no fixtures in this database; run prepare-db first.`);
  const ids = new Map<string, number>();
  for (const [key, d] of Object.entries(f.documents)) {
    const hit = rows.filter((r) => r.sha === d.sha256);
    if (hit.length !== 1) throw new Error(`${c}: ${key} is stored ${hit.length} times (expected once).`);
    // A stored export keeps the revision it was read with (its SHA-256 is checked on load); a file read from source
    // must match the current parser, which the frozen items were built with.
    if (d.loader !== "stored-export" && hit[0].parser !== PARSER_VERSION) throw new Error(`${c}: ${key} was read by ${hit[0].parser}, not ${PARSER_VERSION}; reload the fixtures into a fresh database.`);
    ids.set(key, hit[0].id);
  }
  return ids;
}

function subsetCommand(from: string, packets: string, out: string) {
  const source = readJson<Sample>(from);
  const wanted = packets.split(",").map((x) => x.trim()).filter(Boolean);
  const corpora = source.corpora.map((s) => {
    const ids = wanted.filter((w) => w.startsWith(`${s.corpus}:`)).map((w) => w.slice(s.corpus.length + 1));
    for (const id of ids) if (!s.packetIds.includes(id)) throw new Error(`${s.corpus}:${id} is not in ${from}`);
    const set = readJson<PacketSet>(CORPORA[s.corpus as CorpusId].packets).packets.filter((p) => ids.includes(p.id));
    const labels = labelsOf(s.corpus as CorpusId);
    const covered = [...new Set(set.flatMap((p) => p.pairs.map(([a, b]) => labelFor(labels, a, b)?.id).filter((x): x is string => !!x)))];
    return { ...s, quota: ids.length, packetIds: s.packetIds.filter((id) => ids.includes(id)), reasons: Object.fromEntries(ids.map((id) => [id, s.reasons[id]])), labelledCovered: covered, labelledNotInSample: labels.map((l) => l.id).filter((id) => !covered.includes(id)) };
  });
  const sample: Sample = { version: `${source.version}-subset`, createdOn: new Date().toISOString(), inputs: source.inputs, corpora };
  writeFileSync(out, JSON.stringify({ ...sample, subsetOf: from, subsetOfSha256: sha(from) }, null, 2) + "\n");
  for (const s of corpora) console.log(`${s.corpus}: ${s.packetIds.length} packets; labelled pairs ${s.labelledCovered.join(", ")}`);
  console.log(`Wrote ${out}`);
}

function sampleCommand(out: string, quota: number, seed: number) {
  const inputs: Record<string, string> = {};
  const corpora = (Object.keys(CORPORA) as CorpusId[]).map((c) => {
    const k = CORPORA[c];
    for (const f of [k.packets, ...k.benchmarks, `${k.frozen}/items.json`]) inputs[f] = sha(f);
    return selectPilotSample({ corpus: c, evidence: k.evidence, packets: readJson<PacketSet>(k.packets).packets, labels: labelsOf(c), quota, seed });
  });
  const sample: Sample = { version: "packet-pilot-v1", createdOn: new Date().toISOString(), inputs, corpora };
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(sample, null, 2) + "\n");
  for (const s of corpora) console.log(`${s.corpus} (${s.evidence}): ${s.packetIds.length} packets; labelled pairs in sample ${s.labelledCovered.length}, left out ${s.labelledNotInSample.length}, in no packet ${s.labelledInNoPacket.length}`);
  console.log(`Wrote ${out}`);
}

// reason: why the sample holds the packet (target, control, exploratory, random); repeat: a second, identical
// request sent only to measure run-to-run variation, never scored as a result.
type Request = { arm: Arm; corpus: CorpusId; evidence: "real" | "synthetic"; packetId: string; packet: IssuePacket; text: string; pairKeys: Map<string, [string, string]>; reason?: string; repeat?: boolean };

// Every sampled packet and its pairwise requests, built from stored lines. Failures are counted, never dropped.
async function buildRequests(db: Database, sample: Sample, docIdsOf: (c: CorpusId) => Promise<Map<string, number>>) {
  for (const [f, h] of Object.entries(sample.inputs)) if (sha(f) !== h) throw new Error(`${f} changed since the sample was frozen.`);
  const requests: Request[] = [];
  const unbuilt: { corpus: string; packetId: string; a: string; b: string; reason: string }[] = [];
  const unresolved: { corpus: string; key: string; reason: string }[] = [];
  for (const s of sample.corpora) {
    const c = s.corpus as CorpusId;
    const k = CORPORA[c];
    const docIds = await docIdsOf(c);
    const set = readJson<PacketSet>(k.packets);
    const chosen = set.packets.filter((p) => s.packetIds.includes(p.id));
    const keys = new Set(chosen.flatMap((p) => p.items));
    const items = readJson<FrozenItem[]>(`${k.frozen}/items.json`).filter((i) => keys.has(i.key));
    // packet-v2 loads each passage's adjacent exchanges, keyed back to the frozen items where they exist.
    const groupKey = new Map(readJson<FrozenItem[]>(`${k.frozen}/items.json`).map((i) => [`${i.document}#${i.groupId}`, i.key]));
    const r = await resolvePassages(db, items, docIds, contract().adjacent ? { keyOfGroup: (d, g) => groupKey.get(`${d}#${g}`) ?? null } : undefined);
    unresolved.push(...r.unresolved.map((u) => ({ corpus: c, ...u })));
    for (const p of chosen) {
      const built = buildIssuePacket(p, r.passages);
      unbuilt.push(...built.unbuilt.map((u) => ({ corpus: c, packetId: p.id, ...u })));
      if (!built.packet) continue;
      const byId = new Map(built.packet.passages.map((x) => [x.id, x.key]));
      const keysOf = (q: IssuePacket) => new Map(q.pairs.map((x) => [x.pairId, [byId.get(x.a)!, byId.get(x.b)!] as [string, string]]));
      const reason = s.reasons[p.id];
      requests.push({ arm: "packet", corpus: c, evidence: k.evidence, packetId: p.id, packet: built.packet, text: contract().format(built.packet), pairKeys: keysOf(built.packet), reason });
      for (const one of pairwisePackets(built.packet)) requests.push({ arm: "pairwise", corpus: c, evidence: k.evidence, packetId: p.id, packet: one, text: contract().format(one), pairKeys: keysOf(one), reason });
    }
  }
  return { requests, unbuilt, unresolved };
}

// The paid estimate from the serialized requests: expected and worst case, per arm.
function estimate(requests: Request[]) {
  const schemaChars = schemaTextOf().length;
  const out: Record<string, { requests: number; pairs: number; expectedUsd: number; worstCaseUsd: number; expectedTokens: number; worstCaseTokens: number; maxOutputTokens: number }> = {};
  for (const r of requests) {
    const e = estimateRequestCost({ systemChars: contract().system.length, userChars: r.text.length, schemaChars, systemBytes: Buffer.byteLength(contract().system), userBytes: Buffer.byteLength(r.text), schemaBytes: Buffer.byteLength(schemaTextOf()), maxOutputTokens: maxOutputTokensFor(r.packet.pairs.length), retries: RETRIES, pairs: r.packet.pairs.length, model: PACKET_MODEL });
    const x = (out[r.arm] ??= { requests: 0, pairs: 0, expectedUsd: 0, worstCaseUsd: 0, expectedTokens: 0, worstCaseTokens: 0, maxOutputTokens: 0 });
    x.requests++;
    x.pairs += r.packet.pairs.length;
    x.expectedUsd += priced(e.expected.usd);
    x.worstCaseUsd += priced(e.worstCase.usd);
    x.expectedTokens += e.expected.tokens;
    x.worstCaseTokens += e.worstCase.tokens;
    x.maxOutputTokens += maxOutputTokensFor(r.packet.pairs.length);
  }
  return out;
}

type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
// usage sums every attempt of the request; spentUsd is what the budget charged for them (a failure that may
// have been billed is charged its full reservation).
type Reply = { text: string | null; usage: Usage; spentUsd?: number; stopReason?: string | null; error?: string; attempts: number };

function resultsOf(r: Request, v: ReturnType<typeof verifyPacketReply>): PairResult[] {
  // The item keys shown for a passage: its own and its adjacent exchanges' (packet-v2), for the missed-cause split.
  const shown = (id: string) => { const x = r.packet.passages.find((q) => q.id === id); return x ? [x.key, ...(x.adjacent ?? []).map((a) => a.itemKey).filter((k): k is string => !!k)] : []; };
  return v.pairs.map((p) => {
    const [a, b] = r.pairKeys.get(p.pairId)!;
    const pair = r.packet.pairs.find((q) => q.pairId === p.pairId)!;
    return {
      corpus: r.corpus, evidence: r.evidence, packetId: r.packetId, a, b,
      pairStatus: p.status, outcome: p.semantic?.outcome ?? null, sourceStatus: p.source?.status ?? null,
      // Valid only when both sides verify and nothing failed evidence validation (for example both sides citing
      // one passage): passing source checks alone never makes a classification count as identified.
      citationsValid: p.source !== null && p.validationFailures.length === 0 && ["verified", "approximate"].includes(p.source.a.status) && ["verified", "approximate"].includes(p.source.b.status),
      attributionErrors: [p.attribution?.a, p.attribution?.b].filter((s) => s?.attributionError).length,
      consistencyIssues: p.semantic?.consistencyIssues.length ?? 0,
      semanticValid: p.semantic ? p.semantic.consistencyIssues.length === 0 : undefined,
      shownA: shown(pair.a), shownB: shown(pair.b),
    };
  });
}

function report<E extends Record<string, unknown>>(out: string, mode: string, sample: Sample, requests: Request[], replies: Reply[], arms: ReadonlySet<Arm>, extra: E) {
  const labels = [...labelsOf("c1"), ...labelsOf("c2")];
  // Both arms are scored on the same pairs: a packet counts only when every request of every arm run for it
  // has a reply. Packets left incomplete (the budget stop) are listed, never scored for one arm only.
  const byPacket = new Map<string, number[]>();
  requests.forEach((r, i) => { if (arms.has(r.arm) && !r.repeat) byPacket.set(`${r.corpus}/${r.packetId}`, [...(byPacket.get(`${r.corpus}/${r.packetId}`) ?? []), i]); });
  const complete = new Set([...byPacket].filter(([, is]) => is.every((i) => replies[i])).map(([k]) => k));
  const incompletePackets = [...byPacket.keys()].filter((k) => !complete.has(k));
  const covered = sample.corpora.flatMap((c) => c.labelledCovered.map((id) => ({ corpus: c.corpus, id })));
  const result = {} as Record<Arm, unknown>;
  for (const arm of ["pairwise", "packet"] as Arm[]) {
    if (!arms.has(arm)) continue;
    const idx = requests.map((r, i) => [r, i] as const).filter(([r]) => r.arm === arm && !r.repeat && complete.has(`${r.corpus}/${r.packetId}`));
    const rows: PairResult[] = [];
    const unknownPairIds: { packetId: string; pairIds: string[] }[] = [];
    for (const [r, i] of idx) {
      const reply = replies[i];
      const v = verifyPacketReply(r.packet, reply.error ? { ok: false, error: reply.error } : parseReply(reply.text));
      if (v.unknownPairIds.length) unknownPairIds.push({ packetId: r.packet.id, pairIds: v.unknownPairIds });
      rows.push(...resultsOf(r, v));
    }
    const scored = scoreArm(arm, rows, labels);
    // Labelled pairs the sample holds but this arm has no row for (unbuilt, unresolved or not sent): never silently absent.
    const withRow = new Set(rows.map((x) => labelFor(labels, x.a, x.b)?.id).filter(Boolean));
    const labelledWithoutRow = covered.filter((c) => !withRow.has(c.id)).map((c) => ({ ...c, reason: incompletePackets.some((k) => k.startsWith(`${c.corpus}/`)) ? "its packet was not completed in both arms, or it was unbuilt" : "unbuilt or unresolved (see unbuilt / unresolved)" }));
    const stopReasons: Record<string, number> = {};
    for (const [, i] of idx) stopReasons[String(replies[i].stopReason ?? (replies[i].error ? "error" : "unknown"))] = (stopReasons[String(replies[i].stopReason ?? (replies[i].error ? "error" : "unknown"))] ?? 0) + 1;
    result[arm] = {
      score: scored,
      cost: costOf(arm, idx.map(([, i]) => replies[i].usage), PACKET_MODEL, scored.identifiedTargets),
      spentUsd: idx.reduce((n, [, i]) => n + (replies[i].spentUsd ?? 0), 0),
      attempts: idx.reduce((n, [, i]) => n + replies[i].attempts, 0),
      stopReasons, unknownPairIds, labelledWithoutRow,
    };
  }
  mkdirSync(out, { recursive: true });
  const body = { mode, promptVersion: PROMPT, model: PACKET_MODEL, createdOn: new Date().toISOString(), ...extra, scoredPackets: complete.size, incompletePackets, arms: result };
  writeFileSync(path.join(out, "report.json"), JSON.stringify(body, null, 2));
  writeFileSync(path.join(out, "replies.json"), JSON.stringify(requests.map((r, i) => ({ arm: r.arm, corpus: r.corpus, packetId: r.packet.id, repeat: r.repeat === true, textSha256: createHash("sha256").update(r.text).digest("hex"), reply: replies[i] ?? null }))));
  return body;
}

// The rehearsal's adjudicator: the label-blind mock, shaped like an API reply, priced as the real model would be.
function mockAdjudicator(): PacketAdjudicator {
  let n = 0;
  return {
    model: PACKET_MODEL, promptVersion: PROMPT, effort: "mock",
    async adjudicate(packetText) {
      const packet = mockPackets.get(packetText);
      if (!packet) throw new Error("mock: unknown request");
      const m = mockReply(packet);
      n++;
      const usage = { input_tokens: m.usage.inputTokens, output_tokens: m.usage.outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } as Anthropic.Usage;
      return { model: PACKET_MODEL, stopReason: "end_turn", usage, text: m.text, latencyMs: 0, requestId: `mock-${n}` };
    },
  };
}
const mockPackets = new Map<string, IssuePacket>();

// Whether the run would finish under a cap, replaying the gate in request order: before each request the
// spend so far plus its worst case must fit. Spend is simulated at the expected cost, and again at twice it.
function finishCheck(requests: Request[], cap: number, perPair?: Record<Arm, number>) {
  if (!(cap > 0) || requests.length === 0) return null;
  const simulate = (cost: (r: Request) => number, factor: number) => {
    let spent = 0;
    for (const [i, r] of requests.entries()) {
      if (spent + worstOf(r, 0) > cap) return { finishes: false, stopsAtRequest: i + 1, of: requests.length, spentUsd: round(spent) };
      spent += factor * cost(r);
    }
    return { finishes: true, spentUsd: round(spent), headroomUsd: round(cap - spent) };
  };
  const expected = (r: Request) => priced(estimateOne(r).expected.usd);
  // Measured: the calibration's actual cost per pair in each arm (perPair), applied to these requests.
  const measured = perPair ? (r: Request) => perPair[r.arm] * r.packet.pairs.length : null;
  return {
    capUsd: cap, requests: requests.length,
    atExpected: simulate(expected, 1), atTwiceExpected: simulate(expected, 2),
    ...(measured ? { perPairMeasuredUsd: perPair, atMeasured: simulate(measured, 1), atOneAndHalfMeasured: simulate(measured, 1.5), atTwiceMeasured: simulate(measured, 2) } : {}),
    largestSingleWorstCaseUsd: round(Math.max(...requests.map((r) => worstOf(r, 0)))),
  };
}
const round = (x: number) => Math.round(x * 10_000) / 10_000;

// What a reviewer needs from any contract's verdict: citations per side, stances, details and reasoning.
function verdictView(v: AnyPairVerdict) {
  if ("sideA" in v && typeof v.sideA === "object") return { citationsA: v.sideA.citations, citationsB: v.sideB.citations, stances: [v.sideA.stance, v.sideB.stance], sameEvent: v.sameEvent, scopeAligned: v.scopeAligned, conflictBasis: v.conflictBasis, details: v.details, explanation: v.explanation, alternativeExplanation: v.alternativeExplanation };
  const o = v as PairVerdict | PairVerdictV2;
  return { citationsA: [{ exchangeId: o.evidenceAId, quote: o.keyPhraseA }], citationsB: [{ exchangeId: o.evidenceBId, quote: o.keyPhraseB }], stances: [o.stanceA, o.stanceB], sameEvent: o.sameEvent, scopeAligned: o.scopeAligned, conflictBasis: o.conflictBasis, falsePositiveReason: "falsePositiveReason" in o ? o.falsePositiveReason : null, details: "detailsCompared" in o ? o.detailsCompared : null, explanation: o.explanation, alternativeExplanation: o.alternativeExplanation, contextUsed: o.contextUsed };
}

// Re-verifies a finished run's replies against its database, read-only, and writes every pair's result.
async function rescore(dir: string, name: keyof typeof PERSISTENT) {
  const report = readJson<{ sample: string; sampleSha256: string; promptVersion: PromptVersionId }>(path.join(dir, "report.json"));
  if (sha(report.sample) !== report.sampleSha256) throw new Error(`${report.sample} changed since the run.`);
  PROMPT = report.promptVersion; // a run is re-checked under the contract it was made with
  const saved = readJson<{ arm: Arm; corpus: string; packetId: string; repeat?: boolean; reply: Reply | null }[]>(path.join(dir, "replies.json"));
  const { db, pool } = connect(persistentUrl(name));
  try {
    const { requests } = await buildRequests(db, readJson<Sample>(report.sample), (c) => fixtureDocIds(db, c));
    // A run with repeats or a priority order saved its requests in its own order: rebuild that order.
    const queue = new Map<string, Request[]>();
    for (const r of requests) queue.set(`${r.corpus}|${r.arm}|${r.packet.id}`, [...(queue.get(`${r.corpus}|${r.arm}|${r.packet.id}`) ?? []), r]);
    const ordered = saved.map((x) => { const r = queue.get(`${x.corpus}|${x.arm}|${x.packetId}`)?.[0]; if (!r) throw new Error(`The run's request ${x.arm} ${x.packetId} isn't in its sample.`); return x.repeat ? { ...r, repeat: true } : r; });
    requests.splice(0, requests.length, ...ordered);
    const labels = [...labelsOf("c1"), ...labelsOf("c2")];
    const side = (x: { status: string; reason: string | null; cited?: string; diagnosis?: string; foundIn?: unknown } | undefined, t: { level: string; codeLevel: string; claudeLevel: string; disagreement: string | null; location: string | null; codeRule: string } | null | undefined) => ({ source: x?.status ?? null, sourceReason: x?.reason ?? null, cited: x?.cited ?? null, diagnosis: x?.diagnosis ?? null, foundIn: x?.foundIn ?? null, attribution: t ? { level: t.level, code: t.codeLevel, model: t.claudeLevel, disagreement: t.disagreement, location: t.location, rule: t.codeRule } : null });
    const pairs = requests.flatMap((r, i) => {
      const reply = saved[i].reply;
      if (!reply) return [];
      const v = verifyPacketReply(r.packet, reply.error ? { ok: false, error: reply.error } : parseReply(reply.text));
      return v.pairs.map((p) => {
        const [a, b] = r.pairKeys.get(p.pairId)!;
        const label = labelFor(labels, a, b);
        // For labelled pairs, the testimony and the model's reasoning, so a reviewer can judge why it was missed.
        const passage = (id: string) => { const x = r.packet.passages.find((q) => q.id === id)!; return { id: x.id, witness: x.witnessName, session: x.session, before: x.before.map((l) => `${l.page}:${l.line} ${l.text}`), lines: x.lines.map((l) => `${l.page}:${l.line} [${l.role}] ${l.text}`), after: x.after.map((l) => `${l.page}:${l.line} ${l.text}`), adjacent: (x.adjacent ?? []).map((a) => ({ id: a.id, relation: a.relation, itemKey: a.itemKey, lines: a.lines.map((l) => `${l.page}:${l.line} [${l.role}] ${l.text}`) })) }; };
        const pair = r.packet.pairs.find((q) => q.pairId === p.pairId)!;
        const detail = label && p.verdict ? { passages: [passage(pair.a), passage(pair.b)], verdict: verdictView(p.verdict), semantic: p.semantic, packetSize: r.packet.pairs.length } : null;
        return { arm: r.arm, repeat: r.repeat === true, corpus: r.corpus, packetId: r.packetId, request: r.packet.id, pairId: p.pairId, a, b, label, detail, status: p.status, outcome: p.semantic?.outcome ?? null, attributions: p.verdict ? ("sideA" in p.verdict && typeof p.verdict.sideA === "object" ? [p.verdict.sideA.attribution, p.verdict.sideB.attribution] : [(p.verdict as PairVerdict).attributionA, (p.verdict as PairVerdict).attributionB]) : null, validationFailures: p.validationFailures, semantic: p.semantic ? { consistencyIssues: p.semantic.consistencyIssues, reviewFlags: p.semantic.reviewFlags, requiresReview: p.semantic.requiresReview } : null, sideA: side(p.source?.a, p.attribution?.a), sideB: side(p.source?.b, p.attribution?.b) };
      });
    });
    writeFileSync(path.join(dir, "pairs.json"), JSON.stringify(pairs, null, 2));
    // A fresh report from the saved outputs and the current verifier; the run's own report.json is kept as it was.
    const arms: Record<string, unknown> = {};
    for (const arm of ["pairwise", "packet"] as Arm[]) {
      const idx = requests.map((r, i) => [r, i] as const).filter(([r, i]) => r.arm === arm && !saved[i].repeat && saved[i].reply);
      const rows = idx.flatMap(([r, i]) => resultsOf(r, verifyPacketReply(r.packet, saved[i].reply!.error ? { ok: false, error: saved[i].reply!.error! } : parseReply(saved[i].reply!.text))));
      const scored = scoreArm(arm, rows, labels);
      arms[arm] = { score: scored, cost: costOf(arm, idx.map(([, i]) => saved[i].reply!.usage), PACKET_MODEL, scored.identifiedTargets), reusedRequests: idx.filter(([, i]) => (saved[i].reply as { reusedFrom?: string }).reusedFrom).length };
    }
    // Repeatability: each repeated request's outcomes against the main reply of the identical request.
    // Packet ids repeat across corpora (both have an issue-31): every key includes the corpus.
    const mainOf = new Map(requests.map((r, i) => [r, i] as const).filter(([r, i]) => !saved[i].repeat).map(([r, i]) => [`${r.corpus}|${r.arm}|${r.packet.id}`, i]));
    const repeats = requests.flatMap((r, i) => {
      if (!saved[i].repeat || !saved[i].reply) return [];
      const j = mainOf.get(`${r.corpus}|${r.arm}|${r.packet.id}`);
      if (j === undefined || !saved[j].reply) return [];
      const outcomes = (k: number) => verifyPacketReply(r.packet, saved[k].reply!.error ? { ok: false, error: saved[k].reply!.error! } : parseReply(saved[k].reply!.text)).pairs.map((p) => p.semantic?.outcome ?? p.status);
      const [first, second] = [outcomes(j), outcomes(i)];
      return first.map((o, n) => { const [a, b] = r.pairKeys.get(r.packet.pairs[n].pairId)!; return { arm: r.arm, packetId: r.packetId, request: r.packet.id, pairId: r.packet.pairs[n].pairId, label: labelFor(labels, a, b)?.id ?? null, first: o, second: second[n] }; });
    });
    writeFileSync(path.join(dir, "report-rescored.json"), JSON.stringify({ rescoredOn: new Date().toISOString(), from: path.join(dir, "replies.json"), verifier: "current tree (answer reader with turn markers)", arms, repeats }, null, 2));
    console.log(`${pairs.length} pair results written to ${dir}/pairs.json; fresh report ${dir}/report-rescored.json (${repeats.length} repeated pair outcomes)`);
  } finally {
    await pool.end();
  }
}

// Scores several finished runs on one sample from their saved pair results. Pure reads; no database or model.
type SavedPair = { arm: Arm; repeat?: boolean; corpus: string; packetId: string; a: string; b: string; status: PairResult["pairStatus"]; outcome: PairResult["outcome"]; validationFailures: string[]; sideA: { source: string | null; attribution: { disagreement: string | null } | null }; sideB: SavedPair["sideA"]; semantic: { consistencyIssues: string[] } | null; shownA?: string[] };
function compareRuns(dirs: string[], samplePath: string, out?: string) {
  const sample = readJson<Sample>(samplePath);
  const inSample = new Set(sample.corpora.flatMap((c) => c.packetIds.map((p) => `${c.corpus}/${p}`)));
  const labels = [...labelsOf("c1"), ...labelsOf("c2")];
  const ok = (x: string | null) => x === "verified" || x === "approximate";
  const result = dirs.map((dir) => {
    const report = readJson<{ promptVersion: string }>(path.join(dir, "report.json"));
    const rows = readJson<SavedPair[]>(path.join(dir, "pairs.json")).filter((p) => !p.repeat && inSample.has(`${p.corpus}/${p.packetId}`));
    const arms = Object.fromEntries((["packet", "pairwise"] as Arm[]).map((arm) => {
      const res: PairResult[] = rows.filter((p) => p.arm === arm).map((p) => ({
        corpus: p.corpus, evidence: CORPORA[p.corpus as CorpusId].evidence, packetId: p.packetId, a: p.a, b: p.b, pairStatus: p.status, outcome: p.outcome,
        sourceStatus: (p.sideA.source ?? null) as PairResult["sourceStatus"], citationsValid: ok(p.sideA.source) && ok(p.sideB.source) && p.validationFailures.length === 0,
        attributionErrors: [p.sideA, p.sideB].filter((x) => x.attribution?.disagreement).length, consistencyIssues: p.semantic?.consistencyIssues.length ?? 0,
        semanticValid: p.semantic ? p.semantic.consistencyIssues.length === 0 : undefined,
      }));
      const c = scoreArm(arm, res, labels).evidence.combined;
      return [arm, { pairs: res.length, identified: c.identifiedTargets, identifiedStrict: c.identifiedStrict.length, flaggedControls: c.flaggedControls, exactMatch: c.exactMatch, review: c.review, invalidCitationPairs: res.filter((x) => x.pairStatus === "answered" && !x.citationsValid && x.sourceStatus !== "not_cited").length, unanswered: res.filter((x) => x.pairStatus !== "answered").length }];
    }));
    return { run: dir, promptVersion: report.promptVersion, arms };
  });
  const body = { sample: samplePath, sampleSha256: sha(samplePath), comparedOn: new Date().toISOString(), runs: result };
  if (out) {
    if (!path.resolve(out).startsWith(path.resolve("data/raw") + path.sep)) throw new Error("Write comparisons under data/raw/.");
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(body, null, 2));
  }
  for (const r of result) for (const [arm, x] of Object.entries(r.arms) as [string, any][]) {
    const t = x.review.targets; const k = x.review.controls;
    console.log(`${r.promptVersion} ${arm}: identified ${x.identified} (strict ${x.identifiedStrict}) | targets: contradiction ${t.correctContradiction.length}, review ${t.surfacedForReview.length}, appropriate uncertainty ${t.appropriateUncertainty.length}, unsupported ${t.unsupportedEvidence.length}, missed ${t.missed.length} | controls: incorrect contradiction ${k.incorrectContradiction.length}, review ${k.surfacedForReview.length}, correct ${k.correct.length} | exact ${JSON.stringify(x.exactMatch)} | invalid-citation pairs ${x.invalidCitationPairs}, unanswered ${x.unanswered}`);
  }
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { out: { type: "string" }, sample: { type: "string" }, quota: { type: "string" }, seed: { type: "string" }, "approved-usd": { type: "string" }, execute: { type: "boolean" }, mock: { type: "boolean" }, arms: { type: "string" }, database: { type: "string" }, from: { type: "string" }, packets: { type: "string" }, run: { type: "string" }, runs: { type: "string" }, reuse: { type: "string" }, repeat: { type: "string" }, plan: { type: "boolean" }, prompt: { type: "string" } } });
  if (values.prompt !== undefined) {
    if (values.prompt !== PACKET_PROMPT_VERSION && values.prompt !== PACKET_PROMPT_VERSION_V2 && values.prompt !== PACKET_PROMPT_VERSION_V3) throw new Error(`--prompt must be ${PACKET_PROMPT_VERSION}, ${PACKET_PROMPT_VERSION_V2} or ${PACKET_PROMPT_VERSION_V3}`);
    PROMPT = values.prompt;
  }
  const command = positionals[0];
  const samplePath = values.sample ?? "data/eval/packet-pilot-v1.json";
  if (command === "sample") return sampleCommand(values.out ?? samplePath, Number(values.quota ?? 30), Number(values.seed ?? 1));
  if (command === "subset") {
    if (!values.from || !values.packets || !values.out) throw new Error("subset needs --from, --packets and --out");
    return subsetCommand(values.from, values.packets, values.out);
  }
  if (command === "prepare-db") {
    if (values.database !== "pilot" && values.database !== "rehearsal") throw new Error("prepare-db needs --database pilot|rehearsal");
    return prepareDatabase(values.database);
  }
  if (command === "compare") {
    if (!values.runs || !values.sample) throw new Error("compare needs --runs <dir>,<dir> and --sample <file>");
    return compareRuns(values.runs.split(","), values.sample, values.out);
  }
  if (command === "rescore") {
    if (!values.run || (values.database !== "pilot" && values.database !== "rehearsal")) throw new Error("rescore needs --run <report dir> and --database pilot|rehearsal");
    return rescore(values.run, values.database);
  }
  if (command !== "dry-run" && command !== "run") throw new Error("usage: packet-benchmark.ts sample|subset|prepare-db|rescore|dry-run|run (see the header)");
  const database = (values.database ?? (command === "dry-run" ? "test" : "")) as DatabaseName;
  if (!["test", "pilot", "rehearsal"].includes(database)) throw new Error("run needs --database pilot (paid) or rehearsal (--mock)");
  if (command === "run" && values.execute && database !== "pilot") throw new Error("A paid run uses only the pilot database.");
  if (database === "pilot" && !(command === "run" && (values.execute || values.plan))) throw new Error("The pilot database is only for the paid run; rehearse with --database rehearsal.");
  if (command === "run" && database === "test") throw new Error("A run records its calls: use a persistent database, not the wiped test one.");
  const out = values.out ?? `data/raw/packet-pilot/${command === "run" ? `run-${Date.now()}` : "dry-run"}`;
  if (!path.resolve(out).startsWith(path.resolve("data/raw") + path.sep)) throw new Error("Reports quote testimony: write them under data/raw/.");

  if (command === "run") {
    const approved = Number(values["approved-usd"]);
    if (!(approved > 0)) throw new Error("run needs --approved-usd <limit> (the developer's approval).");
    if (values.mock && values.execute) throw new Error("--mock and --execute exclude each other.");
    if (!values.mock && !values.plan) {
      if (!values.execute) throw new Error("run needs --execute (or --mock for an offline rehearsal, or --plan).");
      if (process.env.ALLOW_PAID_CALLS !== "true") throw new Error("run needs ALLOW_PAID_CALLS=true on this command.");
      if (!process.env.ANTHROPIC_API_KEY) throw new Error("run needs ANTHROPIC_API_KEY.");
    }
  }

  const sample = readJson<Sample>(samplePath);
  // test: wiped and loaded fresh. pilot / rehearsal: persistent, prepared once by prepare-db, never wiped.
  const { db, pool } = database === "test" ? await openEvaluationDatabase(process.env.TEST_DATABASE_URL) : connect(persistentUrl(database));
  const docIdsOf = database === "test" ? async (c: CorpusId) => (await loadEvidenceFixtures(db, readJson(CORPORA[c].fixture))).docId : (c: CorpusId) => fixtureDocIds(db, c);
  try {
    const { requests, unbuilt, unresolved } = await buildRequests(db, sample, docIdsOf);
    const est = estimate(requests);
    const total = { expectedUsd: Object.values(est).reduce((n, x) => n + x.expectedUsd, 0), worstCaseUsd: Object.values(est).reduce((n, x) => n + x.worstCaseUsd, 0) };
    const extra = { sample: samplePath, sampleSha256: sha(samplePath), database: database === "test" ? "test (wiped)" : PERSISTENT[database], requests: requests.length, unbuilt, unresolved, estimate: est, estimateTotal: total, finish: finishCheck(requests, Number(values["approved-usd"] ?? 0)) };

    if (command === "dry-run") {
      const replies: Reply[] = requests.map((r) => {
        const m = mockReply(r.packet);
        return { text: m.text, usage: m.usage, attempts: 1 };
      });
      const body = report(out, "dry-run (label-blind mock model: measures the pipeline, never model quality)", sample, requests, replies, new Set<Arm>(["pairwise", "packet"]), extra);
      console.log(JSON.stringify({ requests: body.requests, unbuilt: unbuilt.length, unresolved: unresolved.length, estimate: est, estimateTotal: total, finish: extra.finish }, null, 2));
      console.log(`Report: ${out}/report.json`);
      return;
    }

    // The paid run: a worst-case reservation before every attempt, never past the approved limit. Calls are
    // recorded in the run's own persistent database and appended to calls.jsonl under the report folder as
    // they happen, failures included.
    const approved = Number(values["approved-usd"]);
    const arms = new Set((values.arms ?? "pairwise,packet").split(",") as Arm[]);
    // Labelled packets first; Array.prototype.sort is stable, so each packet keeps its requests together.
    const PRIORITY: Record<string, number> = { target: 0, control: 1, exploratory: 2, random: 3 };
    requests.sort((x, y) => (PRIORITY[x.reason ?? "random"] ?? 3) - (PRIORITY[y.reason ?? "random"] ?? 3));
    // Repeats: the listed packets' requests again, after the main pass.
    const repeatIds = (values.repeat ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    for (const id of repeatIds) if (!requests.some((r) => `${r.corpus}:${r.packetId}` === id)) throw new Error(`--repeat ${id} is not in the sample.`);
    const main = requests.length;
    for (const id of repeatIds) for (const r of requests.slice(0, main).filter((x) => `${x.corpus}:${x.packetId}` === id)) requests.push({ ...r, repeat: true });
    // Reuse: identical requests a previous run already answered.
    const reused = new Map<number, Reply & { reusedFrom: string }>();
    let perPair: Record<Arm, number> | undefined;
    if (values.reuse) {
      const prev = readJson<{ model: string; promptVersion: string; arms: Record<Arm, { spentUsd: number; score: { evidence: { combined: { total: number } } } }> }>(path.join(values.reuse, "report.json"));
      if (prev.model !== PACKET_MODEL || prev.promptVersion !== PROMPT) throw new Error(`${values.reuse} used ${prev.model} ${prev.promptVersion}, not ${PACKET_MODEL} ${PROMPT}.`);
      const saved = readJson<{ arm: Arm; packetId: string; repeat?: boolean; textSha256?: string; reply: Reply | null }[]>(path.join(values.reuse, "replies.json"));
      // Older runs saved no text hash: rebuild that run's requests from its own sample to get them.
      const prevReport = readJson<{ sample: string; sampleSha256: string }>(path.join(values.reuse, "report.json"));
      if (sha(prevReport.sample) !== prevReport.sampleSha256) throw new Error(`${prevReport.sample} changed since ${values.reuse}.`);
      const prevRequests = saved.some((x) => !x.textSha256) ? (await buildRequests(db, readJson<Sample>(prevReport.sample), docIdsOf)).requests : null;
      const textHash = (t: string) => createHash("sha256").update(t).digest("hex");
      const answered = new Map<string, Reply>();
      saved.forEach((x, j) => {
        const h = x.textSha256 ?? (prevRequests && prevRequests[j]?.packet.id === x.packetId ? textHash(prevRequests[j].text) : null);
        if (!x.repeat && h && x.reply && !x.reply.error && x.reply.stopReason === "end_turn") answered.set(`${x.arm}|${x.packetId}|${h}`, x.reply);
      });
      requests.forEach((r, i) => {
        const hit = !r.repeat && answered.get(`${r.arm}|${r.packet.id}|${textHash(r.text)}`);
        if (hit) reused.set(i, { ...hit, spentUsd: 0, attempts: 0, reusedFrom: values.reuse! });
      });
      perPair = Object.fromEntries((["pairwise", "packet"] as Arm[]).map((a) => [a, prev.arms[a].spentUsd / prev.arms[a].score.evidence.combined.total])) as Record<Arm, number>;
    }
    for (const r of requests) mockPackets.set(r.text, r.packet);
    const sent = requests.filter((r, i) => arms.has(r.arm) && !reused.has(i));
    const plan = {
      mainRequests: main, reusedRequests: reused.size, repeatRequests: requests.length - main, toSend: sent.length,
      toSendByArm: Object.fromEntries((["pairwise", "packet"] as Arm[]).map((a) => [a, sent.filter((r) => r.arm === a).length])),
      repeatPackets: repeatIds, finish: finishCheck(sent, approved, perPair),
    };
    console.log(`Plan: ${JSON.stringify(plan, null, 2)}`);
    if (values.plan) return;
    const totalWorst = sent.reduce((n, r) => n + worstOf(r, RETRIES), 0);
    console.log(`Approved $${approved}; worst case for every request with a retry $${totalWorst.toFixed(2)}. The run stops before any attempt that could pass the approved limit; packets left incomplete are not scored.`);
    console.log(`Finish check: ${JSON.stringify(extra.finish)}`);
    const record = { db, pool: null as pg.Pool | null };
    mkdirSync(out, { recursive: true });
    const log = (entry: Record<string, unknown>) => appendFileSync(path.join(out, "calls.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
    const adjudicator: PacketAdjudicator = values.mock ? mockAdjudicator() : anthropicPacketAdjudicator(new Anthropic({ maxRetries: 0 }), PROMPT);
    let spent = 0;
    let stopped: string | null = null;
    const replies: Reply[] = [];
    try {
      // Requests are ordered packet by packet (the packet request, then its pairwise requests), so a stop
      // leaves at most one packet incomplete.
      for (const [i, r] of requests.entries()) {
        if (!arms.has(r.arm) || stopped) continue;
        const prior = reused.get(i);
        if (prior) { replies[i] = prior; log({ arm: r.arm, packetId: r.packet.id, outcome: "reused", reusedFrom: prior.reusedFrom }); continue; }
        const worst = worstOf(r, 0);
        const usage: Required<Usage> = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
        let charged = 0;
        let attempts = 0;
        for (;;) {
          if (spent + worst > approved) { stopped = `the next attempt's worst case ($${worst.toFixed(4)}) would pass the approved $${approved} (spent $${spent.toFixed(4)})`; break; }
          attempts++;
          let res: Awaited<ReturnType<PacketAdjudicator["adjudicate"]>>;
          try {
            res = await adjudicator.adjudicate(r.text, r.packet.pairs.length);
          } catch (e) {
            const f = classifyFailure(e);
            const cost = f.billable ? worst : 0; // a failure that may have been billed counts in full
            spent += cost;
            charged += cost;
            log({ arm: r.arm, packetId: r.packet.id, repeat: r.repeat === true, attempt: attempts, outcome: "failed", kind: f.kind, billable: f.billable, chargedUsd: cost, error: (e as Error).message });
            if ((f.kind === "rate_limited" || f.kind === "overloaded") && attempts <= RETRIES) { await new Promise((ok) => setTimeout(ok, f.retryAfterMs ?? 5_000)); continue; }
            replies[i] = { text: null, usage, spentUsd: charged, error: `${f.kind}: ${(e as Error).message}`, attempts };
            break;
          }
          // The reply is paid for: count it and keep it before anything that could fail.
          const t = tokensFromUsage(res.usage);
          const cost = callCost(res.model, t)?.costUsd ?? worst; // an unpriced model counts its full reservation
          spent += cost;
          charged += cost;
          usage.inputTokens += t.input; usage.outputTokens += t.output; usage.cacheReadTokens += t.cacheRead; usage.cacheWriteTokens += t.cacheWrite5m + t.cacheWrite1h;
          replies[i] = { text: res.text, usage, spentUsd: charged, stopReason: res.stopReason, attempts };
          log({ arm: r.arm, packetId: r.packet.id, repeat: r.repeat === true, attempt: attempts, outcome: "ok", stopReason: res.stopReason, requestId: res.requestId, usage: res.usage, costUsd: cost });
          try {
            await recordCall(record.db, { jobId: null, stage: "adjudication", model: res.model, usage: res.usage, attempt: attempts, items: r.packet.pairs.length, rawOutput: res.text, effort: adjudicator.effort, latencyMs: res.latencyMs });
          } catch (e) {
            log({ arm: r.arm, packetId: r.packet.id, attempt: attempts, outcome: "record_failed", error: (e as Error).message });
          }
          break;
        }
        console.log(`${i + 1}/${requests.length} ${r.repeat ? "repeat " : ""}${r.arm} ${r.packet.id}: spent $${spent.toFixed(4)}`);
      }
    } finally {
      await record.pool?.end();
    }
    const body = report(out, values.mock ? "rehearsal (mock adjudicator, no API call)" : "paid pilot", sample, requests, replies, arms, { ...extra, plan, approvedUsd: approved, worstCaseAllRequestsUsd: totalWorst, spentUsd: spent, stopped, notSent: sent.filter((r) => !replies[requests.indexOf(r)]).length, repeatsAnswered: requests.filter((r, i) => r.repeat && replies[i]).length });
    console.log(JSON.stringify({ spentUsd: spent, stopped, notSent: body.notSent, scoredPackets: body.scoredPackets, incompletePackets: body.incompletePackets.length }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
