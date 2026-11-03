// The real-data evaluation of Stage 2 (data/eval/facts-expected-v1.json) over the Stage 1 real fixtures.
// Hand-authored fact records go through the real pipeline (units, extractFacts, verification, storage,
// the verified index) by way of a stand-in model that returns exactly those records for the units that
// hold them and noFacts for every other unit. It shows what the schema can express and what verification
// accepts or rejects on real testimony. It measures no model: no extraction quality, no recall.

import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import type { ClaimModel } from "../claims";
import { buildUnits, compatibility, extractFacts, factCoverage, formatUnit, loadDocument, valueWordsInDimension, verifiedFacts, type Unit } from "../claims/facts";
import { isYesNoQuestion } from "../claims/facts/contracts";
import { normalize } from "../verify";
import type { Database } from "../db/client";
import { facts } from "../db/schema";
import type { Check, LoadedFixtures } from "./evidenceFixtures";

export const FACT_EXPECTATIONS = "data/eval/facts-expected-v1.json";

type Range = { span: string; words: [number, number] };
export type ExpectedFact = {
  case: string; id: string; document: string; spans: string[]; phrase: Range; hedges: Range[];
  subject: string; predicate: string; object: string | null; factualQuestion: string; dimension: string; polarity: string; epistemic: string; reportedSpeaker: string | null; timeContext: string | null;
  event: { description: string | null; eventType: string | null; participants: string[]; date: string | null; location: string | null };
  expect: { status: "indexed" | "rejected"; provenance?: string; attribution?: string; rejectionReason?: string };
};
export type FactExpectations = { pairs: { case: string; facts: [string, string]; sharedDimension: boolean; expect: string }[]; facts: ExpectedFact[] };
export const readFactExpectations = (path = FACT_EXPECTATIONS) => JSON.parse(readFileSync(path, "utf8")) as FactExpectations;

const wordsOf = (unit: Unit, r: Range) => {
  const span = unit.spans.find((s) => s.position === r.span);
  if (!span) throw new Error(`span ${r.span} is not in the unit`);
  return span.text.split(/\s+/).slice(r.words[0], r.words[1]).join(" ");
};

// A frozen record in the current output contract: kind from its question and epistemic status, the
// attribute from its dimension's words, the value phrase from its cited words. The records don't change.
function asModelFact(r: ExpectedFact, unit: Unit) {
  const phrase = wordsOf(unit, r.phrase);
  const memory = r.epistemic === "does_not_recall" || r.epistemic === "does_not_know";
  const kind = memory ? "memory_or_knowledge" : r.object && !isYesNoQuestion(r.factualQuestion) ? "attribute" : "action";
  const valuePhrase = kind !== "attribute" ? null : normalize(phrase).includes(normalize(r.object!)) ? r.object : phrase;
  return {
    kind, spans: r.spans.map((p) => unit.spans.findIndex((s) => s.position === p) + 1), contextSpans: [], evidencePhrase: phrase,
    subject: r.subject, entities: r.event.participants, predicate: r.predicate, attribute: kind === "attribute" ? r.dimension.replace(/_/g, " ") : null, value: kind === "attribute" ? r.object : null, valuePhrase,
    factualQuestion: r.factualQuestion, polarity: r.polarity, epistemicStatus: r.epistemic, reportedSpeaker: r.reportedSpeaker, hedges: r.hedges.map((h) => wordsOf(unit, h)), correction: false,
    timeScope: r.timeContext, locationScope: null, event: { ...r.event, anchors: [] },
  };
}

// The stand-in model: the records written for a unit, in its group, else an empty group.
function recordsModel(units: readonly Unit[], records: readonly ExpectedFact[]): ClaimModel {
  const byBody = new Map(units.map((u) => [formatUnit(u, 0).replace(/^\[U\d+\][^\n]*\n/, ""), u]));
  return {
    model: "claude-haiku-5-5",
    async extract(text) {
      const groups = text.split(/\n\n(?=\[U\d+\])/).map((block) => {
        const position = Number(block.match(/^\[U(\d+)\]/)![1]);
        const unit = byBody.get(block.replace(/^\[U\d+\][^\n]*\n/, ""));
        const mine = unit ? records.filter((r) => r.spans.every((p) => unit.spans.some((s) => s.position === p))) : [];
        const opening = unit ? unit.spans[0].text.split(/\s+/).slice(0, 8).join(" ") : ""; // enough words to survive a long speaker label
        return [`u${position}`, { opening, facts: unit ? mine.map((r) => asModelFact(r, unit)) : [], noFactsReason: mine.length ? null : "procedural" }];
      });
      // No tokens were spent: the stand-in's calls are recorded at zero, never as a measured cost.
      return { stopReason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } as never, text: JSON.stringify(Object.fromEntries(groups)) };
    },
  };
}

