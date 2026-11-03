// RTF transcripts: the text of the document body, in order, as the text parser reads it. Paragraphs
// (\par) and line breaks (\line) end a row, page breaks (\page, \pagebb) become form feeds, and
// escaped characters are decoded with the document's code page. Headers, footers, font and style
// tables, pictures, field instructions and other hidden destinations are left out: they are running
// heads and formatting, never testimony. Page:line comes from the numbers printed in the text, or,
// when the document numbers its lines as a formatting setting, from formattedLines (see below).

import { numberFormattedLines, type FormattedParagraph } from "./numbering";

// Destinations whose content is not body text.
const SKIP = new Set([
  "fonttbl", "colortbl", "stylesheet", "info", "pict", "object", "header", "headerl", "headerr", "headerf", "footer", "footerl", "footerr", "footerf",
  "footnote", "annotation", "fldinst", "datastore", "themedata", "colorschememapping", "latentstyles", "rsidtbl", "xmlnstbl", "listtable",
  "listoverridetable", "generator", "pgdsctbl", "filetbl", "revtbl", "bkmkstart", "bkmkend", "shppict", "nonshppict", "mmathPr", "wgrffmtfilter",
]);
const SYMBOL: Record<string, string> = {
  tab: "\t", emdash: "—", endash: "–", lquote: "‘", rquote: "’", ldblquote: "“", rdblquote: "”",
  bullet: "•", emspace: " ", enspace: " ", qmspace: " ",
};

export type RtfText = { text: string; paragraphs: FormattedParagraph[]; lineNumbering: { perPage: boolean } | null; warnings: string[] };

export const isRtf = (data: Uint8Array) => data.length > 5 && String.fromCharCode(...data.subarray(0, 5)) === "{\\rtf";

function decoderFor(codePage: number): TextDecoder | null {
  try {
    return new TextDecoder(codePage === 65001 ? "utf-8" : `windows-${codePage}`);
  } catch {
    return null;
  }
}

export function extractRtf(data: Uint8Array): RtfText {
  // RTF is 7-bit: every byte above 0x7f is escaped, so latin1 maps bytes to characters one to one.
  const src = new TextDecoder("latin1").decode(data);
  const warnings: string[] = [];
  let decoder = new TextDecoder("windows-1252");
  type Group = { skip: boolean; uc: number };
  const stack: Group[] = [];
  let group: Group = { skip: false, uc: 1 };
  let out = "";
  let skipChars = 0; // fallback characters after a \u that aren't text
  let pendingBytes: number[] = [];
  let lineMod: number | null = null;
  let restartPerPage = false;
  let starNext = false;
  let unknownCodePage = false;
  const paragraphs: FormattedParagraph[] = [];
  let paraStart = 0;
  let breakBefore = false;

  const flushBytes = () => {
    if (pendingBytes.length) {
      out += decoder.decode(new Uint8Array(pendingBytes));
      pendingBytes = [];
    }
  };
  const emit = (s: string) => {
    if (group.skip) return;
    flushBytes();
    out += s;
  };
  const endParagraph = (pageAfter = false) => {
    if (group.skip) return;
    flushBytes();
    paragraphs.push({ text: out.slice(paraStart), pageBreakBefore: breakBefore, pageBreakAfter: pageAfter });
    out += pageAfter ? "\n\f" : "\n";
    paraStart = out.length;
    breakBefore = false;
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "{") {
      stack.push(group);
      group = { ...group };
      starNext = src.startsWith("{\\*", i);
      i++;
      continue;
    }
    if (c === "}") {
      flushBytes();
      group = stack.pop() ?? group;
      i++;
      continue;
    }
    if (c === "\r" || c === "\n") {
      i++;
      continue;
    }
    if (c !== "\\") {
      if (skipChars > 0) skipChars--;
      else emit(c);
      i++;
      continue;
    }
    // A control word, a control symbol, or an escaped byte.
    const next = src[i + 1];
    if (next === "'") {
      const byte = parseInt(src.slice(i + 2, i + 4), 16);
      i += 4;
      if (skipChars > 0) skipChars--;
      else if (!group.skip && !Number.isNaN(byte)) pendingBytes.push(byte);
      continue;
    }
    if (next === undefined || !/[a-zA-Z]/.test(next)) {
      i += 2;
      if (next === "*") continue; // marks the group as an optional destination; handled at the next word
      if (next === "\\" || next === "{" || next === "}") emit(next);
      else if (next === "~") emit(" ");
      else if (next === "_") emit("‑");
      else if (next === "\n" || next === "\r") endParagraph();
      continue; // \- (optional hyphen) and others print nothing
    }
    const m = /^\\([a-zA-Z]{1,32})(-?\d{1,10})? ?/.exec(src.slice(i, i + 48))!;
    i += m[0].length;
    const word = m[1];
    const arg = m[2] === undefined ? null : Number(m[2]);
    if (starNext) {
      starNext = false;
      if (!SKIP.has(word) && word !== "fldrslt") group.skip = true; // an unknown optional destination
    }
    if (SKIP.has(word)) {
      group.skip = true;
      continue;
    }
    switch (word) {
      case "par":
        endParagraph();
        break;
      case "line":
        emit("\n");
        break;
      case "page":
        // After a \par the break starts the next paragraph on a new page; it isn't a line of its own.
        if (group.skip) break;
        if (out.length === paraStart) {
          breakBefore = true;
          if (paragraphs.length) {
            out += "\f";
            paraStart = out.length;
          }
        } else endParagraph(true);
        break;
      case "pagebb":
        if (group.skip) break;
        breakBefore = true;
        if (out.length === paraStart && paragraphs.length) {
          out += "\f";
          paraStart = out.length;
        }
        break;
      case "sect":
        endParagraph();
        break;
      case "u":
        if (arg !== null) {
          emit(String.fromCharCode(arg < 0 ? arg + 65536 : arg));
          skipChars = group.uc;
        }
        break;
      case "uc":
        group.uc = arg ?? 1;
        break;
      case "ansicpg": {
        const d = arg === null ? null : decoderFor(arg);
        if (d) decoder = d;
        else unknownCodePage = true;
        break;
      }
      case "linemod":
        lineMod = arg;
        break;
      case "lineppage":
        restartPerPage = true;
        break;
      case "bin":
        i += arg ?? 0; // binary data, never text
        break;
      default:
        if (word in SYMBOL) emit(SYMBOL[word]);
    }
  }
  flushBytes();
  if (out.length > paraStart) paragraphs.push({ text: out.slice(paraStart), pageBreakBefore: breakBefore, pageBreakAfter: false });
  if (stack.length > 0) warnings.push("The RTF file ends before all of its groups close, so it may be truncated. Check that the last pages are complete.");
  if (unknownCodePage) warnings.push("The RTF file names a code page Veridict can't read, so accented letters may be wrong. Check them against the certified transcript.");
  return { text: out, paragraphs, lineNumbering: lineMod ? { perPage: restartPerPage } : null, warnings };
}

// The RTF's transcript text for the text parser: as printed, or numbered from its formatting.
export function rtfTranscript(data: Uint8Array): { text: string; warnings: string[] } {
  const rtf = extractRtf(data);
  if (!rtf.lineNumbering) return { text: rtf.text, warnings: rtf.warnings };
  const numbered = numberFormattedLines(rtf.text, rtf.paragraphs, rtf.lineNumbering.perPage);
  return { text: numbered.text, warnings: [...rtf.warnings, ...numbered.warnings] };
}
