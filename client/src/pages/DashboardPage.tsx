import { useMemo } from "react";
import { ChartColumn, CircleCheck, FileText, Folder, Plus, RefreshCw } from "lucide-react";
import { AnalysesTable } from "../components/AnalysesTable";
import { Alert, buttonClass, Card, cx, Empty, Loading, Metric, PageHeader } from "../components/ui";
import { countClassifications, isActive, recentActivity, relativeTime, type Activity } from "../lib/insights";
import { href } from "../lib/router";
import { useWorkspace, useWorkspaceFindings } from "../lib/workspace";

const ACTIVITY_ICON = {
  analysis: { icon: CircleCheck, tone: "bg-success-container text-success" },
  deposition: { icon: FileText, tone: "bg-surface-container-low text-on-surface-variant" },
  case: { icon: Folder, tone: "bg-surface-container-low text-on-surface-variant" },
} satisfies Record<Activity["kind"], unknown>;

const greeting = (hour: number) => (hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening");

export function DashboardPage() {
  const { data, error } = useWorkspace();
  const { findings } = useWorkspaceFindings(data);
  const activity = useMemo(() => (data ? recentActivity(data.details, { case: href.case, analysis: (id) => href.analysis(id) }) : []), [data]);
  const split = countClassifications(findings ?? []);
  const actions = <a href={href.depositions()} className={buttonClass("primary")}><Plus aria-hidden className="size-4" />New analysis</a>;
  const header = <PageHeader title={greeting(new Date().getHours())} description="Track your cases, depositions, and analysis progress." actions={actions} />;

  if (error) return <>{header}<Alert title="The workspace couldn't be loaded">{error}</Alert></>;
  if (!data) return <>{header}<Loading /></>;
  if (data.cases.length === 0) return <>{header}<Empty title="No cases yet">Create a case, then upload two deposition sessions. <a className="font-semibold text-secondary" href={href.cases()}>Go to cases</a></Empty></>;

  return (
    <>
      {header}
      <div className="grid gap-space-lg sm:grid-cols-2 xl:grid-cols-4">
        <Metric icon={Folder} value={data.cases.length} label="Cases" />
        <Metric icon={FileText} value={data.cases.reduce((n, c) => n + c.depositions, 0)} label="Depositions" />
        <Metric icon={RefreshCw} value={data.analyses.filter((a) => isActive(a.status)).length} label="Analyses running" />
        <Metric icon={ChartColumn} value={findings ? findings.length : "–"} label="Findings" note={findings ? `${split.direct} direct · ${split.inferential} inferential` : undefined} />
      </div>
      <section className="space-y-space-md">
        <div className="flex items-center justify-between">
          <h2 className="text-headline-lg">Recent analyses</h2>
          <a href={href.analyses()} className={buttonClass("ghost")}>View all</a>
        </div>
        <Card className="overflow-hidden"><AnalysesTable analyses={data.analyses.slice(0, 5)} details={data.details} /></Card>
      </section>
      <section className="space-y-space-md">
        <h2 className="text-headline-lg">Recent activity</h2>
        <Card className="p-space-md">
          <ul className="flex flex-col gap-space-xs">
            {activity.map((a) => {
              const { icon: Icon, tone } = ACTIVITY_ICON[a.kind];
              return (
                <li key={a.key}>
                  <a href={a.link} className="flex items-center justify-between gap-space-md rounded-lg p-space-sm transition-colors hover:bg-surface-container-low/50">
                    <span className="flex min-w-0 items-center gap-space-md">
                      <span className={cx("flex size-8 flex-none items-center justify-center rounded-full", tone)}><Icon aria-hidden className="size-[18px]" strokeWidth={1.75} /></span>
                      <span className="truncate"><span className="font-medium">{a.title}</span> <span className="text-on-surface-variant">— {a.subject}</span></span>
                    </span>
                    <span className="flex-none text-body-sm text-outline tabular-nums">{relativeTime(a.at, Date.now())}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </Card>
      </section>
    </>
  );
}
