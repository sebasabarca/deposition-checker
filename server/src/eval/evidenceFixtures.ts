// The real-data evaluation of the Stage 1 evidence foundation (data/eval/evidence-fixtures-v1.json):
// loads the real fixture files into a database through the normal save path, then checks source-text
// preservation, indexing, integrity, the labelled passages, long-answer continuity and speaker segments,
// and reports attribution. Shared by tests/db/evidenceReal.test.ts (which skips without the files) and
// `scripts/evidence.ts eval-real` (which fails without them). No model calls.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { connect, type Database } from "../db/client";
import { cases, depositions, exchangeLines, exchanges, lineSegments, lines, orgs, witnesses } from "../db/schema";
import { evidenceCoverage, getEvidence, indexEvidence, searchEvidence, storedAttribution, type AttributionReport, type EvidenceExchange } from "../evidence";
import { readDeposition, saveDeposition, type DepositionRead } from "../ingest";
import { readStoredExport } from "./storedExport";

export const EVIDENCE_FIXTURES = "data/eval/evidence-fixtures-v1.json";

export type EvidenceFixture = {
  documents: Record<string, { sha256: string; witness: string; takenOn: string; scheme: string; local: string; loader: "text" | "stored-export"; session: string; part: number }>;
  items: { id: string; category: string; controlType?: string; sides: { document: string; from: string; to: string; search: string }[] }[];
};

export const readEvidenceFixture = (path = EVIDENCE_FIXTURES) => JSON.parse(readFileSync(path, "utf8")) as EvidenceFixture;
export const missingFixtureFiles = (f: EvidenceFixture) => Object.values(f.documents).filter((d) => !existsSync(d.local)).map((d) => d.local);

// A fresh evaluation database: dropped and migrated, so only a database named "*_test" is accepted.
export async function openEvaluationDatabase(url: string | undefined) {
  if (!url || !new URL(url).pathname.endsWith("_test")) throw new Error(`The evaluation wipes its database, so it needs TEST_DATABASE_URL naming a database ending in "_test"; got ${url ?? "nothing"}.`);
  const { db, pool } = connect(url);
  await db.execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; drop schema if exists pgboss cascade; create schema public;`);
  await migrate(db, { migrationsFolder: "drizzle" });
  return { db, pool };
}

export type LoadedFixtures = { caseId: number; docId: Map<string, number>; witnessId: Map<string, number>; reads: Map<string, DepositionRead> };

async function loadOne(db: Database, f: EvidenceFixture, key: string, caseId: number, witnessId: number, session?: { id: number; part: number }) {
  const d = f.documents[key];
  const stored = d.loader === "stored-export" ? readStoredExport(d.local) : null;
  const data = d.loader === "text" ? new Uint8Array(readFileSync(d.local)) : null;
  const read = stored ? stored.read : await readDeposition(data!, undefined, undefined, d.witness);
  const fileSha256 = stored ? stored.fileSha256 : createHash("sha256").update(data!).digest("hex");
  if (fileSha256 !== d.sha256) throw new Error(`${key}: the file's SHA-256 ${fileSha256} isn't the fixture's ${d.sha256}`);
  const saved = await saveDeposition(db, { caseId, witnessId, takenOn: d.takenOn, fileSha256, storageKey: `fixtures/${fileSha256}`, read, session });
  if (!("depositionId" in saved)) throw new Error(`${key} was not saved`);
  return { id: saved.depositionId, read };
}

// Files join a session only as the fixture says: its first part makes it, later parts name it.
export async function loadEvidenceFixtures(db: Database, f: EvidenceFixture): Promise<LoadedFixtures> {
  const [org] = await db.insert(orgs).values({ name: "Fixtures" }).returning();
  const [{ id: caseId }] = await db.insert(cases).values({ orgId: org.id, name: "Real fixtures" }).returning();
  const witnessId = new Map<string, number>();
  for (const name of new Set(Object.values(f.documents).map((d) => d.witness))) witnessId.set(name, (await db.insert(witnesses).values({ caseId, name }).returning())[0].id);
  const docId = new Map<string, number>();
  const reads = new Map<string, DepositionRead>();
  const sessionIds = new Map<string, number>();
  for (const [key, d] of Object.entries(f.documents).sort(([, x], [, y]) => x.part - y.part)) {
    const { id, read } = await loadOne(db, f, key, caseId, witnessId.get(d.witness)!, sessionIds.has(d.session) ? { id: sessionIds.get(d.session)!, part: d.part } : undefined);
    docId.set(key, id);
    reads.set(key, read);
    if (!sessionIds.has(d.session)) sessionIds.set(d.session, (await db.select({ s: depositions.sessionId }).from(depositions).where(eq(depositions.id, id)))[0].s);
  }
  return { caseId, docId, witnessId, reads };
}

