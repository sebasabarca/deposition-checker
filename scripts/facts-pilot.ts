// The Stage 2 real-model pilots (data/eval/facts-pilot-v<n>.json): the production extractor on a few fixed
// source windows, under a hard budget, then compared with the hand-authored records written before them.
// --set names the pilot's file (default: the first pilot); each pilot runs one extractor version, writes to
// its own directory and budget, and never reads another pilot's facts.
//
//   npx tsx scripts/facts-pilot.ts plan [--set <file>] [--json]
//     Resolves the windows, lists their source ranges and units, and estimates requests, tokens and cost.
//     No model call, no writes except the plan file under data/raw/pilot/.
//   npx tsx scripts/facts-pilot.ts run --set <file> --approved-usd <the pilot's limit> --execute
//     PAID: needs ALLOW_PAID_CALLS=true and ANTHROPIC_API_KEY. Extracts each document's window units on its
//     own (one document per request), then repeats the repeat window once without storing its facts.
//     Every request reserves its worst case from the pilot's budget; nothing is sent past it.
//   npx tsx scripts/facts-pilot.ts report [--set <file>]
//     Re-reads the stored pilot results and writes the evaluation report. No model call.
//
// Reports quote testimony and model output: they are written only under the git-ignored data/raw/.

import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { anthropicFactModel } from "../server/src/claims";
import { batchUnits, buildUnits, estimateFacts, extractFacts, FACT_EXTRACTOR_VERSION, FACT_MAX_OUTPUT_TOKENS, FACTS_MODEL, FACTS_PROMPT_VERSION, formatBatch, loadDocument, readFacts, type Unit } from "../server/src/claims/facts";
import { MAX_BATCH_CHARS, requestChars } from "../server/src/claims/facts/prompt";
import { factsJsonSchema } from "../server/src/claims/facts/contracts";
import { budgetStatus, closeFailed, ensureBudget, inputTokenBound, maxRequestCost, recordCall, reserve, settle } from "../server/src/costs";
import { connect, type Database } from "../server/src/db/client";
import { budgets, cases, depositions, factUnits, facts, lines, llmCalls } from "../server/src/db/schema";
import { readEvidenceFixture } from "../server/src/eval/evidenceFixtures";
import { readFactExpectations, type ExpectedFact } from "../server/src/eval/factFixtures";
import { compatibility } from "../server/src/claims/facts";
import { contentTokens, isYesNoQuestion } from "../server/src/claims/facts/contracts";
const readFactExpectationsPairs = () => readFactExpectations().pairs;
import { paidCallsAllowed } from "../server/src/jobs";

type Window = { id: string; issue: string; document: string; case: string; from: string; to: string; heldOut?: boolean };
type Pilot = { set: string; extractorVersion: string; out: string; unitsPerBatch?: number; neighbourGroups: number; budget: { name: string; limitUsd: number }; windows: Window[]; repeat: string };
const { values, positionals } = parseArgs({ allowPositionals: true, options: { set: { type: "string" }, "approved-usd": { type: "string" }, execute: { type: "boolean" }, json: { type: "boolean" } } });
const PILOT = JSON.parse(readFileSync(values.set ?? "data/eval/facts-pilot-v1.json", "utf8")) as Pilot;
const OUT = PILOT.out;
const VERSION = PILOT.extractorVersion;
const order = (pos: string) => { const [p, l] = pos.split(":").map(Number); return p * 1e6 + l; };

// Each window's document (by SHA-256 within its case, active copies only) and units.
async function resolve(db: Database) {
  const fixture = readEvidenceFixture();
  const docs = new Map<string, { id: number; units: Unit[] }>();
  const windows = [];
  for (const w of PILOT.windows) {
    const key = `${w.case}|${w.document}`;
    if (!docs.has(key)) {
      const sha = fixture.documents[w.document].sha256;
      const found = await db.select({ id: depositions.id }).from(depositions).innerJoin(cases, eq(cases.id, depositions.caseId)).where(and(eq(cases.name, w.case), eq(depositions.fileSha256, sha), eq(depositions.status, "ready"), isNull(depositions.excludedReason)));
      if (found.length !== 1) throw new Error(`${w.id}: ${found.length} active copies of ${w.document} in "${w.case}"; exactly one is needed.`);
      docs.set(key, { id: found[0].id, units: buildUnits(await loadDocument(db, found[0].id)) });
    }
    const { id, units } = docs.get(key)!;
    const hit = units.map((u, i) => (u.spans.some((s) => order(s.position) >= order(w.from) && order(s.position) <= order(w.to)) ? i : -1)).filter((i) => i >= 0);
    if (!hit.length) throw new Error(`${w.id}: no unit holds ${w.from}-${w.to}`);
    const groups = [...new Set(units.map((u) => u.groupId))];
    const g0 = groups.indexOf(units[hit[0]].groupId);
    const g1 = groups.indexOf(units[hit[hit.length - 1]].groupId);
    const chosen = new Set(groups.slice(Math.max(0, g0 - PILOT.neighbourGroups), g1 + PILOT.neighbourGroups + 1));
    const mine = units.filter((u) => chosen.has(u.groupId));
    windows.push({ ...w, documentId: id, units: mine, sourceRange: `${mine[0].spans[0].ref} to ${mine.at(-1)!.spans.at(-1)!.ref}` });
  }
  return windows;
}

