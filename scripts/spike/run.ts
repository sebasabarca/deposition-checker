// Parser spike: extracts an Ellison deposition from its PDF, compares it with the DOJ HTML transcript,
// rebuilds exchanges, and writes the measurements to data/spike-output/<doc>/.
// Run scripts/spike/download.sh first, then: npx tsx scripts/spike/run.ts [p3171|p3173]

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { readHtmlTranscript } from "./html";
import { readPdf, type PdfLine } from "./pdf";
import { compareLines } from "./compare";
import { buildExchanges, markHtmlLine, markPdfLine, type Exchange, type MarkedLine } from "./exchanges";

const RAW = "data/raw";
const DOC = process.argv[2] ?? "p3171";
const OUT = `data/spike-output/${DOC}`;

function cite(e: Exchange): string {
  const end = e.end.page === e.start.page ? `${e.end.line}` : `${e.end.page}:${e.end.line}`;
  return `p.${e.start.page}:${e.start.line}–${end}`;
}

function pickSample(exchanges: Exchange[], lines: MarkedLine[]): { reason: string; exchange: Exchange }[] {
  const picked = new Map<string, { reason: string; exchange: Exchange }>();
  const add = (reason: string, list: Exchange[], n: number) => {
    for (const e of list.filter((x) => !picked.has(x.id)).slice(0, n)) picked.set(e.id, { reason, exchange: e });
  };
  const hasTurn = (e: Exchange, marker: string, re?: RegExp) =>
    e.turns.some((t) => t.marker === marker && (!re || re.test(lines.slice(t.first, t.last + 1).map((l) => l.text).join(" "))));
  const contains = (page: number, line: number) => (e: Exchange) =>
    lines.slice(e.lineIndexes[0], e.lineIndexes[1] + 1).some((l) => l.page === page && l.line === line);

  const multiPage = exchanges.filter((e) => e.pages > 1);
  add("spans a page break", multiPage.filter((_, i) => i % Math.max(1, Math.floor(multiPage.length / 5)) === 0), 5);
  add("short answer (3 words or fewer)", exchanges.filter((e) => e.kind === "qa" && e.answer && e.answer.split(/\s+/).length <= 3), 4);
  add("objection", exchanges.filter((e) => hasTurn(e, "speaker", /\bobject/i)), 4);
  add("attorney or witness colloquy", exchanges.filter((e) => hasTurn(e, "speaker", /^(?!.*\bobject)/i)), 3);
  add("exhibit or parenthetical", exchanges.filter((e) => hasTurn(e, "parenthetical")), 2);
  add("attorney resumes with 'MR. X: Q.'", exchanges.filter((e) => hasTurn(e, "Q", /^\s*M[RS]S?\. /)), 4);
  add("new examiner (BY MR. ...)", exchanges.filter((e) => hasTurn(e, "examiner")), 1);
  add("starts mid-turn after a redaction gap", exchanges.filter((e) => e.flags.includes("starts_mid_turn")), 2);
  add("question with no answer", exchanges.filter((e) => e.flags.includes("no_answer")), 2);
  add("answer marker without a period (p.236:11)", exchanges.filter(contains(236, 11)), 1);
  add("paragraph starting with the word 'A' (p.194:1)", exchanges.filter(contains(194, 1)), 1);
  add("long answer", [...exchanges].sort((a, b) => b.answer.length - a.answer.length), 1);
  const plain = exchanges.filter((e) => e.kind === "qa" && e.flags.length === 0 && e.pages === 1);
  add("ordinary single-page Q/A", plain.filter((_, i) => i % Math.floor(plain.length / 4) === 0), 4);
  return [...picked.values()];
}

