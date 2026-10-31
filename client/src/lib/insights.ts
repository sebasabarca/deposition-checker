// Figures derived from API responses. Pure, so every number on a screen traces to stored rows.

import type { AnalysisProgress, AnalysisRow, AnalysisStatus, CaseDetail, EvidenceSide, FindingSummary } from "../types";

export const ACTIVE_STATUSES: AnalysisStatus[] = ["queued", "parsing", "retrieving", "adjudicating"];
export const isActive = (s: AnalysisStatus) => ACTIVE_STATUSES.includes(s);

// Every candidate pair lands in exactly one bucket, so none is silently lost. "Selected" pairs with
// no result yet, or whose call failed, are unassessed; lower-ranked pairs held back are deferred.
export function candidateCoverage(p: AnalysisProgress) {
  const assessed = (p.adjudicated ?? 0) + (p.replayed ?? 0) + (p.fixture ?? 0);
  const selected = p.candidates?.selected ?? 0;
  const deferred = p.candidates?.deferred ?? 0;
  return { assessed, unassessed: Math.max(selected - assessed, 0), deferred, total: selected + deferred };
}

export function progressShare(status: AnalysisStatus, p: AnalysisProgress) {
  if (status === "completed") return 1;
  const selected = p.candidates?.selected ?? 0;
  return selected ? Math.min(candidateCoverage(p).assessed / selected, 1) : 0;
}

export function countClassifications(findings: Pick<FindingSummary, "classification">[]) {
  return {
    direct: findings.filter((f) => f.classification === "direct").length,
    inferential: findings.filter((f) => f.classification === "inferential").length,
  };
}

export type Activity = { key: string; kind: "analysis" | "deposition" | "case"; title: string; subject: string; at: string; link: string };

export function recentActivity(details: CaseDetail[], links: { case: (id: number) => string; analysis: (id: number) => string }, limit = 5): Activity[] {
  const witness = (d: CaseDetail, id: number) => d.witnesses.find((w) => w.id === id)?.name ?? "Unknown witness";
  const items = details.flatMap((d): Activity[] => [
    { key: `c${d.case.id}`, kind: "case", title: "Case created", subject: d.case.name, at: d.case.createdAt, link: links.case(d.case.id) },
    ...d.depositions.map((s): Activity => ({ key: `d${s.id}`, kind: "deposition", title: "Deposition uploaded", subject: `${witness(d, s.witnessId)}${s.pageCount ? ` (${s.pageCount} pages)` : ""}`, at: s.createdAt, link: links.case(d.case.id) })),
    ...d.analyses.map((a: AnalysisRow): Activity => ({ key: `a${a.id}`, kind: "analysis", title: a.finishedAt ? "Analysis finished" : "Analysis started", subject: `${d.case.name} / ${witness(d, a.witnessId)}`, at: a.finishedAt ?? a.createdAt, link: links.analysis(a.id) })),
  ]);
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

// A pinpoint citation built only from stored references.
export function pinpointCitation(a: Pick<EvidenceSide, "range" | "deposition" | "lines">, b: Pick<EvidenceSide, "range" | "deposition" | "lines">) {
  const one = (s: typeof a) => `${s.deposition.witness.split(" ").at(-1)} Dep. ${s.range ?? "(no page:line reference)"} (${s.deposition.takenOn?.slice(0, 10) ?? "date not stated"})${citesInferredPage(s) ? " [page number inferred; verify against the scan]" : ""}`;
  return `${one(a)}; compare ${one(b)}.`;
}

export const citesInferredPage = (s: Pick<EvidenceSide, "lines">) => s.lines.some((l) => l.pageInferred);

export const LOW_OCR_CONFIDENCE = 85;

// Null for a text-layer passage. Uses != because a server without OCR omits the field.
export function ocrPassage(side: Pick<EvidenceSide, "before" | "lines" | "after">) {
  const all = [...side.before, ...side.lines, ...side.after];
  const read = all.filter((l) => l.ocrConfidence != null);
  if (read.length === 0) return null;
  const cited = side.lines.filter((l) => l.highlighted);
  const pages = [...new Set((cited.length ? cited : side.lines.length ? side.lines : all).map((l) => l.pdfPage))].sort((a, b) => a - b);
  const inferredPages = [...new Set(all.filter((l) => l.pageInferred).map((l) => l.ref.split(":")[0]))];
  return { lowLines: read.filter((l) => l.ocrConfidence! < LOW_OCR_CONFIDENCE).length, pages, inferredPages };
}

export function relativeTime(iso: string, now: number) {
  const minutes = Math.round((now - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}
