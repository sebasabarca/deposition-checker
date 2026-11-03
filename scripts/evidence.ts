// The Stage 1 evidence index from the command line (server/src/evidence). No model calls, ever.
//
//   npx tsx scripts/evidence.ts index [--case-id <id>] [--refresh]
//     Fills the evidence fields of stored exchanges that lack them (or, with --refresh, recomputes all),
//     then prints the coverage totals. Writes only those fields.
//   npx tsx scripts/evidence.ts coverage --case-id <id> [--json]
//   npx tsx scripts/evidence.ts search <words…> --case-id <id> [--witness-id <id>] [--session-id <id>] [--document-id <id>] [--limit 10] [--json]
//   npx tsx scripts/evidence.ts get <exchange id> [--case-id <id>] [--json]
//   npx tsx scripts/evidence.ts context <exchange id> [--case-id <id>] [--lines 5] [--json]
//   npx tsx scripts/evidence.ts eval-real [--json]
//     The real-data evaluation (data/eval/evidence-fixtures-v1.json) in TEST_DATABASE_URL, which it wipes
//     (its name must end in "_test"). Fails if any fixture file is missing; exits 1 if any check fails.
//   npx tsx scripts/evidence.ts export-lines --deposition <id> --out data/raw/fixtures/<name>.json
//     Saves one stored file's lines (with their speaker roles), exchanges and validation, as stored, for
//     the real-transcript fixture tests (server/src/eval/storedExport.ts). It holds testimony, so it may
//     only be written under the git-ignored data/raw/.
//
//   npx tsx scripts/evidence.ts attribution --document-id <id> [--json]
//     Verified, uncertain and invalid Q/A exchanges of a stored document, and the likely cause of each one
//     that isn't verified.
//   npx tsx scripts/evidence.ts parser-audit [--case-id <id>] [--json]
//     Read-only: documents stored under an older parser, the artifacts later revisions fixed that their
//     stored rows still hold, and what re-reading each would affect.
//   npx tsx scripts/evidence.ts reprocess --document-id <id> [--execute] [--accept-impact] [--out <file>]
//     Re-reads one stored document with the current parser. A dry run unless --execute; refuses to remove
//     findings unless --accept-impact. Reports changed source IDs, attribution before and after, and the
//     exchange IDs removed and added.
//   npx tsx scripts/evidence.ts correct --document-id <id> [--execute] [--out data/raw/<file>.json]
//     Corrects a stored document in place under the current parser when only speaker attribution changes:
//     every line and every exchange whose lines stay the same keep their IDs, so nothing that refers to
//     them is removed. A dry run unless --execute; executing first writes a backup under data/raw/backups/.
//     Refuses, changing nothing, when text would change or a referenced exchange would change its lines,
//     and then maps each such exchange to the corrected ones and lists the findings that need review.
//
// Prints testimony: run it against data you may read.

import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { asc, eq } from "drizzle-orm";
import { connect } from "../server/src/db/client";
import { loadEvidenceFixtures, missingFixtureFiles, openEvaluationDatabase, readEvidenceFixture, runEvidenceChecks } from "../server/src/eval/evidenceFixtures";
import { depositions, exchangeLines, exchanges, lines, witnesses } from "../server/src/db/schema";
import { correctInPlace, evidenceCoverage, getEvidence, indexEvidence, parserAudit, reprocessDocument, searchEvidence, sourceContext, storedAttribution, type EvidenceExchange, type SourceRef } from "../server/src/evidence";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { execute: { type: "boolean" }, "accept-impact": { type: "boolean" }, "case-id": { type: "string" }, "witness-id": { type: "string" }, "session-id": { type: "string" }, "document-id": { type: "string" }, limit: { type: "string" }, lines: { type: "string" }, refresh: { type: "boolean" }, json: { type: "boolean" }, deposition: { type: "string" }, out: { type: "string" } },
});
const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
const [command, ...rest] = positionals;

