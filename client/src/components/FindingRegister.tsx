// The findings bar of one analysis: the four categories as tabs, and under them every finding of the
// open category as a numbered button with its decision as a dot, with labelled Previous and Next. Sticky,
// so the testimony below it keeps the full width. j and k step through the findings, as in a mail
// reader; past the last one of a category, Next goes on to the next category.

import { useEffect, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, CircleHelp } from "lucide-react";
import { displayRef } from "../lib/insights";
import { GROUP_LABEL } from "../lib/labels";
import { href } from "../lib/router";
import { decisionOf, REVIEW_LABEL } from "../lib/review";
import type { FindingGroup, FindingSummary, ReviewDecision } from "../types";
import { buttonClass, cx, Tabs } from "./ui";

export const GROUPS: FindingGroup[] = ["contradictions", "needs_context", "compatible", "unverified"];
export const EMPTY: Record<FindingGroup, string> = {
  contradictions: "None found. That is Veridict's analysis of these sessions, not proof that they agree.",
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

export function FindingBar({ findings, analysisId, selected, group, onGroup, onHelp }: { findings: FindingSummary[]; analysisId: number; selected: number | null; group: FindingGroup; onGroup: (g: FindingGroup) => void; onHelp: () => void }) {
  const inGroup = findings.filter((f) => f.group === group);
  const at = inGroup.findIndex((f) => f.id === selected);
  const open = at >= 0 ? inGroup[at] : undefined;
  const prev = at > 0 ? inGroup[at - 1].id : undefined;
  const next = at >= 0 ? inGroup[at + 1]?.id : undefined;
  // After the last finding of a category: the first finding of the next category that has any.
  const nextGroup = next === undefined ? GROUPS.slice(GROUPS.indexOf(group) + 1).find((g) => findings.some((f) => f.group === g)) : undefined;
  const nextGroupFirst = nextGroup && findings.find((f) => f.group === nextGroup)!.id;
  const forward = next ?? nextGroupFirst;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest("input, textarea, select, dialog")) return;
      const to = e.key === "j" ? forward : e.key === "k" ? prev : undefined;
      if (to !== undefined) window.location.hash = href.analysis(analysisId, to);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [analysisId, forward, prev]);

  return (
    <div className="sticky top-12 z-20 -mx-4 bg-canvas px-4 pt-1 pb-3 sm:-mx-8 sm:px-8 lg:top-0">
      <div className="rounded-lg border border-line bg-sheet px-4">
        <div className="relative" data-tour="finding-tabs">
          <Tabs label="Finding categories" value={group} onChange={onGroup} items={GROUPS.map((g) => ({ id: g, label: GROUP_LABEL[g], count: findings.filter((f) => f.group === g).length }))} />
          <button type="button" onClick={onHelp} className="absolute top-0 right-0 flex h-10 items-center gap-1.5 bg-sheet pl-3 text-sm text-muted hover:text-ink max-sm:hidden">
            <CircleHelp aria-hidden className="size-4" />How to review
          </button>
        </div>
        {inGroup.length > 0 && (
          <FindingSteps
            label={`${GROUP_LABEL[group]}: findings`}
            heading={open ? `Finding ${at + 1} of ${inGroup.length}` : `${inGroup.length} findings`}
            summary={open ? (open.subject ?? open.explanation) : null}
            chips={inGroup.map((f) => ({ key: String(f.id), current: f.id === selected, decision: decisionOf(f.reviewState), title: f.subject ?? f.explanation, href: href.analysis(analysisId, f.id) }))}
            previous={prev !== undefined ? { href: href.analysis(analysisId, prev), title: "Previous finding (k)" } : undefined}
            next={forward !== undefined ? { href: href.analysis(analysisId, forward), title: next !== undefined ? "Next finding (j)" : `First finding in ${GROUP_LABEL[nextGroup!]} (j)`, label: next !== undefined ? "Next" : `Next: ${GROUP_LABEL[nextGroup!]}` } : undefined}
          />
        )}
      </div>
    </div>
  );
}

type Step = { href?: string; onClick?: () => void; title?: string; label?: string };

// One row under the category tabs: which finding is open and its summary, a numbered button per finding
// with its decision as a dot, and Previous and Next. Shared by the analysis of two sessions (links) and the
// whole-case analysis (buttons), so both read the same.
export function FindingSteps({ label, heading, summary, chips, previous, next }: {
  label: string; heading: string; summary: string | null;
  chips: { key: string; current: boolean; decision: ReviewDecision | "unreviewed"; title: string; href?: string; onClick?: () => void }[];
  previous?: Step; next?: Step;
}) {
  const step = (s: Step | undefined, variant: "primary" | "secondary", children: ReactNode) =>
    s === undefined ? <span aria-disabled className={cx(buttonClass(variant), "pointer-events-none opacity-45")}>{children}</span>
    : s.href !== undefined ? <a href={s.href} title={s.title} className={buttonClass(variant)}>{children}</a>
    : <button type="button" onClick={s.onClick} title={s.title} className={buttonClass(variant)}>{children}</button>;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 py-3">
      <p className="min-w-0 flex-1 truncate text-sm"><span className="font-semibold tabular-nums">{heading}</span>{summary && <> <span className="text-muted">{summary}</span></>}</p>
      <nav aria-label={label} data-tour="finding-chips">
        <ol className="flex flex-wrap gap-1.5">
          {chips.map((c, i) => {
            const cls = cx("relative flex size-8 items-center justify-center rounded-md text-sm tabular-nums ring-1 ring-inset transition-shadow", c.current ? "bg-sheet font-semibold text-ink ring-2 ring-ink" : "text-muted ring-line hover:bg-hover hover:ring-navy");
            const body = <>{i + 1}<span aria-hidden className={cx("absolute -top-1 -right-1 size-2.5 rounded-full", DECISION_DOT[c.decision])} /></>;
            const a11y = { "aria-current": c.current ? ("true" as const) : undefined, "aria-label": `Finding ${i + 1}, ${REVIEW_LABEL[c.decision]}`, title: `${i + 1}. ${c.title} · ${REVIEW_LABEL[c.decision]}` };
            return <li key={c.key}>{c.href !== undefined ? <a href={c.href} className={cls} {...a11y}>{body}</a> : <button type="button" onClick={c.onClick} className={cls} {...a11y}>{body}</button>}</li>;
          })}
        </ol>
      </nav>
      <span className="flex flex-none gap-2 max-sm:w-full max-sm:[&>*]:flex-1" data-tour="finding-steps">
        {step(previous, "secondary", <><ArrowLeft aria-hidden className="size-4" />{previous?.label ?? "Previous"}</>)}
        {step(next, "primary", <>{next?.label ?? "Next"}<ArrowRight aria-hidden className="size-4" /></>)}
      </span>
    </div>
  );
}
