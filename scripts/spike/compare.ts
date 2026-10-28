// Compares PDF-extracted lines against the HTML ground truth, line by line, keyed on printed page:line.
// A line matches only if its page:line exists on both sides and its text is identical after trimming
// leading and trailing whitespace. Nothing else is normalized: case, punctuation, quote characters
// and internal spacing must all match. Every mismatch is categorized so nothing is hidden.

import type { SourceLine } from "./html";
import type { PdfLine } from "./pdf";

export type MismatchCategory =
  | "missing_in_pdf" // HTML has this page:line, the PDF does not
  | "extra_in_pdf" // the PDF has a page:line the HTML does not
  | "internal_whitespace" // same characters, different spacing inside the line
  | "typography" // differs only in quote, dash or ellipsis characters
  | "text"; // any other text difference

export type Mismatch = { key: string; category: MismatchCategory; html: string | null; pdf: string | null };

export type Comparison = {
  htmlLines: number;
  pdfLines: number;
  compared: number; // lines present on both sides
  exact: number;
  mismatches: Mismatch[];
  byCategory: Record<MismatchCategory, number>;
  pageSequenceMismatches: { index: number; html: number; pdf: number | null }[];
};

const TYPOGRAPHY: [RegExp, string][] = [
  [/[‘’‛′]/g, "'"],
  [/[“”‟″]/g, '"'],
  [/[–—]/g, "-"],
  [/…/g, "..."],
];

export function categorize(html: string, pdf: string): MismatchCategory {
  const collapse = (s: string) => s.replace(/\s+/g, " ");
  if (collapse(html) === collapse(pdf)) return "internal_whitespace";
  const plain = (s: string) => TYPOGRAPHY.reduce((t, [re, to]) => t.replace(re, to), collapse(s));
  if (plain(html) === plain(pdf)) return "typography";
  return "text";
}

export function compareLines(html: SourceLine[], pdf: PdfLine[], htmlPages: number[], pdfPages: (number | null)[]): Comparison {
  const key = (page: number | null, line: number) => `${page}:${line}`;
  const pdfByKey = new Map(pdf.map((l) => [key(l.printedPage, l.line), l.text.trim()]));
  const htmlKeys = new Set<string>();
  const mismatches: Mismatch[] = [];
  let exact = 0;

  for (const l of html) {
    const k = key(l.page, l.line);
    htmlKeys.add(k);
    const want = l.text.trim();
    const got = pdfByKey.get(k);
    if (got === undefined) mismatches.push({ key: k, category: "missing_in_pdf", html: want, pdf: null });
    else if (got === want) exact++;
    else mismatches.push({ key: k, category: categorize(want, got), html: want, pdf: got });
  }
  for (const [k, text] of pdfByKey) {
    if (!htmlKeys.has(k)) mismatches.push({ key: k, category: "extra_in_pdf", html: null, pdf: text });
  }

  const byCategory: Record<MismatchCategory, number> = {
    missing_in_pdf: 0,
    extra_in_pdf: 0,
    internal_whitespace: 0,
    typography: 0,
    text: 0,
  };
  for (const m of mismatches) byCategory[m.category]++;

  const pageSequenceMismatches = htmlPages
    .map((page, index) => ({ index, html: page, pdf: pdfPages[index] ?? null }))
    .filter((p) => p.html !== p.pdf);

  return {
    htmlLines: html.length,
    pdfLines: pdf.length,
    compared: html.length - byCategory.missing_in_pdf,
    exact,
    mismatches,
    byCategory,
    pageSequenceMismatches,
  };
}
