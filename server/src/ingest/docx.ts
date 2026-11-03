// DOCX transcripts: the body of word/document.xml, in order, as the text parser reads it. Each
// paragraph is a row; a table row is one row with its cells side by side (reporters lay out the line
// number and the testimony as two cells); page breaks, "page break before" and next-page section
// breaks become form feeds. Running heads and footers (header*.xml, footer*.xml), comments, tracked
// deletions, field codes and text boxes are not testimony and are left out. Line numbers kept as
// Word's line-numbering setting are recovered only when unambiguous (see numbering.ts).

import { numberFormattedLines, type FormattedParagraph } from "./numbering";
import { readZip, ZipError } from "./zip";

export const isZip = (data: Uint8Array) => data.length > 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
// Word 97–2003 .doc (and other OLE compound files, such as .xls)
export const isOle = (data: Uint8Array) => data.length > 8 && data[0] === 0xd0 && data[1] === 0xcf && data[2] === 0x11 && data[3] === 0xe0;

export function isDocx(data: Uint8Array) {
  if (!isZip(data)) return false;
  try {
    return readZip(data).has("word/document.xml");
  } catch {
    return false;
  }
}

const TOKEN = /<(\/?)([A-Za-z_][\w.-]*(?::[\w.-]+)?)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|([^<]+)/g;
const ATTR = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ENTITY = /&(?:#x([0-9a-fA-F]+)|#(\d+)|(lt|gt|amp|quot|apos));/g;
const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const unescape = (s: string) => s.replace(ENTITY, (_, hex, dec, name) => (name ? NAMED[name] : String.fromCodePoint(parseInt(hex ?? dec, hex ? 16 : 10))));
function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(ATTR)) out[m[1]] = unescape(m[2] ?? m[3]);
  return out;
}
const on = (a: Record<string, string>) => !["0", "false", "off"].includes(a["w:val"] ?? "true");

// Elements whose content is not body text.
const SKIP = new Set(["w:del", "w:delText", "w:instrText", "w:delInstrText", "mc:Fallback", "w:txbxContent", "w:comment", "w:footnote", "w:endnote"]);

export type DocxText = { text: string; paragraphs: FormattedParagraph[]; lineNumbering: { perPage: boolean } | null; warnings: string[] };

