// The findings bar of one analysis: the four categories as tabs, and under them every finding of the
// open category as a numbered chip, coloured by its decision, with labelled Previous and Next. Sticky,
// so the testimony below it keeps the full width. j and k step through the findings, as in a mail
// reader; past the last one of a category, Next goes on to the next category.

import { useEffect } from "react";
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

const CHIP: Record<ReviewDecision | "unreviewed", string> = {
  unreviewed: "bg-sheet text-ink ring-control",
  confirmed: "bg-ok-bg text-ok ring-ok/35",
  needs_context: "bg-context-bg text-context ring-context/35",
  dismissed: "bg-rule text-faint ring-transparent line-through",
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
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 py-3">
            <nav aria-label={`${GROUP_LABEL[group]}: findings`} className="min-w-0 flex-1" data-tour="finding-chips">
              <div className="flex items-baseline gap-2 text-sm">
                <span className="flex-none font-semibold tabular-nums">{open ? `Finding ${at + 1} of ${inGroup.length}` : `${inGroup.length} findings`}</span>
                {open && <span className="truncate text-muted">{open.subject ?? open.explanation}</span>}
              </div>
              <ol className="mt-2 flex flex-wrap gap-1.5">
                {inGroup.map((f, i) => {
                  const d = decisionOf(f.reviewState);
                  const here = f.id === selected;
                  return (
                    <li key={f.id}>
                      <a
                        href={href.analysis(analysisId, f.id)}
                        aria-current={here ? "true" : undefined}
                        aria-label={`Finding ${i + 1}, ${REVIEW_LABEL[d]}`}
                        title={`${i + 1}. ${f.subject ?? f.explanation} · ${REVIEW_LABEL[d]}`}
                        className={cx("flex h-8 min-w-8 items-center justify-center rounded-md px-2 text-sm font-medium tabular-nums ring-1 ring-inset transition-shadow hover:ring-navy", CHIP[d], here && "ring-2 ring-navy font-semibold")}
                      >
                        {i + 1}
                      </a>
                    </li>
                  );
                })}
              </ol>
            </nav>
            <div className="flex flex-none flex-col items-end gap-2 max-sm:w-full max-sm:items-stretch" data-tour="finding-steps">
              <div className="flex gap-2 max-sm:[&>*]:flex-1">
                {prev !== undefined
                  ? <a href={href.analysis(analysisId, prev)} className={buttonClass("secondary")} title="Previous finding (k)"><ArrowLeft aria-hidden className="size-4" />Previous</a>
                  : <span aria-disabled className={cx(buttonClass("secondary"), "pointer-events-none opacity-45")}><ArrowLeft aria-hidden className="size-4" />Previous</span>}
                {forward !== undefined
                  ? <a href={href.analysis(analysisId, forward)} className={buttonClass("primary")} title={next !== undefined ? "Next finding (j)" : `First finding in ${GROUP_LABEL[nextGroup!]} (j)`}>{next !== undefined ? "Next" : `Next: ${GROUP_LABEL[nextGroup!]}`}<ArrowRight aria-hidden className="size-4" /></a>
                  : <span aria-disabled className={cx(buttonClass("primary"), "pointer-events-none opacity-45")}>Next<ArrowRight aria-hidden className="size-4" /></span>}
              </div>
              <Legend />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Legend() {
  return (
    <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted max-sm:hidden">
      {(["unreviewed", "confirmed", "needs_context", "dismissed"] as const).map((d) => (
        <span key={d} className="flex items-center gap-1.5"><span aria-hidden className={cx("size-2.5 rounded-full", DECISION_DOT[d])} />{REVIEW_LABEL[d]}</span>
      ))}
    </p>
  );
}