function renderSample(sample: { reason: string; exchange: Exchange }[], lines: MarkedLine[]): string {
  const out = [`# Exchange review sample (Ellison ${DOC.toUpperCase()}, PDF extraction)`, ""];
  for (const [i, { reason, exchange: e }] of sample.entries()) {
    out.push(`## ${i + 1}. ${e.id} ${cite(e)} — ${reason}`);
    out.push(`kind: ${e.kind}; pages: ${e.pages}; turns: ${e.turns.map((t) => t.marker).join(", ")}; flags: ${e.flags.join(", ") || "none"}`, "");
    out.push("```");
    for (const l of lines.slice(e.lineIndexes[0], e.lineIndexes[1] + 1)) {
      out.push(`${String(l.page).padStart(3)}:${String(l.line).padStart(2)} ${(l.turn ?? "").padEnd(13)} ${l.text.trim()}`);
    }
    out.push("```", "", "Verdict: _to review_", "");
  }
  return out.join("\n");
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  const html = readHtmlTranscript(readFileSync(`${RAW}/ellison/${DOC}.html`, "utf8"));
  const pdf = await readPdf(`${RAW}/ellison/${DOC}.pdf`);
  // Blank pages are reported separately, so they don't shift the page-by-page sequence check.
  const pdfPrintedPages = pdf.pages.filter((p) => !pdf.blankPages.includes(p.pdfPage)).map((p) => p.printedPage);
  const comparison = compareLines(html.lines, pdf.lines, html.pages, pdfPrintedPages);
  const positionDisagreements = pdf.lines.filter((l) => l.lineFromPosition !== l.line);

  const marked: MarkedLine[] = pdf.lines.map((l: PdfLine) => ({
    page: l.printedPage ?? -1,
    line: l.line,
    text: l.text,
    turn: markPdfLine(l.text, l.indentX),
  }));
  const exchanges = buildExchanges(marked, DOC.toUpperCase());

  const htmlTurns = new Map(html.lines.map((l) => [`${l.page}:${l.line}`, markHtmlLine(l.text)]));
  const turnDisagreements = marked
    .filter((l) => htmlTurns.get(`${l.page}:${l.line}`) !== l.turn)
    .map((l) => ({ key: `${l.page}:${l.line}`, pdf: l.turn, html: htmlTurns.get(`${l.page}:${l.line}`) ?? null, text: l.text.trim() }));

  const gates = [];
  for (const file of readdirSync(`${RAW}/gates`).filter((f) => f.endsWith(".pdf")).sort()) {
    const g = await readPdf(`${RAW}/gates/${file}`);
    gates.push({ file, pages: g.pages.length, needsOcr: g.needsOcr.length, lines: g.lines.length });
  }

  const count = <T extends string>(xs: T[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
  const summary = {
    lines: {
      html: comparison.htmlLines,
      pdf: comparison.pdfLines,
      compared: comparison.compared,
      exact: comparison.exact,
      exactRate: comparison.exact / comparison.htmlLines,
      byCategory: comparison.byCategory,
      htmlPages: html.pages.length,
      pdfPages: pdf.pages.length,
      pageSequenceMismatches: comparison.pageSequenceMismatches.length,
      positionDisagreements: positionDisagreements.length,
      needsOcr: pdf.needsOcr.length,
      blankPages: pdf.blankPages,
      unnumberedRows: pdf.pages.reduce((n, p) => n + p.unnumbered.length, 0),
    },
    exchanges: {
      total: exchanges.length,
      byKind: count(exchanges.map((e) => e.kind)),
      multiPage: exchanges.filter((e) => e.pages > 1).length,
      flags: count(exchanges.flatMap((e) => e.flags)),
      longestAnswerLines: Math.max(...exchanges.map((e) => e.turns.filter((t) => t.marker === "A").reduce((n, t) => n + t.last - t.first + 1, 0))),
      turnMarkers: count(marked.map((l) => l.turn ?? "continuation")),
      turnDisagreementsWithHtml: turnDisagreements.length,
    },
    gates,
  };

  const sample = pickSample(exchanges, marked);
  writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
  writeFileSync(`${OUT}/mismatches.json`, JSON.stringify(comparison.mismatches, null, 2));
  writeFileSync(`${OUT}/turn-disagreements.json`, JSON.stringify(turnDisagreements, null, 2));
  writeFileSync(`${OUT}/exchanges.json`, JSON.stringify(exchanges, null, 2));
  writeFileSync(`${OUT}/exchange-sample.md`, renderSample(sample, marked));

  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nReview sample: ${sample.length} exchanges in ${OUT}/exchange-sample.md`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
