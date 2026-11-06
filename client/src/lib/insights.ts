// Figures derived from API responses. Pure, so every number on a screen traces to stored rows.

import type { AnalysisProgress, AnalysisRow, AnalysisStatus, CaseDetail, DepositionRow, EvidenceSide } from "../types";

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

export type Activity = { key: string; kind: "analysis" | "deposition" | "case"; title: string; subject: string; at: string; link: string };

export function recentActivity(details: CaseDetail[], links: { case: (id: number) => string; analysis: (id: number) => string }, limit = 5): Activity[] {
  const witness = (d: CaseDetail, id: number) => d.witnesses.find((w) => w.id === id)?.name ?? "Unknown witness";
  const items = details.flatMap((d): Activity[] => [
    { key: `c${d.case.id}`, kind: "case", title: "Case created", subject: d.case.name, at: d.case.createdAt, link: links.case(d.case.id) },
    ...d.depositions.map((s): Activity => ({ key: `d${s.id}`, kind: "deposition", title: "Deposition uploaded", subject: `${witness(d, s.witnessId)}${s.pageCount ? ` (${s.pageCount} pages)` : ""}`, at: s.createdAt, link: links.case(d.case.id) })),
    ...d.analyses.map((a: AnalysisRow): Activity => ({ key: `a${a.id}`, kind: "analysis", title: a.finishedAt ? "Analysis finished" : "Analysis started", subject: `${d.case.name} / ${witness(d, a.witnessId)}${a.kind === "cross_witness" && a.witnessBId ? ` and ${witness(d, a.witnessBId)}` : ""}`, at: a.finishedAt ?? a.createdAt, link: links.analysis(a.id) })),
  ]);
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

// A pinpoint citation built only from stored references.
const MONTHS = ["Jan.", "Feb.", "Mar.", "Apr.", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];
const citationDate = (iso: string | null | undefined) => {
  if (!iso) return null;
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
};

export function pinpointCitation(a: Pick<EvidenceSide, "range" | "deposition" | "lines">, b: Pick<EvidenceSide, "range" | "deposition" | "lines">) {
  const one = (s: typeof a) => `${s.deposition.witness.split(" ").at(-1)} Dep. ${displayRef(s.range) ?? "(no page:line reference)"} (${citationDate(s.deposition.takenOn) ?? "date not stated"})${citesInferredPage(s) ? " [page number inferred; verify against the scan]" : ""}${s.deposition.physicalLines ? ` [${PHYSICAL_LINE}]` : ""}`;
  return `${one(a)}; compare ${one(b)}.`;
}

export const PHYSICAL_LINE = "line counted on the page, not an official line number";

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

export type CheckState =
  | { kind: "pick" | "too_many" | "not_ready" | "no_date" }
  | { kind: "new"; a: number; b: number; cross: boolean }
  | { kind: "running" | "done"; a: number; b: number; cross: boolean; report: Pick<AnalysisRow, "id" | "createdAt">; };

// What the New check panel offers for the ticked depositions. Pure. The same two files, in either
// order, are one comparison: a file uploaded twice to a case is one deposition, so IDs identify it.
// Sessions of two different witnesses are a cross-witness comparison (cross).
export function checkState(selected: readonly number[], depositions: readonly Pick<DepositionRow, "id" | "witnessId" | "status" | "takenOn">[], reports: readonly Pick<AnalysisRow, "id" | "depositionA" | "depositionB" | "status" | "createdAt">[]): CheckState {
  if (selected.length < 2) return { kind: "pick" };
  if (selected.length > 2) return { kind: "too_many" };
  const [a, b] = selected.map((id) => depositions.find((d) => d.id === id));
  if (!a || !b) return { kind: "pick" };
  const cross = a.witnessId !== b.witnessId;
  if (a.status !== "ready" || b.status !== "ready") return { kind: "not_ready" };
  // The dates decide which testimony came first, so a check waits for both (the server insists too).
  if (!a.takenOn || !b.takenOn) return { kind: "no_date" };
  const same = reports.filter((r) => [r.depositionA, r.depositionB].includes(a.id) && [r.depositionA, r.depositionB].includes(b.id));
  const running = same.find((r) => isActive(r.status));
  if (running) return { kind: "running", a: a.id, b: b.id, cross, report: running };
  const done = same.filter((r) => r.status === "completed").sort((x, y) => y.id - x.id)[0];
  return done ? { kind: "done", a: a.id, b: b.id, cross, report: done } : { kind: "new", a: a.id, b: b.id, cross };
}

// How many of a witness's possible session pairs have a finished report. Pure.
export function pairsChecked(sessions: readonly number[], reports: readonly Pick<AnalysisRow, "depositionA" | "depositionB" | "status">[]) {
  const total = (sessions.length * (sessions.length - 1)) / 2;
  const key = (x: number, y: number) => [x, y].sort((p, q) => p - q).join();
  const checked = new Set(reports.filter((r) => r.status === "completed" && sessions.includes(r.depositionA) && sessions.includes(r.depositionB)).map((r) => key(r.depositionA, r.depositionB)));
  return { checked: checked.size, total };
}

// Text without page numbers is stored on page 0 and cited by its line: "0:12–0:14" reads "Lines 12–14".
// Whether a line falls inside a cited "page:line-page:line" range (as the deposition link carries it). Pure.
export function inMarkedRange(mark: string, page: number, lineNo: number): boolean {
  const m = mark.match(/^(\d+):(\d+)-(\d+):(\d+)$/);
  if (!m) return false;
  const at = page * 1000 + lineNo;
  return at >= Number(m[1]) * 1000 + Number(m[2]) && at <= Number(m[3]) * 1000 + Number(m[4]);
}

export const displayRef = <T extends string | null>(ref: T): T =>
  (ref === null ? ref : ref.replace(/\b0:0*(\d+)\s*[–-]\s*0:0*(\d+)/g, "Lines $1–$2").replace(/\b0:0*(\d+)/g, "Line $1")) as T;

// The one thing to do next, for the Overview: the earliest unfinished step of the work, in order.
// Pure, so each case is testable. `waiting` is the findings awaiting a decision, in priority order.
export type NextStep =
  | { kind: "first_deposition" | "second_session"; witness?: string; caseId?: number }
  | { kind: "reading"; count: number; depositionId: number }
  | { kind: "check"; witness: string; caseId: number }
  | { kind: "running"; analysisId: number }
  | { kind: "case_running"; caseId: number; caseName: string }
  | { kind: "decide"; count: number; analysisId: number; findingId: number }
  | { kind: "export"; caseId: number; caseName: string }
  | { kind: "more" };

export function nextStep(details: CaseDetail[], running: { id: number }[], waiting: { id: number; analysisId: number }[], kept: { caseId: number }[]): NextStep {
  const all = details.flatMap((d) => d.depositions.map((x) => ({ ...x, caseId: d.case.id })));
  if (all.length === 0) return { kind: "first_deposition" };
  if (running.length) return { kind: "running", analysisId: running[0].id };
  if (waiting.length) return { kind: "decide", count: waiting.length, analysisId: waiting[0].analysisId, findingId: waiting[0].id };
  const reading = all.filter((d) => d.status === "processing");
  if (reading.length) return { kind: "reading", count: reading.length, depositionId: reading[0].id };
  for (const d of details) {
    for (const w of d.witnesses) {
      const ready = d.depositions.filter((x) => x.witnessId === w.id && x.status === "ready").map((x) => x.id);
      if (ready.length >= 2 && pairsChecked(ready, d.analyses).checked < pairsChecked(ready, d.analyses).total) return { kind: "check", witness: w.name, caseId: d.case.id };
    }
  }
  if (kept.length) {
    const d = details.find((x) => x.case.id === kept[0].caseId);
    if (d) return { kind: "export", caseId: d.case.id, caseName: d.case.name };
  }
  const lone = details.flatMap((d) => d.witnesses.filter((w) => d.depositions.filter((x) => x.witnessId === w.id).length === 1).map((w) => ({ witness: w.name, caseId: d.case.id })));
  if (lone.length) return { kind: "second_session", ...lone[0] };
  return { kind: "more" };
}