export async function runFactChecks(db: Database, l: LoadedFixtures, x: FactExpectations) {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });
  const documents = [...new Set(x.facts.map((f) => f.document))];
  for (const key of documents) {
    const id = l.docId.get(key)!;
    const units = buildUnits(await loadDocument(db, id));
    const records = x.facts.filter((f) => f.document === key);
    for (const r of records) {
      const holders = units.filter((u) => r.spans.every((p) => u.spans.some((s) => s.position === p)));
      check(`${r.id}: its spans are one unit's`, holders.length >= 1, `${holders.length} units hold ${r.spans.join(", ")}`);
    }
    const run = await extractFacts(db, id, recordsModel(units, records));
    check(`${key}: every unit processed`, run.stopped === null && run.batches.failed === 0, `${run.units} units, ${run.batches.sent} requests`);
  }

  const stored = async (r: ExpectedFact) => {
    const rows = await db.select().from(facts).where(and(eq(facts.depositionId, l.docId.get(r.document)!), eq(facts.factualQuestion, r.factualQuestion)));
    return rows.find((f) => f.subject === r.subject) ?? null;
  };
  const rows = new Map<string, Awaited<ReturnType<typeof stored>>>();
  for (const r of x.facts) {
    const f = await stored(r);
    rows.set(r.id, f);
    const e = r.expect;
    const got = f ? `${f.status}${f.rejectionReason ? ` (${f.rejectionReason})` : ""}, ${f.provenance ?? "no provenance"}, attribution ${f.attributionStatus}, source ${f.sourceVerification}` : "not stored";
    const ok = !!f && f.status === e.status && (!e.rejectionReason || (f.rejectionReason ?? "").startsWith(e.rejectionReason)) && (!e.provenance || f.provenance === e.provenance) && (!e.attribution || f.attributionStatus === e.attribution);
    check(`${r.id}: ${e.status}${e.rejectionReason ? ` as ${e.rejectionReason}` : ""}`, ok, got);
    if (f && e.status === "indexed") {
      check(`${r.id}: epistemic ${r.epistemic}, polarity ${r.polarity} kept`, f.epistemicStatus === r.epistemic && f.polarity === r.polarity, `${f.epistemicStatus}, ${f.polarity}${f.reportedSpeaker ? `, reported from ${f.reportedSpeaker}` : ""}${f.hedges.length ? `, hedges ${f.hedges.length}` : ""}`);
      check(`${r.id}: dimension holds no asserted value`, valueWordsInDimension(f.factualDimension!, f.object, f.factualQuestion!).length === 0, f.factualDimension!);
    }
  }

  const index = await verifiedFacts(db, { caseId: l.caseId });
  for (const p of x.pairs) {
    const [a, b] = p.facts.map((id) => rows.get(id));
    const both = !!a && !!b && a.status === "indexed" && b.status === "indexed";
    check(`${p.case}: both sides in the verified index`, both && index.some((f) => f.id === a!.id) && index.some((f) => f.id === b!.id), p.expect);
    if (!both) continue;
    if (p.sharedDimension) {
      const c = compatibility(a!, b!);
      check(`${p.case}: comparable questions, values kept apart`, c.compatible && c.valuesDiffer, `key ${c.sameKey ? "shared" : "differs"}, question overlap ${c.questionOverlap}: ${a!.object ?? "-"} (${a!.polarity}) / ${b!.object ?? "-"} (${b!.polarity})`);
    }
    // Extraction never ties facts to one event: each keeps its own provisional description, and no event ID exists.
    const events = [a!.event, b!.event] as ({ description: string | null } & Record<string, unknown>)[];
    check(`${p.case}: events stay provisional and separate`, events.every((e) => !("id" in e) && !("eventId" in e)), events.map((e) => e.description ?? "(no description)").join(" / "));
  }
  const timeA = rows.get("cocaine-simpson");
  const timeB = rows.get("cocaine-resnick");
  check("NC-002: different time contexts preserved", !!timeA && !!timeB && timeA.timeContext !== timeB.timeContext, `${timeA?.timeContext} / ${timeB?.timeContext}`);
  const attorney = x.facts.filter((f) => f.expect.rejectionReason === "attorney_assertion").map((f) => rows.get(f.id));
  check("an attorney's unadopted words never reach the verified index", attorney.every((f) => !!f && !index.some((i) => i.id === f.id)), `${attorney.length} attorney-only records`);
  // Every indexed fact quotes stored lines whose text holds its phrase (normalization aside).
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const grounded = index.filter((f) => norm(f.sourceLines.map((s) => s.text).join(" ")).includes(norm(f.evidencePhrase!)));
  check("every indexed fact's phrase is in its stored source lines", grounded.length === index.length, `${grounded.length} of ${index.length}`);

  const coverage = await factCoverage(db, l.caseId);
  const open = coverage.documents.filter((d) => d.units.total > 0).filter((d) => d.units.pending + d.units.failed + d.units.omitted > 0);
  check("no unit left pending, failed or omitted", open.length === 0, coverage.documents.filter((d) => d.units.total > 0).map((d) => `${d.documentId}: ${d.processed.done}/${d.processed.eligible} units, ${d.units.no_testimony} without testimony, ${d.units.incomplete} incomplete`).join("; "));
  return { checks, coverage, indexed: index.length };
}
