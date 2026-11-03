// Line numbers kept as a word-processor setting (Word's line numbering, RTF \linemod) rather than as
// printed text. The numbers then exist only where the program lays the page out, so they can be
// recovered only when that layout is unambiguous: numbering restarts on every page, pages end at
// explicit page breaks, and every line is short enough that it can't have wrapped. Otherwise the text
// is left unnumbered (cited as "Line N", never by page:line) and the reason is a warning.

import { readTextPages } from "./text";

export type FormattedParagraph = { text: string; pageBreakBefore: boolean; pageBreakAfter: boolean };

// A transcript line is at most about 60 characters in the 10-pitch Courier of a 25-line page; longer
// rows may have wrapped onto a second, unnumbered printed line.
export const MAX_UNWRAPPED_CHARS = 66;
const MAX_LINES_PER_PAGE = 30;

export function numberFormattedLines(text: string, paragraphs: FormattedParagraph[], restartsEachPage: boolean): { text: string; warnings: string[] } {
  // Numbers printed in the text win; the setting is then just how the document was styled.
  if (readTextPages(text).layout.name === "text-numbered-v1") return { text, warnings: [] };
  const fallback = (why: string) => ({
    text,
    warnings: [`The document numbers its lines with a formatting setting rather than printed numbers, and ${why}, so page and line numbers can't be recovered reliably. Ask the court reporter for the ASCII (.txt) or PDF transcript.`],
  });
  if (!restartsEachPage) return fallback("the numbering doesn't restart on each page");
  const pages: string[][] = [[]];
  for (const p of paragraphs) {
    if (p.pageBreakBefore && pages.at(-1)!.length) pages.push([]);
    pages.at(-1)!.push(...p.text.replaceAll("\f", "").split("\n"));
    if (p.pageBreakAfter) pages.push([]);
  }
  while (pages.length > 1 && pages.at(-1)!.every((l) => !l.trim())) pages.pop();
  if (pages.length < 2) return fallback("it has no page breaks");
  const tooLong = pages.flat().find((l) => l.replaceAll("\t", "    ").trimEnd().length > MAX_UNWRAPPED_CHARS);
  if (tooLong !== undefined) return fallback(`some lines are long enough to wrap (such as "${tooLong.trim().slice(0, 50)}…")`);
  const tall = pages.findIndex((p) => p.length > MAX_LINES_PER_PAGE);
  if (tall >= 0) return fallback(`page ${tall + 1} has more lines than a transcript page`);
  const numbered = pages.map((p) => p.map((l, i) => `${String(i + 1).padStart(2)}  ${l}`).join("\n")).join("\n\f");
  return {
    text: numbered,
    warnings: ["Line numbers come from the document's line-numbering setting, not from printed text: each line of each page was counted in order. Verify citations against the certified transcript."],
  };
}