export const reloadFixture = (db: Database, f: EvidenceFixture, l: LoadedFixtures, key: string) => loadOne(db, f, key, l.caseId, l.witnessId.get(f.documents[key].witness)!);

const pos = (ref: string) => ref.split(":").map(Number) as [number, number];

// The Q/A exchanges whose lines include any position of the anchor.
export async function exchangesAt(db: Database, l: LoadedFixtures, document: string, from: string, to: string): Promise<EvidenceExchange[]> {
  const [[p1, l1], [p2, l2]] = [pos(from), pos(to)];
  const rows = await db.selectDistinct({ key: exchanges.evidenceKey }).from(exchanges).innerJoin(exchangeLines, eq(exchangeLines.exchangeId, exchanges.id)).innerJoin(lines, eq(lines.id, exchangeLines.lineId))
    .where(and(eq(exchanges.depositionId, l.docId.get(document)!), eq(exchanges.kind, "qa"), inArray(lines.printedPage, [p1, p2])));
  const all = await Promise.all(rows.map((r) => getEvidence(db, r.key!, l.caseId)));
  const inside = (p: number, n: number) => p * 100000 + n >= p1 * 100000 + l1 && p * 100000 + n <= p2 * 100000 + l2;
  return all.filter((x): x is EvidenceExchange => !!x && x.lines.some((r) => { const [, , p, n] = r.sourceId.split("_").map(Number); return inside(p, n); }));
}

export type Check = { name: string; ok: boolean; detail: string };

