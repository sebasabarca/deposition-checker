// Regression test on the real DOJ files. Skipped unless scripts/spike/download.sh has been run,
// so `npm test` still works on a fresh clone. The expected values are the measured results in
// docs/parser-spike.md: production extraction must reproduce the validated spike exactly.

import { existsSync, readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { readDeposition } from "../../server/src/ingest";
import { readHtmlTranscript } from "../../scripts/spike/html";
import { readPdf as readPdfSpike } from "../../scripts/spike/pdf";
import { buildExchanges as buildExchangesSpike, markPdfLine } from "../../scripts/spike/exchanges";
import { MAX_ANSWER_LINES, ANSWER_OVERLAP_LINES, deriveTexts } from "../../server/src/ingest/exchanges";

const RAW = "data/raw";
const TIMEOUT = 120_000;
const bytes = (path: string) => new Uint8Array(readFileSync(path));
const linesOf = (r: Awaited<ReturnType<typeof readDeposition>>) => r.pdf!.pages.flatMap((p) => p.lines);

const ellison = [
  { doc: "p3171", lines: 3943, textPages: 211, blankPages: [] as number[], exchanges: 533, splitGroups: 1 },
  { doc: "p3173", lines: 1660, textPages: 99, blankPages: [64, 65, 66, 67, 68, 69, 70, 71, 72], exchanges: 209, splitGroups: 4 },
];

describe.skipIf(!existsSync(`${RAW}/ellison/p3171.pdf`) || !existsSync(`${RAW}/ellison/p3173.pdf`))(
  "Ellison depositions (real DOJ PDFs)",
  () => {
    for (const expected of ellison) {
      it(
        `${expected.doc} is ready, with every page:line matching the DOJ HTML and the spike`,
        async () => {
          const result = await readDeposition(bytes(`${RAW}/ellison/${expected.doc}.pdf`));
          const v = result.validation;
          expect(v.status).toBe("ready");
          expect(v.counts).toEqual({ text: expected.textPages, blank: expected.blankPages.length, needs_ocr: 0, failed: 0 });
          expect(v.blankPages).toEqual(expected.blankPages);
          expect(v.pages).toHaveLength(expected.textPages + expected.blankPages.length);

          const lines = linesOf(result);
          expect(lines).toHaveLength(expected.lines);

          const html = readHtmlTranscript(readFileSync(`${RAW}/ellison/${expected.doc}.html`, "utf8"));
          expect(lines.map((l) => `${l.printedPage}:${l.lineNo}`)).toEqual(html.lines.map((l) => `${l.page}:${l.line}`));

          const spike = await readPdfSpike(`${RAW}/ellison/${expected.doc}.pdf`);
          expect(lines.map((l) => [l.pdfPage, l.printedPage, l.lineNo, l.indentX, l.rawText])).toEqual(
            spike.lines.map((l) => [l.pdfPage, l.printedPage, l.line, l.indentX, l.text]),
          );
        },
        TIMEOUT,
      );

      it(
        `${expected.doc} rebuilds the spike's ${expected.exchanges} exchanges and splits long answers without losing lines`,
        async () => {
          const result = await readDeposition(bytes(`${RAW}/ellison/${expected.doc}.pdf`));
          const { lines, exchanges, parts } = result.exchanges!;

          // Every source line is kept, in order, with a speaker.
          expect(lines.map((l) => l.rawText)).toEqual(linesOf(result).map((l) => l.rawText));
          expect(lines.every((l, i) => l.index === i)).toBe(true);

          // Same exchanges as the hand-reviewed spike: boundaries, kind, flags, question and answer text.
          // Separate witness turns are now on separate lines (Codex finding 1); the words are unchanged.
          const flat = (t: string) => t.replace(/\n/g, " ");
          const spike = buildExchangesSpike(
            lines.map((l) => ({ page: l.printedPage!, line: l.lineNo, text: l.rawText, turn: markPdfLine(l.rawText, l.indentX) })),
            expected.doc,
          );
          expect(exchanges).toHaveLength(expected.exchanges);
          expect(
            exchanges.map((e) => {
              const text = deriveTexts(lines, e.lines);
              return [e.lines[0].index, e.lines.at(-1)!.index, e.kind, e.flags, flat(text.questionText), flat(text.answerText)];
            }),
          ).toEqual(spike.map((s) => [s.lineIndexes[0], s.lineIndexes[1], s.kind, s.flags, s.question, s.answer]));

          // Unknown-speaker text is kept but never becomes answer text.
          for (const e of exchanges) {
            for (const m of e.lines) if (lines[m.index].role === "unknown") expect(m.role).toBe("unknown");
          }

          // Long answers: parts of at most 40 answer lines, overlapping by 5, covering every answer line.
          const groups = new Map<number, typeof parts>();
          for (const p of parts) groups.set(p.groupNo, [...(groups.get(p.groupNo) ?? []), p]);
          expect([...groups.values()].filter((g) => g.length > 1)).toHaveLength(expected.splitGroups);
          for (const e of exchanges) {
            const group = groups.get(e.groupNo)!;
            const answers = e.lines.filter((m) => m.role === "answer").map((m) => m.index);
            const covered = new Set(group.flatMap((p) => p.lines.filter((m) => m.role === "answer").map((m) => m.index)));
            expect([...covered].sort((a, b) => a - b)).toEqual(answers);
            const allCovered = new Set(group.flatMap((p) => p.lines.map((m) => m.index)));
            expect(allCovered.size).toBe(e.lines.length);
            for (const p of group) expect(p.answerLineCount).toBeLessThanOrEqual(MAX_ANSWER_LINES);
            for (let k = 1; k < group.length; k++) {
              const before = new Set(group[k - 1].lines.filter((m) => m.role === "answer").map((m) => m.index));
              const shared = group[k].lines.filter((m) => m.role === "answer" && before.has(m.index));
              expect(shared).toHaveLength(ANSWER_OVERLAP_LINES);
              expect(group[k].question).toEqual(group[0].question);
            }
          }
        },
        TIMEOUT,
      );
    }
  },
);

const gates = [
  { file: "gates8a.pdf", pages: 13 },
  { file: "gates8b.pdf", pages: 60 },
  { file: "gates8c.pdf", pages: 12 },
  { file: "gates8d.pdf", pages: 11 },
  { file: "gates8f.pdf", pages: 13 },
];

describe.skipIf(!gates.every((g) => existsSync(`${RAW}/gates/${g.file}`)))("Gates depositions (image-only PDFs)", () => {
  for (const g of gates) {
    it(
      `${g.file} is unsupported, with all ${g.pages} pages reported as needs_ocr`,
      async () => {
        const result = await readDeposition(bytes(`${RAW}/gates/${g.file}`));
        expect(result.validation.status).toBe("unsupported");
        expect(result.validation.counts).toEqual({ text: 0, blank: 0, needs_ocr: g.pages, failed: 0 });
        expect(result.validation.needsOcrPages).toHaveLength(g.pages);
        expect(linesOf(result)).toEqual([]);
        expect(result.exchanges).toBeNull();
      },
      TIMEOUT,
    );
  }
});

describe("unreadable files", () => {
  it("reports a file that isn't a PDF as unsupported instead of throwing", async () => {
    const result = await readDeposition(new TextEncoder().encode("this is not a PDF"));
    expect(result.pdf).toBeNull();
    expect(result.validation.status).toBe("unsupported");
    expect(result.validation.reasons[0]).toMatch(/^the file could not be read as a PDF/);
  });
});