// Units of one document across its windows, once each, in order.
const unitsOf = (ws: Awaited<ReturnType<typeof resolve>>, documentId: number) => [...new Map(ws.filter((w) => w.documentId === documentId).flatMap((w) => w.units).map((u) => [u.unitKey, u])).values()];

async function plan(db: Database) {
  const ws = await resolve(db);
  const documentIds = [...new Set(ws.map((w) => w.documentId))];
  const perDocument = documentIds.map((id) => ({ documentId: id, estimate: estimateFacts(batchUnits(unitsOf(ws, id), MAX_BATCH_CHARS, PILOT.unitsPerBatch)) }));
  const repeat = estimateFacts(batchUnits(ws.find((w) => w.id === PILOT.repeat)!.units, MAX_BATCH_CHARS, PILOT.unitsPerBatch));
  const all = [...perDocument.map((d) => d.estimate), repeat];
  const total = { requests: all.reduce((n, e) => n + e.batches, 0), units: all.reduce((n, e) => n + e.units, 0), inputTokens: all.reduce((n, e) => n + e.inputTokens, 0), plannedOutputTokens: Math.round(all.reduce((n, e) => n + e.inputTokens, 0) * 1.5), expectedUsd: all.reduce((n, e) => n + e.expectedUsd, 0), worstCaseUsd: all.reduce((n, e) => n + e.worstCaseUsd, 0) };
  const result = {
    model: FACTS_MODEL, promptVersion: FACTS_PROMPT_VERSION, extractorVersion: VERSION, maxOutputTokensPerRequest: FACT_MAX_OUTPUT_TOKENS, budget: PILOT.budget,
    windows: ws.map((w) => ({ id: w.id, issue: w.issue, document: w.document, documentId: w.documentId, anchor: `${w.from}-${w.to}`, sourceRange: w.sourceRange, units: w.units.length, groups: new Set(w.units.map((u) => u.groupId)).size })),
    perDocument, repeat: { window: PILOT.repeat, estimate: repeat }, total, withinCap: total.worstCaseUsd <= PILOT.budget.limitUsd,
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/plan.json`, JSON.stringify(result, null, 2));
  return { result, ws };
}

async function run(db: Database) {
  const usd = Number(values["approved-usd"]);
  if (!values.execute || usd !== PILOT.budget.limitUsd) throw new Error(`run makes paid calls: it needs --execute and --approved-usd ${PILOT.budget.limitUsd}`);
  if (VERSION !== FACT_EXTRACTOR_VERSION) throw new Error(`${PILOT.set} ran ${VERSION}; the code is ${FACT_EXTRACTOR_VERSION}. A finished pilot is never re-run.`);
  if (!paidCallsAllowed(process.env)) throw new Error("Paid calls are off: set ALLOW_PAID_CALLS=true and ANTHROPIC_API_KEY for this command only, with approval.");
  const { result, ws } = await plan(db);
  if (!result.withinCap) throw new Error(`The worst case $${result.total.worstCaseUsd.toFixed(4)} exceeds the $${PILOT.budget.limitUsd} cap; nothing was sent.`);
  const budgetId = await ensureBudget(db, PILOT.budget.name, PILOT.budget.limitUsd);
  const model = anthropicFactModel();
  const runs = [];
  // Each document on its own: its requests carry only its own testimony.
  for (const documentId of [...new Set(ws.map((w) => w.documentId))]) {
    const only = new Set(unitsOf(ws, documentId).map((u) => u.unitKey));
    runs.push({ documentId, result: await extractFacts(db, documentId, model, { budgetId, only, concurrency: 1, unitsPerBatch: PILOT.unitsPerBatch }) });
  }
  // The repeat: the same window sent again as a fresh request, its reading kept for comparison only.
  const units = ws.find((w) => w.id === PILOT.repeat)!.units;
  const repeats = [];
  for (const batch of batchUnits(units, MAX_BATCH_CHARS, PILOT.unitsPerBatch)) {
    const reservation = await reserve(db, budgetId, maxRequestCost(model.model, { inputTokens: inputTokenBound(requestChars(batch)), maxOutputTokens: FACT_MAX_OUTPUT_TOKENS }), `stage2 pilot repeat ${PILOT.repeat}`);
    let reply;
    try {
      reply = await model.extract(formatBatch(batch), factsJsonSchema(batch.length));
    } catch (error) {
      await closeFailed(db, reservation, error);
      throw error;
    }
    const call = await recordCall(db, { jobId: null, stage: "fact_extraction", model: model.model, usage: reply.usage, attempt: 2, items: batch.length, rawOutput: reply.text, effort: "low" });
    await settle(db, reservation, call);
    const reading = readFacts(batch, reply, new Set());
    repeats.push({ llmCallId: call.id, stopReason: reply.stopReason, reading });
  }
  writeFileSync(`${OUT}/repeat.json`, JSON.stringify(repeats, (k, v) => (k === "spans" ? (v as { position: string }[]).map((s) => s.position) : v), 2));
  writeFileSync(`${OUT}/runs.json`, JSON.stringify(runs, null, 2));
  return report(db);
}

// What the pilot produced, against the records written before it. Automatic flags only point the reader
// at likely matches; whether an extraction is right is judged by reading it.
async function report(db: Database) {
  const ws = await resolve(db);
  const expected = readFactExpectations().facts;
  const documentIds = [...new Set(ws.map((w) => w.documentId))];
  const stored = await db.select().from(facts).where(and(inArray(facts.depositionId, documentIds), eq(facts.extractorVersion, VERSION)));
  const lineRows = stored.length ? await db.select({ id: lines.id, page: lines.printedPage, line: lines.lineNo }).from(lines).where(inArray(lines.id, [...new Set(stored.flatMap((f) => f.lineIds))])) : [];
  const pos = new Map(lineRows.map((l) => [l.id, `${l.page}:${l.line}`]));
  const windowOf = (f: (typeof stored)[number]) => ws.filter((w) => w.documentId === f.depositionId && w.units.some((u) => u.unitKey === f.unitKey)).map((w) => w.id);
  const factView = (f: (typeof stored)[number]) => ({ id: f.id, windows: windowOf(f), status: f.status, rejectionReason: f.rejectionReason, positions: f.lineIds.map((id) => pos.get(id)), kind: f.kind, evidencePhrase: f.evidencePhrase, subject: f.subject, entities: f.entities, predicate: f.predicate, attribute: f.attribute, object: f.object, valuePhrase: f.valuePhrase, valueSupport: f.valueSupport, semanticStatus: f.semanticStatus, reviewReasons: f.reviewReasons, factualQuestion: f.factualQuestion, dimension: f.factualDimension, polarity: f.polarity, epistemic: f.epistemicStatus, reportedSpeaker: f.reportedSpeaker, hedges: f.hedges, timeContext: f.timeContext, event: f.event, provenance: f.provenance, attribution: f.attributionStatus, source: f.sourceVerification, warnings: f.warnings });
  const views = stored.map(factView);
  const docOf = (e: ExpectedFact) => ws.find((w) => w.document === e.document)!.documentId;
  const inWindows = expected.filter((e) => ws.some((w) => w.document === e.document && w.units.some((u) => e.spans.every((p) => u.spans.some((s) => s.position === p)))));
  const critical = inWindows.map((e) => {
    const near = views.filter((v) => stored.find((s) => s.id === v.id)!.depositionId === docOf(e) && v.positions.some((p) => e.spans.includes(p!)));
    return { expected: { id: e.id, case: e.case, heldOut: ws.some((w) => w.heldOut && w.document === e.document && w.units.some((u) => e.spans.every((p) => u.spans.some((s) => s.position === p)))), spans: e.spans, dimension: e.dimension, object: e.object, polarity: e.polarity, epistemic: e.epistemic, reportedSpeaker: e.reportedSpeaker }, extracted: near };
  });
  // Measured separately. recall: an indexed fact on the record's lines that carries its value (the
  // value's distinguishing words) or, for a yes/no or memory record, its polarity and kind; automatic,
  // so it only finds candidates; whether one is right is the review sheet's question. compatibility: of
  // the pairs' candidates, by compatibility(). sourceValidity: what code's checks said of every fact.
  const indexedViews = views.filter((v) => v.status === "indexed");
  // Records expected to be rejected (an attorney's unadopted question) are controls, not facts to recall.
  const recall = critical.filter((c) => expected.find((x) => x.id === c.expected.id)!.expect.status === "indexed").map((c) => {
    const e = c.expected;
    const memory = e.epistemic === "does_not_recall" || e.epistemic === "does_not_know";
    const valueWords = e.object && !isYesNoQuestion(expected.find((x) => x.id === e.id)!.factualQuestion) ? contentTokens(e.object).filter((w) => !contentTokens(expected.find((x) => x.id === e.id)!.factualQuestion).includes(w)) : [];
    const hit = c.extracted.filter((v) => v.status === "indexed").find((v) => (valueWords.length ? valueWords.some((w) => contentTokens(`${v.object ?? ""} ${v.valuePhrase ?? ""}`).includes(w)) : memory ? v.kind === "memory_or_knowledge" : v.polarity === e.polarity));
    return { id: e.id, heldOut: e.heldOut, candidates: c.extracted.length, automaticMatch: hit?.id ?? null };
  });
  const pairs = readFactExpectationsPairs().filter((p) => p.facts.every((id) => recall.some((r) => r.id === id)));
  const compat = pairs.map((p) => {
    const [a, b] = p.facts.map((id) => indexedViews.find((v) => v.id === recall.find((r) => r.id === id)!.automaticMatch) ?? null);
    return { case: p.case, matched: !!a && !!b, ...(a && b ? compatibility({ ...a, factualDimension: a.dimension }, { ...b, factualDimension: b.dimension }) : {}), a: a && { attribute: a.attribute, question: a.factualQuestion, value: a.object, event: (a.event as { description?: string } | null)?.description }, b: b && { attribute: b.attribute, question: b.factualQuestion, value: b.object, event: (b.event as { description?: string } | null)?.description } };
  });
  const count = <T,>(xs: T[], k: (x: T) => string | null) => xs.reduce((m, x) => ({ ...m, [k(x) ?? "null"]: ((m as Record<string, number>)[k(x) ?? "null"] ?? 0) + 1 }), {} as Record<string, number>);
  const sourceValidity = { indexed: indexedViews.length, rejected: views.length - indexedViews.length, rejectionReasons: count(views.filter((v) => v.status === "rejected"), (v) => v.rejectionReason!.split(":")[0]), semanticStatus: count(indexedViews, (v) => v.semanticStatus), valueSupport: count(indexedViews, (v) => v.valueSupport), reviewReasons: count(indexedViews.flatMap((v) => v.reviewReasons), (r) => r) };
  let repeatability: unknown = null;
  try {
    const repeats = JSON.parse(readFileSync(`${OUT}/repeat.json`, "utf8")) as { reading: { facts: { status: string; spans: string[]; dimension: string | null; kind: string | null; fact: { factualQuestion: string; value: string | null } | null }[] } }[];
    const again = repeats.flatMap((r) => r.reading.facts).filter((f) => f.status === "indexed");
    const first = indexedViews.filter((v) => v.windows.includes(PILOT.repeat));
    const used = new Set<number>();
    const matches = first.map((v) => {
      const i = again.findIndex((g, k) => !used.has(k) && g.spans.some((p) => v.positions.includes(p)));
      if (i < 0) return null;
      used.add(i);
      const g = again[i];
      return { sameKind: g.kind === v.kind, sameKey: g.dimension === v.dimension, questionOverlap: compatibility({ ...v, factualDimension: v.dimension }, { factualDimension: g.dimension, factualQuestion: g.fact!.factualQuestion, subject: null, object: g.fact!.value, polarity: null }).questionOverlap };
    }).filter((m): m is NonNullable<typeof m> => m !== null);
    repeatability = { first: first.length, repeat: again.length, matchedBySpan: matches.length, sameKind: matches.filter((m) => m.sameKind).length, sameKey: matches.filter((m) => m.sameKey).length, comparableQuestion: matches.filter((m) => m.questionOverlap >= 0.3).length };
  } catch { /* no repeat yet */ }
  const unitRows = await db.select({ key: factUnits.unitKey, status: factUnits.status, error: factUnits.error, llmCallId: factUnits.llmCallId }).from(factUnits).where(and(inArray(factUnits.depositionId, documentIds), eq(factUnits.extractorVersion, VERSION)));
  const pilotKeys = new Set(ws.flatMap((w) => w.units.map((u) => u.unitKey)));
  const pilotUnits = unitRows.filter((u) => pilotKeys.has(u.key));
  const callIds = [...new Set([...pilotUnits.map((u) => u.llmCallId), ...stored.map((f) => f.llmCallId)].filter((x): x is number => x !== null))];
  let repeatCalls: number[] = [];
  try { repeatCalls = (JSON.parse(readFileSync(`${OUT}/repeat.json`, "utf8")) as { llmCallId: number }[]).map((r) => r.llmCallId); } catch { /* no repeat yet */ }
  const calls = await db.select().from(llmCalls).where(inArray(llmCalls.id, [...callIds, ...repeatCalls].length ? [...callIds, ...repeatCalls] : [-1]));
  const [b] = await db.select({ id: budgets.id }).from(budgets).where(eq(budgets.name, PILOT.budget.name));
  const out = {
    extractorVersion: VERSION,
    windows: ws.map((w) => ({ id: w.id, document: w.document, documentId: w.documentId, anchor: `${w.from}-${w.to}`, sourceRange: w.sourceRange, units: w.units.length })),
    units: Object.fromEntries(["pending", "extracted", "empty", "suspected_omission", "no_testimony", "omitted", "failed", "incomplete"].map((s) => [s, pilotUnits.filter((u) => u.status === s).length])),
    unitErrors: pilotUnits.filter((u) => u.error).map((u) => u.error),
    usage: { requests: calls.length, inputTokens: calls.reduce((n, c) => n + c.inputTokens + c.cacheReadTokens + c.cacheWrite5mTokens + c.cacheWrite1hTokens, 0), outputTokens: calls.reduce((n, c) => n + c.outputTokens, 0), thinkingTokens: calls.reduce((n, c) => n + (c.thinkingTokens ?? 0), 0), costUsd: calls.reduce((n, c) => n + (c.costUsd ?? 0), 0), unpriced: calls.filter((c) => c.costUsd === null).length, models: [...new Set(calls.map((c) => c.model))] },
    budget: b ? await budgetStatus(db, b.id) : null,
    facts: { total: views.length, indexed: views.filter((v) => v.status === "indexed").length, rejected: views.filter((v) => v.status === "rejected").length, rejectionReasons: views.filter((v) => v.rejectionReason).map((v) => v.rejectionReason) },
    metrics: { recall, compatibility: compat, sourceValidity, repeatability, semanticCorrectness: "judged by reading the review sheet (critical), never computed" },
    critical,
    allFacts: views,
    rawOutputs: calls.map((c) => ({ llmCallId: c.id, attempt: c.attempt, raw: c.rawOutput })),
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/report.json`, JSON.stringify(out, null, 2));
  return out;
}

