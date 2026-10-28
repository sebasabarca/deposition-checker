// Renders every PDF line that differs from the HTML into contact sheets, so each difference can be
// checked against what the PDF actually shows. Run after run.ts:
//   npx tsx scripts/spike/render-mismatches.ts [p3171|p3173]
// Uses @napi-rs/canvas, which pdfjs-dist installs as an optional dependency for rendering in Node.

import { readFileSync, writeFileSync } from "node:fs";
import { createCanvas } from "@napi-rs/canvas";
import type { Mismatch } from "./compare";

const DOC = process.argv[2] ?? "p3171";
const PDF = `data/raw/ellison/${DOC}.pdf`;
const OUT = `data/spike-output/${DOC}`;
const SCALE = 2;
const PER_SHEET = 22;
const FIRST_LINE_Y = 697.5;
const LINE_SPACING = 22.5;
const PAGE_HEIGHT = 792;

async function main() {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const mismatches: Mismatch[] = JSON.parse(readFileSync(`${OUT}/mismatches.json`, "utf8"));
  const doc = await getDocument({ url: PDF, verbosity: 0 }).promise;

  const pdfPageByPrinted = new Map<number, number>();
  for (let p = 1; p <= doc.numPages; p++) {
    const items = (await (await doc.getPage(p)).getTextContent()).items;
    const header = items.map((i) => ("str" in i ? i.str : "")).find((s) => /^\d{5}$/.test(s));
    if (header) pdfPageByPrinted.set(Number(header), p);
  }

  const width = 560 * SCALE;
  const strip = 22 * SCALE;
  const rowHeight = strip + 30;
  for (let s = 0; s * PER_SHEET < mismatches.length; s++) {
    const group = mismatches.slice(s * PER_SHEET, (s + 1) * PER_SHEET);
    const sheet = createCanvas(width, group.length * rowHeight);
    const ctx = sheet.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, width, sheet.height);

    for (const [i, m] of group.entries()) {
      const [printed, line] = m.key.split(":").map(Number);
      const page = await doc.getPage(pdfPageByPrinted.get(printed)!);
      const viewport = page.getViewport({ scale: SCALE });
      const canvas = createCanvas(viewport.width, viewport.height);
      const pageCtx = canvas.getContext("2d");
      pageCtx.fillStyle = "white";
      pageCtx.fillRect(0, 0, viewport.width, viewport.height);
      await page.render({ canvasContext: pageCtx as never, canvas: canvas as never, viewport }).promise;

      const y = i * rowHeight;
      const top = (PAGE_HEIGHT - (FIRST_LINE_Y - (line - 1) * LINE_SPACING) - 16) * SCALE;
      ctx.fillStyle = "black";
      ctx.font = "20px sans-serif";
      ctx.fillText(`${m.key} [${m.category}] HTML: ${JSON.stringify(m.html)}`, 4, y + 22);
      ctx.drawImage(canvas, 70 * SCALE, top, width, strip, 0, y + 28, width, strip);
    }
    writeFileSync(`${OUT}/mismatch-sheet-${s + 1}.png`, sheet.toBuffer("image/png"));
    console.log(`wrote ${OUT}/mismatch-sheet-${s + 1}.png (${group.length} lines)`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
