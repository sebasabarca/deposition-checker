// Every finding across cases, filtered by case, category and decision.

import { useMemo, useState } from "react";
import { ArrowLeftRight } from "lucide-react";
import { Alert, Badge, Button, Card, cx, Empty, Loading, PageHeader, rowClass, Search, selectClass, Strength, tdClass, thClass } from "../components/ui";
import { analysisTitle, findingHeadline, GROUP_LABEL } from "../lib/labels";
import { decisionOf, REVIEW_LABEL } from "../lib/review";
import { href } from "../lib/router";
import { DECISION_DOT, shortRef } from "../components/FindingRegister";
import { useWorkspace, useWorkspaceFindings } from "../lib/workspace";
import type { FindingGroup } from "../types";

const GROUP_ORDER: FindingGroup[] = ["contradictions", "needs_context", "compatible", "unverified"];
const RANK = { high: 0, medium: 1, needs_context: 2, low: 3, unverified: 4 } as const;

export function FindingsPage() {
  const { data, error } = useWorkspace();
  const { findings, error: findingsError } = useWorkspaceFindings(data);
  const [caseId, setCaseId] = useState("");
  const [group, setGroup] = useState<FindingGroup | "">("");
  const [decision, setDecision] = useState("");
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (findings ?? [])
      .filter((f) => (!caseId || String(f.analysis.caseId) === caseId) && (!group || f.group === group) && (!decision || decisionOf(f.reviewState) === decision))
      .filter((f) => !term || [f.subject, f.explanation, f.a.ref, f.b.ref, analysisTitle(f.analysis)].some((s) => s?.toLowerCase().includes(term)))
      .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || RANK[a.priority] - RANK[b.priority] || b.analysis.id - a.analysis.id || a.rank - b.rank);
  }, [findings, caseId, group, decision, q]);

  const filtered = !!(caseId || group || decision || q.trim());
  const clear = () => {
    setCaseId("");
    setGroup("");
    setDecision("");
    setQ("");
  };

  const failure = error ?? findingsError;
  if (failure) return <Alert title="Findings couldn't be loaded">{failure}</Alert>;
  return (
    <>
      <PageHeader title="Findings" description={findings ? `${findings.length} across ${new Set(findings.map((f) => f.analysis.id)).size} analyses. Leads for your review, not conclusions.` : undefined} />
      {!findings ? <Loading /> : findings.length === 0 ? (
        <Empty title="No findings yet">Findings appear here once a check of two sessions finishes.</Empty>
      ) : (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-rule px-5 py-3">
            <Filter label="Case" value={caseId} onChange={setCaseId} options={[["", "All cases"], ...(data?.cases ?? []).map((c) => [String(c.id), c.name] as [string, string])]} />
            <Filter label="Category" value={group} onChange={(v) => setGroup(v as FindingGroup | "")} options={[["", "All categories"], ...GROUP_ORDER.map((g) => [g, GROUP_LABEL[g]] as [string, string])]} />
            <Filter label="Decision" value={decision} onChange={setDecision} options={[["", "Any decision"], ...(["unreviewed", "confirmed", "needs_context", "dismissed"] as const).map((d) => [d, REVIEW_LABEL[d]] as [string, string])]} />
            <Search value={q} onChange={setQ} label="Search wording, witness or page:line" className="w-72 max-w-full" />
            <span className="ml-auto flex items-center gap-3 text-sm text-muted tabular-nums">{filtered && rows.length > 0 && <button type="button" onClick={clear} className="font-medium text-ink hover:underline">Clear filters</button>}{rows.length} of {findings.length} shown</span>
          </div>
          {rows.length === 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-6 text-sm">
              <p className="text-muted">No finding matches these filters. They hide all {findings.length} {findings.length === 1 ? "finding" : "findings"}.</p>
              <Button variant="secondary" onClick={clear}>Clear filters</Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[58rem] text-sm">
                <thead><tr><th className={thClass}>Finding</th><th className={thClass}>Witness</th><th className={thClass}>Testimony</th><th className={thClass}>Category</th><th className={cx(thClass, "text-right")}>Strength</th><th className={thClass}>Decision</th></tr></thead>
                <tbody>
                  {rows.map((f) => {
                    const d = decisionOf(f.reviewState);
                    return (
                      <tr key={f.id} className={cx(rowClass, "cursor-pointer align-top")} onClick={(e) => !(e.target as HTMLElement).closest("a") && (window.location.hash = href.analysis(f.analysis.id, f.id))}>
                        <td className={cx(tdClass, "max-w-[28rem]")}><a href={href.analysis(f.analysis.id, f.id)} className="line-clamp-2 font-medium hover:underline">{f.subject ?? f.explanation}</a></td>
                        <td className={tdClass}>
                          <span className="block whitespace-nowrap">{analysisTitle(f.analysis)}</span>
                          <span className="block text-xs text-muted">{f.caseName}</span>
                        </td>
                        <td className={cx(tdClass, "font-mono text-[12px] whitespace-nowrap text-muted")}><span className="flex items-center gap-1.5">{shortRef(f.a.ref)}<ArrowLeftRight aria-hidden className="size-3 text-faint" />{shortRef(f.b.ref)}</span></td>
                        <td className={tdClass}><Badge tone={f.group === "contradictions" ? (f.priority === "high" ? "contradiction" : "neutral") : f.group === "unverified" ? "bad" : f.group === "needs_context" ? "warn" : "neutral"}>{f.group === "contradictions" && f.priority === "high" ? "High priority" : findingHeadline(f)}</Badge></td>
                        <td className={cx(tdClass, "text-right")}>{f.group !== "compatible" && f.score !== null ? <Strength score={f.score} /> : <span className="text-faint">–</span>}</td>
                        <td className={cx(tdClass, "whitespace-nowrap")}><span className="flex items-center gap-2"><span aria-hidden className={cx("size-2.5 rounded-full", DECISION_DOT[d])} />{REVIEW_LABEL[d]}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </>
  );
}

function Filter({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <label className="block">
      <span className="sr-only">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={cx(selectClass, "w-auto min-w-40")}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}
