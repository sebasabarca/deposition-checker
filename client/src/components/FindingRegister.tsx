// The findings bar of one analysis: the four categories as tabs, and a switcher that names the open
// finding and opens a searchable list of the category's findings. Sticky, so the testimony below it
// keeps the full width. j and k step through the category, as in a mail reader.

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { displayRef } from "../lib/insights";
import { GROUP_HELP, GROUP_LABEL } from "../lib/labels";
import { href } from "../lib/router";
import { decisionOf, REVIEW_LABEL } from "../lib/review";
import type { FindingGroup, FindingSummary, ReviewDecision } from "../types";
import { cx, Search, selectClass, Tabs } from "./ui";

export const GROUPS: FindingGroup[] = ["contradictions", "needs_context", "compatible", "unverified"];
const FILTERS: (ReviewDecision | "unreviewed" | "all")[] = ["all", "unreviewed", "confirmed", "needs_context", "dismissed"];
export const EMPTY: Record<FindingGroup, string> = {
  contradictions: "None found. That is Claude's reading of these sessions, not proof that they agree.",
  needs_context: "Nothing needs more context.",
  compatible: "Nothing was judged compatible.",
  unverified: "Every citation matched the transcript.",
};

export const DECISION_DOT: Record<ReviewDecision | "unreviewed", string> = {
  unreviewed: "bg-sheet ring-1 ring-inset ring-control",
  confirmed: "bg-ok",
  needs_context: "bg-context",
  dismissed: "bg-faint",
};

// The deposition's own references, as stored; unnumbered text reads "Line N".
export const shortRef = (ref: string | null) => displayRef(ref) ?? "no reference";

export function FindingBar({ findings, analysisId, selected, group, onGroup }: { findings: FindingSummary[]; analysisId: number; selected: number | null; group: FindingGroup; onGroup: (g: FindingGroup) => void }) {
  const inGroup = findings.filter((f) => f.group === group);
  const at = inGroup.findIndex((f) => f.id === selected);
  const prev = at > 0 ? inGroup[at - 1].id : undefined;
  const next = at >= 0 ? inGroup[at + 1]?.id : undefined;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest("input, textarea, select, dialog")) return;
      const to = e.key === "j" ? next : e.key === "k" ? prev : undefined;
      if (to !== undefined) window.location.hash = href.analysis(analysisId, to);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [analysisId, next, prev]);

  return (
    <div className="sticky top-12 z-20 -mx-4 bg-canvas px-4 pt-1 pb-3 sm:-mx-8 sm:px-8 lg:top-0">
      <div className="relative flex flex-wrap items-end justify-between gap-x-6 gap-y-2 rounded-lg border border-line bg-sheet px-4">
        <Tabs label="Finding categories" value={group} onChange={onGroup} items={GROUPS.map((g) => ({ id: g, label: GROUP_LABEL[g], count: findings.filter((f) => f.group === g).length }))} />
        {inGroup.length > 0 && (
          <div className="flex items-center gap-1.5 py-2 max-sm:w-full">
            <Picker findings={inGroup} group={group} analysisId={analysisId} selected={selected} label={at >= 0 ? `Finding ${at + 1} of ${inGroup.length}` : `${inGroup.length} findings`} />
            <Step to={prev} analysisId={analysisId} label="Previous finding (k)"><ChevronLeft aria-hidden className="size-4" /></Step>
            <Step to={next} analysisId={analysisId} label="Next finding (j)"><ChevronRight aria-hidden className="size-4" /></Step>
          </div>
        )}
      </div>
    </div>
  );
}

function Step({ to, analysisId, label, children }: { to?: number; analysisId: number; label: string; children: React.ReactNode }) {
  const classes = "flex size-8 flex-none items-center justify-center rounded-md ring-1 ring-inset ring-control";
  if (to === undefined) return <span aria-hidden className={cx(classes, "text-control")}>{children}</span>;
  return <a href={href.analysis(analysisId, to)} aria-label={label} title={label} className={cx(classes, "bg-sheet text-ink hover:bg-hover")}>{children}</a>;
}

