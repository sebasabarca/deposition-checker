// Every whole-case analysis across cases, newest first, with its status (a running one with its progress).

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { Alert, Badge, Card, cx, Empty, Loading, PageHeader, rowClass, selectClass, Tabs, tdClass, thClass } from "../components/ui";
import { runTitle } from "../components/CaseRuns";
import { EXECUTION, isAnalysis, isTestRun, isUnusedEstimate, MOVING_RUN, RUN_STATUS } from "../lib/caseRuns";
import { formatDate, formatUsd } from "../lib/labels";
import { href, usePoll } from "../lib/router";
import { useWorkspace } from "../lib/workspace";
import type { CaseRun } from "../types";

type View = "all" | "running" | "completed" | "stopped";
const VIEWS: { id: View; label: string }[] = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "completed", label: "Finished" },
  { id: "stopped", label: "Stopped" },
];
const runBucket = (r: CaseRun): View => (MOVING_RUN.includes(r.status) ? "running" : r.status === "completed" ? "completed" : "stopped");

// Every case's whole-case analyses, newest first: those that ran or are running, never an estimate nobody confirmed.
function useAllCaseRuns(caseIds: number[]) {
  const [runs, setRuns] = useState<CaseRun[] | null>(null);
  const key = caseIds.join(",");
  const load = useCallback(() => {
    const ids = key ? key.split(",").map(Number) : [];
    Promise.all(ids.map((id) => api.caseRuns(id).then((r) => r.caseRuns, () => [] as CaseRun[])))
      .then((all) => setRuns(all.flat().filter((r) => isAnalysis(r) && !isUnusedEstimate(r)).sort((a, b) => b.id - a.id)));
  }, [key]);
  useEffect(load, [load]);
  usePoll(!!runs?.some((r) => MOVING_RUN.includes(r.status)), 5000, load);
  return runs;
}

export function AnalysesPage() {
  const { data, error } = useWorkspace();
  const [view, setView] = useState<View>("all");
  const [caseId, setCaseId] = useState("");
  const inCase = (id: number) => !caseId || String(id) === caseId;
  const caseNames = useMemo(() => new Map((data?.cases ?? []).map((c) => [c.id, c.name])), [data]);
  const caseRuns = useAllCaseRuns((data?.cases ?? []).map((c) => c.id));
  const runsInCase = (caseRuns ?? []).filter((r) => inCase(r.caseId));
  const runRows = runsInCase.filter((r) => view === "all" || runBucket(r) === view);

  if (error) return <Alert title="Analyses couldn't be loaded">{error}</Alert>;
  const spent = runsInCase.reduce((n, r) => n + (isTestRun(r) ? 0 : r.cost.costUsd), 0);
  const count = (v: View) => (v === "all" ? runsInCase.length : runsInCase.filter((r) => runBucket(r) === v).length);
  return (
    <>
      <PageHeader title="Analyses" description={data && caseRuns ? `Every analysis across your cases, newest first. ${formatUsd(spent)} spent on the ${runsInCase.length} shown.` : undefined} />
      {!data || !caseRuns ? <Loading label="Loading analyses" /> : (caseRuns ?? []).length === 0 ? (
        <Empty title="No analyses yet">Open a case and follow its steps to analyze it.</Empty>
      ) : (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-end justify-between gap-3 px-5">
            {/* flex-none: as a scrolling flex item the tab row would shrink below its labels and show a scrollbar over them */}
            <div className="max-w-full flex-none">
              <Tabs label="Status" value={view} onChange={setView} items={VIEWS.map((v) => ({ id: v.id, label: v.label, count: count(v.id) }))} />
            </div>
            <label className="py-2">
              <span className="sr-only">Case</span>
              <select value={caseId} onChange={(e) => setCaseId(e.target.value)} className={cx(selectClass, "w-56")}>
                <option value="">All cases</option>
                {data.cases.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          </div>
          {runRows.length === 0 ? <p className="border-t border-line px-5 py-6 text-sm text-muted">No analyses in this view.</p> : <div className="border-t border-line"><CaseRunsTable runs={runRows} caseNames={caseNames} /></div>}
        </Card>
      )}
    </>
  );
}

// One row per whole-case analysis: what it is, where it stands (a running one with its share read), and what it found.
function CaseRunsTable({ runs, caseNames }: { runs: CaseRun[]; caseNames: Map<number, string> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem] text-sm">
        <thead>
          <tr>
            <th className={thClass}>Analysis</th>
            <th className={thClass}>Case</th>
            <th className={thClass}>Status</th>
            <th className={cx(thClass, "text-right")}>Findings</th>
            <th className={cx(thClass, "text-right")}>Decided</th>
            <th className={cx(thClass, "text-right")}>Cost</th>
            <th className={cx(thClass, "text-right")}>Started</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const s = RUN_STATUS[r.status];
            const found = r.findings.reduce((n, f) => n + f.n, 0);
            const pct = r.packets.total ? Math.min(100, Math.floor((r.packets.adjudicated / r.packets.total) * 100)) : 0;
            return (
              <tr key={r.id} className={cx(rowClass, "cursor-pointer")} onClick={(e) => !(e.target as HTMLElement).closest("a") && (window.location.hash = href.caseRun(r.id))}>
                <td className={tdClass}>
                  <a href={href.caseRun(r.id)} className="font-semibold hover:underline">{runTitle(r)}</a>
                  <span className="block text-xs text-muted">{[!r.scope || r.scope.kind === "case" ? "Whole case" : `${r.scope.depositionIds.length} depositions`, r.contract === "stretch-v2" ? "Contextual" : "Focused", EXECUTION[r.execution].short].join(" · ")}</span>
                </td>
                <td className={cx(tdClass, "text-muted")}>{caseNames.get(r.caseId) ?? "–"}</td>
                <td className={tdClass}>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={s.tone} dot>{s.label}</Badge>
                    {isTestRun(r) && <Badge tone="accent">Test model</Badge>}
                  </span>
                  {r.status === "adjudicating" && (
                    <span className="mt-1.5 flex items-center gap-2 text-xs text-muted tabular-nums">
                      <span aria-hidden className="block h-1 w-24 overflow-hidden rounded-full bg-rule"><span className="block h-full rounded-full bg-navy" style={{ width: `${Math.max(pct, 2)}%` }} /></span>
                      {pct}% read
                    </span>
                  )}
                </td>
                <td className={cx(tdClass, "text-right tabular-nums", found > 0 && "font-semibold")}>{found.toLocaleString()}</td>
                <td className={cx(tdClass, "text-right tabular-nums text-muted")}>{found > 0 ? `${Math.min(r.reviewed ?? 0, found).toLocaleString()} of ${found.toLocaleString()}` : "–"}</td>
                <td className={cx(tdClass, "text-right tabular-nums text-muted")}>{isTestRun(r) ? "$0" : formatUsd(r.cost.costUsd)}</td>
                <td className={cx(tdClass, "text-right tabular-nums text-muted whitespace-nowrap")}>{formatDate(r.createdAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