async function main() {
  const { db, pool } = connect();
  try {
    const [command] = positionals;
    if (command === "plan") {
      const { result } = await plan(db);
      if (values.json) return console.log(JSON.stringify(result, null, 2));
      for (const w of result.windows) console.log(`${w.id} ${w.issue}: document ${w.documentId} (${w.document}), anchor ${w.anchor}, source ${w.sourceRange}, ${w.groups} answer groups in ${w.units} units`);
      for (const d of result.perDocument) console.log(`document ${d.documentId}: ${d.estimate.units} units in ${d.estimate.batches} requests, ~${d.estimate.inputTokens} input tokens, expected $${d.estimate.expectedUsd}, worst case $${d.estimate.worstCaseUsd}`);
      console.log(`repeat of ${result.repeat.window}: ${result.repeat.estimate.batches} requests, ~${result.repeat.estimate.inputTokens} input tokens, expected $${result.repeat.estimate.expectedUsd}, worst case $${result.repeat.estimate.worstCaseUsd}`);
      console.log(`total: ${result.total.requests} requests, ~${result.total.inputTokens} input tokens, ~${result.total.plannedOutputTokens} output tokens planned, expected $${result.total.expectedUsd.toFixed(4)}, worst case $${result.total.worstCaseUsd.toFixed(4)} against a $${PILOT.budget.limitUsd} cap (${result.withinCap ? "within" : "OVER"}). ${result.model}, ${result.promptVersion}.`);
    } else if (command === "run") {
      const r = await run(db);
      console.log(JSON.stringify({ usage: r.usage, budget: r.budget, units: r.units, facts: r.facts }, null, 2));
    } else if (command === "report") {
      const r = await report(db);
      console.log(JSON.stringify({ usage: r.usage, budget: r.budget, units: r.units, facts: r.facts }, null, 2));
    } else throw new Error("Usage: plan | run | report (see the comment at the top of scripts/facts-pilot.ts)");
  } finally {
    await pool.end();
  }
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