export function extractDocx(data: Uint8Array): DocxText {
  const entry = readZip(data).get("word/document.xml");
  if (!entry) throw new ZipError("the file has no Word document body (word/document.xml)");
  const xml = new TextDecoder().decode(entry());
  const paragraphs: FormattedParagraph[] = [];
  let skipDepth = 0;
  let textBoxes = 0;
  let inText = false;
  let inParaProps = 0;
  let para: { text: string; breakBefore: boolean; breakAfter: boolean } | null = null;
  const rows: { paragraphs: FormattedParagraph[] }[] = [];
  // Table state: the cells of the current row, each a list of paragraphs. Nested tables flatten.
  let tableDepth = 0;
  let cells: FormattedParagraph[][] = [];
  let cell: FormattedParagraph[] | null = null;
  let lineNumbering: { perPage: boolean } | null = null;
  let renderedBreaks = 0;
  let explicitBreaks = 0;

  // A finished paragraph, split at page breaks inside it, into the current cell or the body.
  const finish = (p: { text: string; breakBefore: boolean; breakAfter: boolean }) => {
    const pieces = p.text.split("\f");
    let out = pieces.map((t, i) => ({ text: t, pageBreakBefore: i === 0 && p.breakBefore, pageBreakAfter: i < pieces.length - 1 || (i === pieces.length - 1 && p.breakAfter) }));
    // A break at the very start of a paragraph moves the paragraph to the next page; nothing is left behind.
    if (out.length > 1 && out[0].text === "") out = [{ ...out[1], pageBreakBefore: true }, ...out.slice(2)];
    if (cell) cell.push(...out);
    else rows.push({ paragraphs: out });
  };

  for (const m of xml.matchAll(TOKEN)) {
    const [, close, name, rawAttrs, selfClose, cdata, text] = m;
    if (text !== undefined || cdata !== undefined) {
      if (inText && skipDepth === 0 && para) para.text += cdata ?? unescape(text!);
      continue;
    }
    if (!name) continue;
    if (SKIP.has(name)) {
      if (name === "w:txbxContent" && !close) textBoxes++;
      if (!selfClose) skipDepth += close ? -1 : 1;
      continue;
    }
    if (close) {
      if (name === "w:t") inText = false;
      else if (name === "w:pPr") inParaProps--;
      else if (name === "w:p" && skipDepth === 0 && para) {
        finish(para);
        para = null;
      } else if (name === "w:tc" && tableDepth === 1) {
        if (cell) cells.push(cell);
        cell = null;
      } else if (name === "w:tr" && tableDepth === 1) {
        // One printed row per paragraph line across the cells: "5" | "Q. Where were you?" -> "5   Q. Where were you?"
        const height = Math.max(0, ...cells.map((c) => c.length));
        for (let i = 0; i < height; i++) {
          const parts = cells.map((c) => c[i]).filter((p) => p !== undefined);
          rows.push({ paragraphs: [{ text: parts.map((p) => p.text).join("   "), pageBreakBefore: parts.some((p) => p.pageBreakBefore), pageBreakAfter: parts.some((p) => p.pageBreakAfter) }] });
        }
        cells = [];
      } else if (name === "w:tbl") tableDepth--;
      continue;
    }
    if (skipDepth > 0) continue;
    const a = rawAttrs ? attrs(rawAttrs) : {};
    switch (name) {
      case "w:p":
        if (selfClose) finish({ text: "", breakBefore: false, breakAfter: false });
        else para = { text: "", breakBefore: false, breakAfter: false };
        break;
      case "w:pPr":
        if (!selfClose) inParaProps++;
        break;
      case "w:pageBreakBefore":
        if (para && on(a)) {
          para.breakBefore = true;
          explicitBreaks++;
        }
        break;
      case "w:t":
        if (!selfClose) inText = true;
        break;
      case "w:tab":
        if (para && inParaProps === 0) para.text += "\t";
        break;
      case "w:br":
      case "w:cr":
        if (!para) break;
        if (a["w:type"] === "page") {
          para.text += "\f";
          explicitBreaks++;
        } else para.text += "\n";
        break;
      case "w:noBreakHyphen":
        if (para) para.text += "‑";
        break;
      case "w:sym":
        if (para && a["w:char"]) para.text += String.fromCharCode(parseInt(a["w:char"], 16));
        break;
      case "w:lastRenderedPageBreak":
        renderedBreaks++;
        break;
      case "w:sectPr":
        // A section break inside a paragraph's properties starts a new page unless it's continuous.
        if (para && inParaProps > 0) para.breakAfter = true;
        break;
      case "w:type":
        if (para && inParaProps > 0 && a["w:val"] === "continuous") para.breakAfter = false;
        break;
      case "w:lnNumType":
        if (a["w:countBy"]) lineNumbering = { perPage: (a["w:restart"] ?? "newPage") === "newPage" };
        break;
      case "w:tbl":
        tableDepth++;
        break;
      case "w:tc":
        if (tableDepth === 1) cell = [];
        break;
    }
  }

  const flat = rows.flatMap((r) => r.paragraphs);
  paragraphs.push(...flat);
  const text = flat.map((p) => `${p.pageBreakBefore ? "\f" : ""}${p.text.replaceAll("\f", "")}${p.pageBreakAfter ? "\n\f" : ""}`).join("\n").replaceAll("\n\f\n\f", "\n\f");
  const warnings: string[] = [];
  if (textBoxes) warnings.push(`${textBoxes} text ${textBoxes === 1 ? "box was" : "boxes were"} left out; text boxes hold labels and stamps, not numbered testimony.`);
  if (lineNumbering && explicitBreaks === 0 && renderedBreaks > 0) warnings.push("The document marks pages only where Word last laid it out, not with page breaks.");
  return { text, paragraphs, lineNumbering, warnings };
}

// The DOCX's transcript text for the text parser: as printed, or numbered from its formatting.
export function docxTranscript(data: Uint8Array): { text: string; warnings: string[] } {
  const docx = extractDocx(data);
  if (!docx.lineNumbering) return { text: docx.text, warnings: docx.warnings };
  const numbered = numberFormattedLines(docx.text, docx.paragraphs, docx.lineNumbering.perPage);
  return { text: numbered.text, warnings: [...docx.warnings, ...numbered.warnings] };
}
