// Overview: what is waiting for the reviewer. Findings to decide lead; checks and depositions that
// need attention sit beside them; the cases follow.

import { ArrowRight, ArrowLeftRight } from "lucide-react";
import { Alert, Badge, buttonClass, Card, CardHeader, cx, Empty, Loading, PageHeader, rowClass, Stat, tdClass, thClass } from "../components/ui";
import { useAddDeposition } from "../components/Shell";
import { isActive, relativeTime } from "../lib/insights";
import { ANALYSIS_STATUS, DEPOSITION_STATUS, findingHeadline, formatDate } from "../lib/labels";
import { href } from "../lib/router";
import { shortRef } from "../components/FindingRegister";
import { useWorkspace, useWorkspaceFindings, type WorkspaceFinding } from "../lib/workspace";

const RANK = { high: 0, medium: 1, needs_context: 2, low: 3, unverified: 4 } as const;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export function OverviewPage() {
  const { data, error } = useWorkspace();
  const { findings } = useWorkspaceFindings(data);
  const add = useAddDeposition();
  if (error) return <Alert title="The overview couldn't be loaded">{error}</Alert>;
  if (!data) return <><PageHeader title="Overview" /><Loading /></>;

  const waiting = (findings ?? []).filter((f) => (f.group === "contradictions" || f.group === "needs_context") && f.reviewState === "unreviewed").sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.rank - b.rank);
  const kept = (findings ?? []).filter((f) => f.reviewState === "confirmed").length;
  const depositions = data.details.flatMap((d) => d.depositions.map((x) => ({ ...x, caseName: d.case.name, caseId: d.case.id, witness: d.witnesses.find((w) => w.id === x.witnessId)?.name ?? "Unknown witness" })));
  const attention = depositions.filter((d) => d.status !== "ready").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const running = data.analyses.filter((a) => isActive(a.status));
  const recentChecks = [...running, ...data.analyses.filter((a) => !isActive(a.status))].slice(0, 5);
  const casesWaiting = new Set(waiting.map((f) => f.caseName)).size;
  const now = Date.now();

  if (data.cases.length === 0) {
    return (
      <>
        <PageHeader title="Overview" description="Veridict compares a witness's deposition sessions and shows where the testimony may conflict, line by line." />
        <Empty title="Start with a deposition" action={<button type="button" onClick={() => add.open()} className={buttonClass("primary")}>Add deposition</button>}>
          Add two sessions of the same witness, as PDF or text. Veridict reads them into page and line references, then you can check them against each other.
        </Empty>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Overview"
        description={findings === null ? "Counting what's waiting for you…" : waiting.length ? `${plural(waiting.length, "finding")} ${waiting.length === 1 ? "is" : "are"} waiting for your decision across ${plural(casesWaiting, "case")}.` : "Nothing is waiting for your decision."}
      />

      <Card className="grid grid-cols-2 divide-rule max-md:[&>*:nth-child(-n+2)]:border-b max-md:[&>*:nth-child(-n+2)]:border-rule md:grid-cols-4 md:divide-x">
        <Stat label="Waiting for your decision" value={findings === null ? "–" : waiting.length} tone={waiting.length ? "bad" : undefined} note={waiting.filter((f) => f.priority === "high").length ? `${waiting.filter((f) => f.priority === "high").length} high priority` : undefined} />
        <Stat label="Kept for follow-up" value={findings === null ? "–" : kept} />
        <Stat label="Checks running" value={running.length} note={running.length ? "About 10 minutes each" : undefined} />
        <Stat label="Depositions ready" value={<>{depositions.filter((d) => d.status === "ready").length}<span className="text-sm font-normal text-faint"> of {depositions.length}</span></>} note={plural(data.cases.length, "case")} />
      </Card>

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_23rem]">
        <Card>
          <CardHeader title="Waiting for your decision" count={findings ? waiting.length : undefined} action={<a href={href.findings()} className="text-sm font-medium text-info hover:underline">All findings</a>} />
          {findings === null ? (
            <div className="px-5 py-3"><Loading rows={4} /></div>
          ) : waiting.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted">Every potential contradiction has a decision. New checks will add findings here.</p>
          ) : (
            <ol>{waiting.slice(0, 6).map((f) => <WaitingRow key={f.id} f={f} />)}</ol>
          )}
          {waiting.length > 6 && <a href={href.findings()} className="flex h-11 items-center justify-center gap-1.5 border-t border-rule text-sm font-medium text-ink hover:bg-hover">View all {waiting.length}<ArrowRight aria-hidden className="size-4" /></a>}
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Checks" action={<a href={href.analyses()} className="text-sm font-medium text-info hover:underline">All analyses</a>} />
            {recentChecks.length === 0 ? (
              <p className="px-5 py-5 text-sm text-muted">No checks yet. Open a case and select two sessions of one witness.</p>
            ) : (
              <ul className="divide-y divide-rule">
                {recentChecks.map((a) => {
                  const s = ANALYSIS_STATUS[a.status];
                  return (
                    <li key={a.id}>
                      <a href={href.analysis(a.id)} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-hover">
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{a.depositions[0].witness}</span>
                          <span className="block truncate text-xs text-muted">{formatDate(a.depositions[0].takenOn)} and {formatDate(a.depositions[1].takenOn)}</span>
                        </span>
                        {a.status === "completed" ? <span className="flex-none text-xs text-muted tabular-nums">{a.findings.decided} of {a.findings.total} decided</span> : <Badge tone={s.tone} dot>{isActive(a.status) ? "Checking" : s.label}</Badge>}
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title="Depositions" action={<a href={href.depositions()} className="text-sm font-medium text-info hover:underline">All depositions</a>} />
            {attention.length === 0 ? (
              <p className="px-5 py-5 text-sm text-muted">All {plural(depositions.length, "deposition")} are read and ready to check.</p>
            ) : (
              <ul className="divide-y divide-rule">
                {attention.slice(0, 4).map((d) => (
                  <li key={d.id}>
                    <a href={href.deposition(d.id)} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-hover">
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{d.witness}, {formatDate(d.takenOn)}</span>
                        <span className="block truncate text-xs text-muted">{d.caseName}</span>
                      </span>
                      <Badge tone={DEPOSITION_STATUS[d.status].tone} dot>{DEPOSITION_STATUS[d.status].label}</Badge>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <Card className="overflow-hidden">
        <CardHeader title="Cases" count={data.cases.length} action={<a href={href.cases()} className="text-sm font-medium text-info hover:underline">All cases</a>} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead><tr><th className={thClass}>Case</th><th className={thClass}>Witnesses</th><th className={cx(thClass, "text-right")}>Depositions</th><th className={cx(thClass, "text-right")}>To decide</th><th className={cx(thClass, "text-right")}>Last activity</th></tr></thead>
            <tbody>
              {data.cases.slice(0, 5).map((c) => (
                <tr key={c.id} className={rowClass}>
                  <td className={tdClass}><a href={href.case(c.id)} className="font-medium hover:underline">{c.name}</a></td>
                  <td className={cx(tdClass, "text-muted")}>{c.witnessNames.join(", ") || "–"}</td>
                  <td className={cx(tdClass, "text-right tabular-nums")}>{c.depositions}</td>
                  <td className={cx(tdClass, "text-right tabular-nums", c.needsReview > 0 && "font-semibold text-conflict")}>{c.needsReview}</td>
                  <td className={cx(tdClass, "text-right text-muted tabular-nums")}>{relativeTime(c.lastActivity, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

function WaitingRow({ f }: { f: WorkspaceFinding }) {
  return (
    <li className="border-t border-rule first:border-t-0">
      <a href={href.analysis(f.analysis.id, f.id)} className="group grid grid-cols-1 items-start gap-x-4 gap-y-1.5 px-5 py-3.5 hover:bg-hover sm:grid-cols-[1fr_auto]">
        <span className="line-clamp-2 min-w-0 font-medium leading-5 group-hover:underline">{f.subject ?? f.explanation}</span>
        <Badge tone={f.group === "contradictions" ? (f.priority === "high" ? "contradiction" : "neutral") : "warn"}>{f.group === "contradictions" ? (f.priority === "high" ? "High priority" : findingHeadline(f)) : "Needs context"}</Badge>
        <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted sm:col-span-2">
          <span>{f.analysis.depositions[0].witness}</span>
          <span aria-hidden>·</span>
          <span className="truncate">{f.caseName}</span>
          <span aria-hidden>·</span>
          <span className="flex items-center gap-1.5 font-mono text-[12px]">{shortRef(f.a.ref)}<ArrowLeftRight aria-hidden className="size-3 text-faint" />{shortRef(f.b.ref)}</span>
        </span>
      </a>
    </li>
  );
}
