// Figures derived from API responses. Pure, so every number on a screen traces to stored rows.

import type { CaseDetail } from "../types";
import { MOVING_RUN } from "./caseRuns";

export type Activity = { key: string; kind: "analysis" | "deposition" | "case"; title: string; subject: string; at: string; link: string };

// What happened lately across the cases: cases created, depositions uploaded, whole-case analyses started and finished.
export function recentActivity(details: CaseDetail[], links: { case: (id: number) => string; caseRun: (id: number) => string }, limit = 5): Activity[] {
  const witness = (d: CaseDetail, id: number) => d.witnesses.find((w) => w.id === id)?.name ?? "Unknown witness";
  const items = details.flatMap((d): Activity[] => [
    { key: `c${d.case.id}`, kind: "case", title: "Case created", subject: d.case.name, at: d.case.createdAt, link: links.case(d.case.id) },
    ...d.depositions.map((s): Activity => ({ key: `d${s.id}`, kind: "deposition", title: "Deposition uploaded", subject: `${witness(d, s.witnessId)}${s.pageCount ? ` (${s.pageCount} pages)` : ""}`, at: s.createdAt, link: links.case(d.case.id) })),
    ...(d.runs ?? []).map((r): Activity => ({ key: `r${r.id}`, kind: "analysis", title: r.finishedAt ? "Analysis finished" : "Analysis started", subject: `${d.case.name}${r.name ? ` / ${r.name}` : ""}`, at: r.finishedAt ?? r.createdAt, link: links.caseRun(r.id) })),
  ]);
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

export const LOW_OCR_CONFIDENCE = 85;

export function relativeTime(iso: string, now: number) {
  const minutes = Math.round((now - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

// Whether a line falls inside a cited "page:line-page:line" range (as the deposition link carries it). Pure.
export function inMarkedRange(mark: string, page: number, lineNo: number): boolean {
  const m = mark.match(/^(\d+):(\d+)-(\d+):(\d+)$/);
  if (!m) return false;
  const at = page * 1000 + lineNo;
  return at >= Number(m[1]) * 1000 + Number(m[2]) && at <= Number(m[3]) * 1000 + Number(m[4]);
}

// Text without page numbers is stored on page 0 and cited by its line: "0:12–0:14" reads "Lines 12–14".
export const displayRef = <T extends string | null>(ref: T): T =>
  (ref === null ? ref : ref.replace(/\b0:0*(\d+)\s*[–-]\s*0:0*(\d+)/g, "Lines $1–$2").replace(/\b0:0*(\d+)/g, "Line $1")) as T;

// The one thing to do next, for the Overview: the earliest unfinished step of the work, in order.
// Pure, so each case is testable. `waiting` is the findings awaiting a decision, in priority order; `kept` the
// findings kept for follow-up (each with its analysis).
export type NextStep =
  | { kind: "first_deposition" | "second_session"; witness?: string; caseId?: number }
  | { kind: "reading"; count: number; depositionId: number }
  | { kind: "check"; caseId: number; caseName: string }
  | { kind: "case_running"; caseId: number; caseName: string }
  | { kind: "decide"; count: number; runId: number }
  | { kind: "export"; runId: number; caseName: string }
  | { kind: "more" };

export function nextStep(details: CaseDetail[], waiting: { runId: number }[], kept: { runId: number; caseName: string }[]): NextStep {
  const all = details.flatMap((d) => d.depositions.map((x) => ({ ...x, caseId: d.case.id })));
  if (all.length === 0) return { kind: "first_deposition" };
  const running = details.find((d) => (d.runs ?? []).some((r) => MOVING_RUN.includes(r.status)));
  if (running) return { kind: "case_running", caseId: running.case.id, caseName: running.case.name };
  if (waiting.length) return { kind: "decide", count: waiting.length, runId: waiting[0].runId };
  const reading = all.filter((d) => d.status === "processing");
  if (reading.length) return { kind: "reading", count: reading.length, depositionId: reading[0].id };
  // A case with two sessions ready and no analysis yet.
  const unanalyzed = details.find((d) => (d.runs ?? []).length === 0 && d.depositions.filter((x) => x.status === "ready").length >= 2);
  if (unanalyzed) return { kind: "check", caseId: unanalyzed.case.id, caseName: unanalyzed.case.name };
  if (kept.length) return { kind: "export", runId: kept[0].runId, caseName: kept[0].caseName };
  const lone = details.flatMap((d) => d.witnesses.filter((w) => d.depositions.filter((x) => x.witnessId === w.id).length === 1).map((w) => ({ witness: w.name, caseId: d.case.id })));
  if (lone.length) return { kind: "second_session", ...lone[0] };
  return { kind: "more" };
}