const line = (r: SourceRef) => `  ${r.ref.padEnd(22)} ${r.lineRole.padEnd(8)} ${r.speaker.padEnd(13)} ${r.text}`;
function show(x: EvidenceExchange) {
  console.log(`${x.id ?? `(not indexed; row ${x.rowId})`}  ${x.witness}, ${x.takenOn ?? "date not stated"}  session ${x.sessionId} part ${x.sessionPart}, document ${x.documentId}`);
  console.log(`  ${x.kind}, ${x.sourceStart.ref} to ${x.sourceEnd.ref} (${x.sourceStart.scheme}${x.sourceStart.citable ? "" : ", not a printed page:line"}), speaker ${x.speakerStatus ?? "not indexed"}${x.speakerReasons.length ? `: ${x.speakerReasons.join("; ")}` : ""}${x.flags.length ? `, flags ${x.flags.join(", ")}` : ""}`);
  if (x.integrity.textHashMatches === false) console.log("  WARNING: the stored lines changed since this exchange was indexed");
  for (const r of x.lines) console.log(line(r));
}

async function evalReal() {
  const fixture = readEvidenceFixture();
  const missing = missingFixtureFiles(fixture);
  if (missing.length) throw new Error(`The real-data evaluation needs every fixture file; missing:\n  ${missing.join("\n  ")}\n(see data/eval/evidence-fixtures-v1.json "about" for where each comes from)`);
  const { db, pool } = await openEvaluationDatabase(process.env.TEST_DATABASE_URL);
  try {
    const loaded = await loadEvidenceFixtures(db, fixture);
    const r = await runEvidenceChecks(db, fixture, loaded);
    if (values.json) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`Real-data evaluation: ${r.counts.documents} documents, ${r.counts.lines} source lines, ${r.counts.exchanges} exchanges (${r.counts.qaExchanges} Q/A), ${r.counts.segmentedStatements} statements with several speakers`);
      for (const c of r.checks) console.log(`  ${c.ok ? "pass" : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
      console.log("Attribution (Q/A exchanges):");
      for (const [key, a] of Object.entries(r.attribution)) console.log(`  ${key.padEnd(28)} ${a.counts.verified} verified, ${a.counts.uncertain} uncertain, ${a.counts.invalid} invalid  ${JSON.stringify(a.causes)}`);
    }
    if (!r.ok) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

async function main() {
  if (command === "eval-real") return evalReal();
  const { db, pool } = connect();
  try {
    const caseId = num(values["case-id"]);
    if (command === "index") {
      const report = await indexEvidence(db, { caseId, refresh: values.refresh });
      console.log(JSON.stringify(report, null, 2));
      if (caseId !== undefined) console.log(JSON.stringify((await evidenceCoverage(db, caseId)).totals, null, 2));
    } else if (command === "coverage") {
      if (caseId === undefined) throw new Error("coverage needs --case-id");
      const c = await evidenceCoverage(db, caseId);
      if (values.json) return console.log(JSON.stringify(c, null, 2));
      for (const d of c.documents) {
        console.log(`document ${d.documentId} (${d.witness}, ${d.takenOn ?? "no date"}, session ${d.sessionId} part ${d.sessionPart}) ${d.status}, ${d.scheme}: ${d.lines} lines, ${d.qaExchanges} Q/A exchanges (${d.speaker.verified} verified, ${d.speaker.uncertain} uncertain, ${d.speaker.invalid} invalid), ${d.notIndexed} not indexed, ${d.witnessLinesInNoExchange} witness lines in no exchange`);
        if (d.blankPages.length) console.log(`  blank PDF pages: ${d.blankPages.join(", ")}`);
        if (d.unreadPages.length) console.log(`  unread PDF pages: ${d.unreadPages.join(", ")}`);
        for (const g of d.missingPages) console.log(`  missing printed pages ${g.missingPages.join(", ")} between ${g.after} and ${g.before}`);
        for (const n of d.notes) console.log(`  ${n}`);
      }
      for (const s of c.sessions) for (const n of s.notes) console.log(`session ${s.sessionId}: ${n}`);
      console.log(JSON.stringify(c.totals));
    } else if (command === "search") {
      if (caseId === undefined || rest.length === 0) throw new Error("search needs words and --case-id");
      const r = await searchEvidence(db, rest.join(" "), { caseId, witnessId: num(values["witness-id"]), sessionId: num(values["session-id"]), documentId: num(values["document-id"]), limit: num(values.limit) ?? 10 });
      if (values.json) return console.log(JSON.stringify(r, null, 2));
      console.log(`${r.matched} answers match "${r.query}"; showing ${r.results.length}`);
      for (const { rank, exchange } of r.results) {
        console.log(`\nrank ${rank.toFixed(3)}`);
        show(exchange);
      }
    } else if (command === "get") {
      const x = await getEvidence(db, rest[0], caseId);
      if (!x) throw new Error(`No exchange ${rest[0]}.`);
      if (values.json) return console.log(JSON.stringify(x, null, 2));
      show(x);
    } else if (command === "context") {
      const c = await sourceContext(db, rest[0], { caseId, lines: num(values.lines) });
      if (!c) throw new Error(`No exchange ${rest[0]}.`);
      if (values.json) return console.log(JSON.stringify(c, null, 2));
      console.log(`previous: ${c.previous ? `${c.previous.id} at ${c.previous.sourceStart.ref}${c.previous.crossesDocument ? " (in the session's previous file)" : ""}` : "none"}`);
      for (const r of c.before) console.log(line(r));
      show(c.exchange);
      for (const r of c.after) console.log(line(r));
      console.log(`next: ${c.next ? `${c.next.id} at ${c.next.sourceStart.ref}${c.next.crossesDocument ? " (in the session's next file)" : ""}` : "none"}`);
    } else if (command === "attribution") {
      const id = num(values["document-id"]);
      if (!id) throw new Error("attribution needs --document-id");
      const r = await storedAttribution(db, id);
      if (values.json) return console.log(JSON.stringify(r, null, 2));
      console.log(`${r.qa} Q/A exchanges: ${r.counts.verified} verified, ${r.counts.uncertain} uncertain, ${r.counts.invalid} invalid`);
      console.log(JSON.stringify(r.causes));
      for (const c of r.cases) console.log(`  ${c.firstRef.padEnd(20)} ${c.status.padEnd(9)} ${c.cause.padEnd(22)} ${c.sample}`);
    } else if (command === "parser-audit") {
      const r = await parserAudit(db, { caseId });
      if (values.json) return console.log(JSON.stringify(r, null, 2));
      for (const d of r) console.log(`document ${d.documentId} (${d.witness}, ${d.layout}, ${d.parserVersion}${d.storedFile ? "" : ", no stored file"}): ${d.action}. Artifacts ${JSON.stringify(d.artifacts)}; analyses [${d.impact.analyses.join(", ")}], ${d.impact.findings} findings (${d.impact.reviewedFindings} reviewed)`);
    } else if (command === "reprocess") {
      const id = num(values["document-id"]);
      if (!id) throw new Error("reprocess needs --document-id");
      const r = await reprocessDocument(db, id, { execute: values.execute, acceptImpact: values["accept-impact"] });
      if (values.out) {
        if (!path.resolve(values.out).startsWith(path.resolve("data/raw") + path.sep)) throw new Error("The report holds testimony samples: write it under data/raw/, which git ignores.");
        mkdirSync(path.dirname(values.out), { recursive: true });
        writeFileSync(values.out, JSON.stringify(r, null, 2));
      }
      const brief = "changes" in r ? { ...r, changes: Object.fromEntries(Object.entries(r.changes).map(([k, v]) => [k, v.length])), attribution: { before: { counts: r.attribution.before.counts, causes: r.attribution.before.causes }, after: { counts: r.attribution.after.counts, causes: r.attribution.after.causes } }, ...("exchangeIds" in r ? { exchangeIds: { removed: r.exchangeIds.removed.length, added: r.exchangeIds.added.length, kept: r.exchangeIds.kept } } : {}) } : r;
      console.log(JSON.stringify(brief, null, 2));
      if (r.outcome === "refused") process.exitCode = 2;
    } else if (command === "correct") {
      const id = num(values["document-id"]);
      if (!id) throw new Error("correct needs --document-id");
      const r = await correctInPlace(db, id, { execute: values.execute });
      if (values.out) {
        if (!path.resolve(values.out).startsWith(path.resolve("data/raw") + path.sep)) throw new Error("Write the report under data/raw/, which git ignores.");
        mkdirSync(path.dirname(values.out), { recursive: true });
        writeFileSync(values.out, JSON.stringify(r, null, 2));
      }
      const brief = "mapping" in r ? { ...r, statusChanged: r.statusChanged.length, mapping: `${r.mapping.length} exchanges (see --out)`, findings: { ...r.findings, requiresReview: r.findings.requiresReview.length } } : r;
      console.log(JSON.stringify(brief, null, 2));
      if (r.outcome !== "dry_run" && r.outcome !== "corrected") process.exitCode = 2;
    } else if (command === "export-lines") {
      const id = num(values.deposition);
      if (!id || !values.out) throw new Error("export-lines needs --deposition and --out");
      if (!path.resolve(values.out).startsWith(path.resolve("data/raw") + path.sep)) throw new Error("The export holds testimony: write it under data/raw/, which git ignores.");
      const [d] = await db.select({ sha: depositions.fileSha256, takenOn: depositions.takenOn, validation: depositions.validation, parserVersion: depositions.parserVersion, witness: witnesses.name }).from(depositions).innerJoin(witnesses, eq(witnesses.id, depositions.witnessId)).where(eq(depositions.id, id));
      if (!d) throw new Error(`No deposition ${id}.`);
      const rows = await db.select({ id: lines.id, pdfPage: lines.pdfPage, printedPage: lines.printedPage, lineNo: lines.lineNo, speakerRole: lines.speakerRole, speakerName: lines.speakerName, rawText: lines.rawText, ocrText: lines.ocrText, ocrConfidence: lines.ocrConfidence }).from(lines).where(eq(lines.depositionId, id)).orderBy(asc(lines.printedPage), asc(lines.lineNo));
      const position = new Map(rows.map((r, i) => [r.id, i]));
      const parts = await db.select().from(exchanges).where(eq(exchanges.depositionId, id)).orderBy(asc(exchanges.groupId), asc(exchanges.partNo));
      const members = await db.select({ exchangeId: exchangeLines.exchangeId, lineId: exchangeLines.lineId, role: exchangeLines.role }).from(exchangeLines).where(eq(exchangeLines.depositionId, id));
      const at = (lineId: number | null) => (lineId === null ? null : position.get(lineId)!);
      const exported = parts.map((e) => ({ groupNo: e.groupId, partNo: e.partNo, partCount: e.partCount, kind: e.kind, flags: e.flags, span: { first: at(e.firstLineId), last: at(e.lastLineId) }, question: e.questionFirstLineId === null ? null : { first: at(e.questionFirstLineId), last: at(e.questionLastLineId) }, answer: e.answerFirstLineId === null ? null : { first: at(e.answerFirstLineId), last: at(e.answerLastLineId) }, answerLineCount: e.answerLineCount, questionText: e.questionText, answerText: e.answerText, dialogueText: e.dialogueText, lines: members.filter((m) => m.exchangeId === e.id).map((m) => ({ index: at(m.lineId), role: m.role })).sort((x, y) => x.index! - y.index!) }));
      mkdirSync(path.dirname(values.out), { recursive: true });
      writeFileSync(values.out, JSON.stringify({ fileSha256: d.sha, witness: d.witness, takenOn: d.takenOn, parserVersion: d.parserVersion, validation: d.validation, lines: rows.map(({ id: _id, ...r }) => r), parts: exported }));
      console.log(`${rows.length} lines of deposition ${id} written to ${values.out}`);
    } else {
      throw new Error("Usage: index | coverage | search | get | context | attribution | parser-audit | reprocess | correct | eval-real | export-lines (see the comment at the top of scripts/evidence.ts)");
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