// The switcher: a button naming the open finding, and below it the category's findings with a
// search and a decision filter. Closes on a choice, a click outside, or Escape.
function Picker({ findings, group, analysisId, selected, label }: { findings: FindingSummary[]; group: FindingGroup; analysisId: number; selected: number | null; label: string }) {
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState<(typeof FILTERS)[number]>("all");
  const [q, setQ] = useState("");
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => setOpen(false), [selected, group]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return findings.filter((f) => (decision === "all" || decisionOf(f.reviewState) === decision) && (!term || [f.a.ref, f.b.ref, f.subject, f.explanation].some((s) => s?.toLowerCase().includes(term))));
  }, [findings, decision, q]);

  return (
    <div ref={root} className="max-sm:flex-1 sm:relative">
      <button type="button" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((o) => !o)} className="flex h-8 w-full items-center justify-between gap-2 rounded-md bg-navy px-3 text-sm font-semibold text-white tabular-nums hover:bg-navy-3">
        {label}
        <ChevronDown aria-hidden className={cx("size-4 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 flex max-h-[min(34rem,calc(100vh-10rem))] flex-col overflow-hidden rounded-lg border border-line bg-sheet shadow-[0_16px_40px_-12px_rgb(19_33_58/0.35)] sm:inset-x-auto sm:top-10 sm:right-0 sm:mt-0 sm:w-[30rem]">
          <p className="border-b border-rule px-4 py-2.5 text-xs leading-4 text-muted">{GROUP_HELP[group]}</p>
          <div className="flex gap-2 border-b border-rule px-4 py-3">
            <Search value={q} onChange={setQ} label="Search wording or page:line" className="min-w-0 flex-1" />
            <label className="sr-only" htmlFor="decision-filter">Decision</label>
            <select id="decision-filter" value={decision} onChange={(e) => setDecision(e.target.value as typeof decision)} className={cx(selectClass, "w-36 flex-none")}>
              {FILTERS.map((d) => <option key={d} value={d}>{d === "all" ? "Any decision" : REVIEW_LABEL[d]}</option>)}
            </select>
          </div>
          {shown.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted">No findings match this search or filter.</p>
          ) : (
            <ol className="overflow-y-auto">
              {shown.map((f) => <Row key={f.id} f={f} n={findings.indexOf(f) + 1} analysisId={analysisId} active={f.id === selected} />)}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ f, n, analysisId, active }: { f: FindingSummary; n: number; analysisId: number; active: boolean }) {
  const decided = decisionOf(f.reviewState);
  return (
    <li className="border-b border-rule last:border-b-0">
      <a href={href.analysis(analysisId, f.id)} aria-current={active ? "true" : undefined} className={cx("grid grid-cols-[1.75rem_1fr_auto] gap-x-2 gap-y-1 px-4 py-3 transition-colors", active ? "bg-info-bg" : "hover:bg-hover")}>
        <span className="pt-px text-sm text-faint tabular-nums">{n}.</span>
        <span className="line-clamp-2 text-[14px] leading-5 font-medium">{f.subject ?? f.explanation}</span>
        <span title={REVIEW_LABEL[decided]} className="mt-1.5 flex items-center"><span aria-hidden className={cx("size-2.5 rounded-full", DECISION_DOT[decided])} /><span className="sr-only">{REVIEW_LABEL[decided]}</span></span>
        <span className="col-start-2 col-end-4 flex flex-wrap items-center gap-x-2 font-mono text-[12px] text-muted">
          <span>{shortRef(f.a.ref)}</span>
          <ArrowLeftRight aria-hidden className="size-3 text-faint" />
          <span>{shortRef(f.b.ref)}</span>
          {f.group === "contradictions" && f.priority === "high" && <span className="font-sans text-[11px] font-semibold text-conflict">High priority</span>}
        </span>
      </a>
    </li>
  );
}
