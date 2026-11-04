// A case's findings by review priority, at the top of the case page: what needs the reviewer first.
// Reads the findings of the case's finished analyses through the same endpoint the analysis page uses.

import { useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, CircleAlert } from "lucide-react";
import { Card, CardHeader, cx } from "./ui";
import { DECISION_DOT, shortRef } from "./FindingRegister";
import { api } from "../lib/api";
import { evidenceCheck, prioritySections, type PrioritySection } from "../lib/findingFilters";
import { isActive } from "../lib/insights";
import { analysisTitle, findingHeadline, GROUP_HELP, PRIORITY } from "../lib/labels";
import { decisionOf, REVIEW_LABEL } from "../lib/review";
import { href } from "../lib/router";
import type { AnalysisView, FindingSummary } from "../types";

type Row = FindingSummary & { analysis: AnalysisView };
const SHOWN = 5; // rows per section before "Show all"
const HELP: Record<PrioritySection, string> = {
  high: "Potential contradictions with the strongest supporting evidence.",
  medium: "Potential contradictions with moderate supporting evidence.",
  low: "Potential contradictions with weaker supporting evidence.",
  needs_context: GROUP_HELP.needs_context,
  unverified: GROUP_HELP.unverified,
};

export function CaseFindings({ analyses }: { analyses: AnalysisView[] }) {
  const finished = useMemo(() => analyses.filter((a) => !isActive(a.status) && a.findings.total > 0), [analyses]);
  const key = finished.map((a) => `${a.id}:${a.status}:${a.findings.total}:${a.findings.decided}`).join(",");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all(finished.map((a) => api.findings(a.id).then((r) => r.groups.flatMap((g) => g.findings.map((f) => ({ ...f, analysis: a }))))))
      .then((all) => live && (setRows(all.flat()), setError(null)))
      .catch((e: Error) => live && setError(e.message));
    return () => { live = false; };
    // `key` changes exactly when a finished analysis or its findings change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (finished.length === 0) return null;
  const { sections, compatible } = prioritySections(rows ?? []);
  const toReview = sections.reduce((n, s) => n + s.findings.length, 0);
  const examples = (rows ?? []).some((f) => f.source === "fixture");
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Findings by review priority"
        count={rows?.length}
        description={`${toReview} to review${compatible.length ? ` · ${compatible.length} compatible` : ""} · leads, not conclusions${examples ? " · example findings, written by hand" : ""}`}
      />
      {error ? <p className="px-5 py-4 text-sm text-conflict" role="alert">The findings couldn't be loaded: {error}</p> : !rows ? <p className="px-5 py-4 text-sm text-muted">Loading findings…</p> : (
        <div className="divide-y divide-rule">
          {sections.filter((s) => s.findings.length > 0).map((s) => <Section key={s.id} id={s.id} findings={s.findings} />)}
          {toReview === 0 && <p className="px-5 py-4 text-sm text-muted">Nothing to review: every finding of these analyses was assessed as compatible.</p>}
        </div>
      )}
    </Card>
  );
}

function Section({ id, findings }: { id: PrioritySection; findings: Row[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? findings : findings.slice(0, SHOWN);
  return (
    <section aria-labelledby={`priority-${id}`} className="px-5 py-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 id={`priority-${id}`} className="text-sm font-semibold">{PRIORITY[id]} <span className="font-normal text-muted tabular-nums">{findings.length}</span></h3>
        <p className="text-xs text-muted">{HELP[id]}</p>
      </div>
      <ul className="mt-2 space-y-1">
        {shown.map((f) => <FindingRow key={f.id} f={f} />)}
      </ul>
      {findings.length > SHOWN && (
        <button type="button" onClick={() => setAll((x) => !x)} className="mt-2 text-sm font-medium text-ink hover:underline">
          {all ? "Show fewer" : `Show all ${findings.length}`}
        </button>
      )}
    </section>
  );
}

function FindingRow({ f }: { f: Row }) {
  const d = decisionOf(f.reviewState);
  const unverified = evidenceCheck(f.evidenceStatus) === "not_verified";
  return (
    <li>
      <a href={href.analysis(f.analysis.id, f.id)} className="-mx-2 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-0.5 rounded-md px-2 py-1.5 hover:bg-hover sm:grid-cols-[minmax(0,1fr)_12rem_9rem]">
        <span className="min-w-0">
          <span className="line-clamp-2 text-sm font-medium">{f.subject ?? f.explanation}</span>
          <span className="block text-xs text-muted">
            {analysisTitle(f.analysis)} · {findingHeadline(f)}
            {unverified && <span className="text-conflict"> · <CircleAlert aria-hidden className="inline size-3 align-[-1px]" /> Citation not verified</span>}
          </span>
        </span>
        <span className="hidden items-center gap-1.5 font-mono text-[12px] whitespace-nowrap text-muted sm:flex">{shortRef(f.a.ref)}<ArrowLeftRight aria-hidden className="size-3 text-faint" />{shortRef(f.b.ref)}</span>
        <span className="flex items-center gap-2 text-sm whitespace-nowrap"><span aria-hidden className={cx("size-2.5 rounded-full", DECISION_DOT[d])} />{REVIEW_LABEL[d]}</span>
      </a>
    </li>
  );
}
