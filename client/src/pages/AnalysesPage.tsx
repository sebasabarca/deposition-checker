// Every analysis across cases, with its status, newest first.

import { useMemo, useState } from "react";
import { Alert, Card, cx, Empty, Loading, PageHeader, selectClass, Tabs } from "../components/ui";
import { isActive } from "../lib/insights";
import { formatUsd } from "../lib/labels";
import { useWorkspace } from "../lib/workspace";
import { AnalysesTable } from "./CasePage";

type View = "all" | "running" | "completed" | "stopped";

export function AnalysesPage() {
  const { data, error } = useWorkspace();
  const [view, setView] = useState<View>("all");
  const [caseId, setCaseId] = useState("");
  const all = useMemo(() => [...(data?.analyses ?? [])].sort((a, b) => b.id - a.id).filter((a) => !caseId || String(a.caseId) === caseId), [data, caseId]);
  const bucket = (a: (typeof all)[number]): View => (isActive(a.status) ? "running" : a.status === "completed" ? "completed" : "stopped");
  const rows = all.filter((a) => view === "all" || bucket(a) === view);
  const caseNames = useMemo(() => new Map((data?.cases ?? []).map((c) => [c.id, c.name])), [data]);

  if (error) return <Alert title="Analyses couldn't be loaded">{error}</Alert>;
  const spent = all.reduce((n, a) => n + a.cost.actualUsd, 0);
  return (
    <>
      <PageHeader title="Analyses" description={data ? `Each analysis checks two sessions of one witness against each other. ${formatUsd(spent)} spent on the ${all.length} shown.` : undefined} />
      {!data ? <Loading /> : data.analyses.length === 0 ? (
        <Empty title="No analyses yet">Open a case and select two sessions of the same witness to start one.</Empty>
      ) : (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-end justify-between gap-3 px-5">
            <Tabs label="Status" value={view} onChange={setView} items={(["all", "running", "completed", "stopped"] as View[]).map((v) => ({ id: v, label: { all: "All", running: "Running", completed: "Finished", stopped: "Stopped" }[v], count: v === "all" ? all.length : all.filter((a) => bucket(a) === v).length }))} />
            <label className="py-2">
              <span className="sr-only">Case</span>
              <select value={caseId} onChange={(e) => setCaseId(e.target.value)} className={cx(selectClass, "w-56")}>
                <option value="">All cases</option>
                {data.cases.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          </div>
          {rows.length === 0 ? <p className="border-t border-line px-5 py-6 text-sm text-muted">No analyses in this view.</p> : <div className="border-t border-line"><AnalysesTable analyses={rows} caseNames={caseNames} /></div>}
        </Card>
      )}
    </>
  );
}
