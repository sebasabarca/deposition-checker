// What testimony an analysis actually received, worked out by code from what ingestion stored, so a
// report never implies that evidence it didn't have was checked. Pure. The model's own account of what
// limited its review is kept separately and labelled as the model's (see api/analyses.ts).

import type { Validation } from "../ingest/validate";

export type LineRef = { page: number; line: number };
export type Gap = { after: string; before: string; missingPages: number[] }; // printed page:line either side
export type SessionCoverage = {
  linesSent: number;
  pageCount: number | null;
  blankPages: number[]; // PDF pages with no text at all
  unreadPages: number[]; // PDF pages that failed or still need OCR: their text was never stored
  gaps: Gap[]; // printed pages missing between stored lines
  lineSkips: Gap[]; // line numbers skipped within or across one page: blank lines, or omitted text
  numbered: boolean; // false when references aren't printed page:line, so gaps can't be read from them
};

const ref = (l: LineRef) => `${l.page}:${String(l.line).padStart(2, "0")}`;

// lines: one session's stored lines in transcript order.
export function sessionCoverage(lines: readonly LineRef[], validation: Pick<Validation, "pageCount" | "blankPages" | "failedPages" | "needsOcrPages" | "layout"> | null): SessionCoverage {
  // Unnumbered text (page 0) and physical lines are numbered by the reader itself, so they can't show a gap.
  const numbered = lines.some((l) => l.page > 0) && validation?.layout !== "pdf-physical-v1";
  const gaps: Gap[] = [];
  const lineSkips: Gap[] = [];
  if (numbered) {
    for (let i = 1; i < lines.length; i++) {
      const [p, n] = [lines[i - 1], lines[i]];
      const next = n.page === p.page ? n.line === p.line + 1 : n.page === p.page + 1 && n.line === 1;
      if (next) continue;
      const missingPages = Array.from({ length: Math.max(0, n.page - p.page - 1) }, (_, k) => p.page + 1 + k);
      (missingPages.length > 0 ? gaps : lineSkips).push({ after: ref(p), before: ref(n), missingPages });
    }
  }
  return {
    linesSent: lines.length,
    pageCount: validation?.pageCount ?? null,
    blankPages: validation?.blankPages ?? [],
    unreadPages: [...new Set([...(validation?.failedPages ?? []), ...(validation?.needsOcrPages ?? [])])].sort((a, b) => a - b),
    gaps,
    lineSkips,
    numbered,
  };
}

// True when code knows of testimony the analysis didn't receive.
export const hasCoverageGaps = (c: SessionCoverage) => c.blankPages.length + c.unreadPages.length + c.gaps.length > 0;
