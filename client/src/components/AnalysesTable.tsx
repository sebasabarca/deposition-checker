import { href } from "../lib/router";
import { ANALYSIS_STATUS, formatDate, formatUsd } from "../lib/labels";
import { progressShare } from "../lib/insights";
import type { AnalysisView, CaseDetail } from "../types";
import { Badge, cx, Empty, Meter, tdClass, thClass } from "./ui";

export function AnalysesTable({ analyses, details }: { analyses: AnalysisView[]; details: CaseDetail[] }) {
  if (analyses.length === 0) return <div className="p-space-md"><Empty title="No analyses yet">Open a case and compare two ready sessions of one witness.</Empty></div>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[56rem] border-collapse text-left">
        <thead className="bg-surface-container-low text-on-surface-variant">
          <tr>
            {["Case", "Deposition", "Status", "Progress", "Findings", "Cost"].map((h) => <th key={h} className={thClass}>{h}</th>)}
            <th className={cx(thClass, "text-right")}>Updated</th>
          </tr>
        </thead>
        <tbody>
          {analyses.map((a) => {
            const s = ANALYSIS_STATUS[a.status];
            return (
              <tr key={a.id} className="group transition-colors hover:bg-surface-container-low/70">
                <td className={tdClass}>
                  <a href={href.analysis(a.id)} className="font-semibold group-hover:text-secondary">{details.find((d) => d.case.id === a.caseId)?.case.name ?? `Case ${a.caseId}`}</a>
                </td>
                <td className={cx(tdClass, "text-on-surface-variant")}>
                  {a.depositions[0]?.witness}
                  <span className="block text-label-sm text-outline">{formatDate(a.depositions[0]?.takenOn ?? null)} vs. {formatDate(a.depositions[1]?.takenOn ?? null)}</span>
                </td>
                <td className={tdClass}>
                  <Badge tone={s.tone} dot>{s.label}</Badge>
                  {a.mode === "demo" && <span className="mt-1 block text-label-sm text-outline">Demo: no model calls</span>}
                </td>
                <td className={tdClass}><Meter value={progressShare(a.status, a.progress)} label={`Analysis ${a.id} progress`} tone={s.tone === "bad" ? "bad" : undefined} /></td>
                <td className={tdClass}>
                  <span className="font-semibold tabular-nums">{a.findings.total}</span>
                  <span className="block text-label-sm text-outline">{a.findings.groups.contradictions} potential contradictions</span>
                </td>
                <td className={cx(tdClass, "tabular-nums")}>{a.mode === "demo" ? "$0.00" : formatUsd(a.cost.actualUsd)}</td>
                <td className={cx(tdClass, "text-right text-body-sm whitespace-nowrap text-outline")}>
                  {formatDate(a.updatedAt)}
                  <span className="block text-label-sm">{new Date(a.updatedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