export async function runEvidenceChecks(db: Database, f: EvidenceFixture, l: LoadedFixtures) {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });
  const coverage = await evidenceCoverage(db, l.caseId);
  check("every fixture file is stored and read", coverage.totals.documents === Object.keys(f.documents).length && coverage.totals.notRead === 0, JSON.stringify(coverage.totals));
  check("every exchange is indexed", coverage.totals.notIndexed === 0, `${coverage.totals.notIndexed} not indexed`);
  check("every witness line is in an exchange", coverage.totals.witnessLinesInNoExchange === 0, `${coverage.totals.witnessLinesInNoExchange} witness lines in no exchange`);
  for (const [key, d] of Object.entries(f.documents)) {
    const doc = coverage.documents.find((x) => x.documentId === l.docId.get(key))!;
    check(`${key}: cited as ${d.scheme}`, doc.scheme === d.scheme, doc.scheme);
  }

  // Source text: kept verbatim, and nothing of the source left out.
  for (const [key, d] of Object.entries(f.documents)) {
    const stored = await db.select({ page: lines.printedPage, line: lines.lineNo, text: lines.rawText }).from(lines).where(eq(lines.depositionId, l.docId.get(key)!));
    if (d.loader === "text") {
      const rows = readFileSync(d.local, "utf8").split(/\r?\n/);
      const source = new Set(rows);
      const altered = stored.filter((x) => !source.has(`${x.line} ${x.text}`));
      const statements = rows.filter((r) => /^\d{1,6}\s+\S/.test(r)).length;
      check(`${key}: stored text is the source's, verbatim`, altered.length === 0, `${altered.length} of ${stored.length} lines differ`);
      check(`${key}: every numbered statement with text is stored`, stored.length === statements, `${stored.length} stored, ${statements} in the file`);
    } else {
      const exported = readStoredExport(d.local).read.exchanges!.lines.map((x) => x.rawText).sort();
      const same = JSON.stringify(stored.map((x) => x.text).sort()) === JSON.stringify(exported);
      check(`${key}: stored text is the export's, verbatim`, same, `${stored.length} stored, ${exported.length} exported`);
    }
  }

  // Integrity: every stored key, hash and status is what the lines give now.
  const integrity = await indexEvidence(db, { caseId: l.caseId, refresh: true });
  check("every stored evidence key, hash and status matches its lines", integrity.written === 0 && integrity.failed.length === 0, JSON.stringify(integrity));

  // Speaker segments: in order, inside their line, covering it but for the spaces between.
  const segs = await db.select({ seg: lineSegments, text: lines.rawText }).from(lineSegments).innerJoin(lines, eq(lines.id, lineSegments.lineId)).orderBy(asc(lineSegments.lineId), asc(lineSegments.seq));
  const byLine = new Map<number, typeof segs>();
  for (const s of segs) byLine.set(s.seg.lineId, [...(byLine.get(s.seg.lineId) ?? []), s]);
  const badSegments = [...byLine.values()].filter((ss) => ss[0].seg.startOffset !== 0 || ss.at(-1)!.seg.endOffset !== ss[0].text.length || ss.some((s, i) => i > 0 && ss[0].text.slice(ss[i - 1].seg.endOffset, s.seg.startOffset).trim() !== ""));
  check("speaker segments cover their statements exactly", badSegments.length === 0, `${byLine.size} statements with several speakers, ${badSegments.length} malformed`);

  // Long answers: parts overlap, and together hold every line of the answer (whole exchanges where the read kept them).
  for (const [key, read] of l.reads) {
    const whole = read.exchanges?.exchanges ?? [];
    const parts = read.exchanges?.parts ?? [];
    const split = whole.filter((e) => parts.filter((p) => p.groupNo === e.groupNo).length > 1);
    const dropped = split.filter((e) => { const got = new Set(parts.filter((p) => p.groupNo === e.groupNo).flatMap((p) => p.lines.map((m) => m.index))); return e.lines.some((m) => !got.has(m.index)); });
    const groups = [...new Set(parts.filter((p) => p.partCount > 1).map((p) => p.groupNo))];
    const noOverlap = groups.filter((g) => { const ps = parts.filter((p) => p.groupNo === g).sort((a, b) => a.partNo - b.partNo); return ps.some((p, i) => i > 0 && !p.lines.some((m) => ps[i - 1].lines.some((n) => n.index === m.index))); });
    check(`${key}: long answers keep every line, parts overlap`, dropped.length === 0 && noOverlap.length === 0, `${groups.length} split answers; ${dropped.length} drop lines, ${noOverlap.length} parts without overlap${whole.length ? "" : " (whole exchanges not in the export: overlap checked only)"}`);
  }

  // The labelled passages: indexed, cited in their own scheme, and found by their own words.
  for (const item of f.items) {
    for (const side of item.sides) {
      const found = await exchangesAt(db, l, side.document, side.from, side.to);
      const scheme = f.documents[side.document].scheme;
      const ok = found.length > 0 && found.every((x) => x.id?.startsWith("ex_") && x.integrity.textHashMatches && x.lines.every((r) => r.scheme === scheme));
      const hits = await searchEvidence(db, side.search, { caseId: l.caseId, witnessId: l.witnessId.get(f.documents[side.document].witness), documentId: l.docId.get(side.document), limit: 200 });
      const ids = new Set(found.map((x) => `${x.documentId}/${x.part.groupId}`));
      check(`${item.id} ${side.document} ${side.from}-${side.to}: indexed and found by "${side.search}"`, ok && hits.results.some((r) => ids.has(`${r.exchange.documentId}/${r.exchange.part.groupId}`)), `${found.length} exchanges hold it; ${hits.matched} match the words`);
    }
  }

  const attribution: Record<string, AttributionReport> = {};
  for (const [key, id] of l.docId) attribution[key] = await storedAttribution(db, id);
  const counts = { documents: coverage.totals.documents, lines: coverage.totals.lines, exchanges: coverage.totals.exchanges, qaExchanges: coverage.totals.qaExchanges, segmentedStatements: byLine.size };
  return { ok: checks.every((c) => c.ok), checks, counts, attribution };
}
