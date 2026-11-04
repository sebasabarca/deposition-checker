// Every finding across cases, filtered by case, category, review priority, citation check and decision.

import { useMemo, useState } from "react";
import { ArrowLeftRight, CircleAlert, CircleCheck } from "lucide-react";
import { Alert, Badge, Button, Card, cx, Empty, Loading, PageHeader, rowClass, Search, selectClass, Strength, tdClass, thClass } from "../components/ui";
import { analysisTitle, EVIDENCE_STATUS, findingHeadline, GROUP_LABEL, PRIORITY } from "../lib/labels";
import { decisionOf, REVIEW_LABEL } from "../lib/review";
import { href } from "../lib/router";
import { DECISION_DOT, shortRef } from "../components/FindingRegister";
import { evidenceCheck, filterFindings, GROUP_ORDER, isFiltered, NO_FILTERS, PRIORITY_ORDER, type FindingFilters } from "../lib/findingFilters";
import { useWorkspace, useWorkspaceFindings } from "../lib/workspace";
import type { FindingSummary } from "../types";

const EVIDENCE_FILTER: [string, string][] = [["verified", "Citations verified"], ["approximate", "Verified (approximate)"], ["not_verified", "Citation not verified"]];

export function FindingsPage() {
  const { data, error } = useWorkspace();
  const { findings, error: findingsError } = useWorkspaceFindings(data);
  const [filters, setFilters] = useState<FindingFilters>(NO_FILTERS);
  const set = (k: keyof FindingFilters) => (v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const rows = useMemo(() => filterFindings((findings ?? []).map((f) => ({ ...f, title: analysisTitle(f.analysis) })), filters), [findings, filters]);

  const filtered = isFiltered(filters);
  const clear = () => setFilters(NO_FILTERS);

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
            <Filter label="Case" value={filters.caseId} onChange={set("caseId")} options={[["", "All cases"], ...(data?.cases ?? []).map((c) => [String(c.id), c.name] as [string, string])]} />
            <Filter label="Category" value={filters.group} onChange={set("group")} options={[["", "All categories"], ...GROUP_ORDER.map((g) => [g, GROUP_LABEL[g]] as [string, string])]} />
            <Filter label="Review priority" value={filters.priority} onChange={set("priority")} options={[["", "Any priority"], ...PRIORITY_ORDER.map((p) => [p, PRIORITY[p]] as [string, string])]} />
            <Filter label="Citation check" value={filters.evidence} onChange={set("evidence")} options={[["", "Any citation check"], ...EVIDENCE_FILTER]} />
            <Filter label="Decision" value={filters.decision} onChange={set("decision")} options={[["", "Any decision"], ...(["unreviewed", "confirmed", "needs_context", "dismissed"] as const).map((d) => [d, REVIEW_LABEL[d]] as [string, string])]} />
            <Search value={filters.q} onChange={set("q")} label="Search wording, witness or page:line" className="w-72 max-w-full" />
            <span className="ml-auto flex items-center gap-3 text-sm text-muted tabular-nums">{filtered && rows.length > 0 && <button type="button" onClick={clear} className="font-medium text-ink hover:underline">Clear filters</button>}{rows.length} of {findings.length} shown</span>
          </div>
          {rows.length === 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-6 text-sm">
              <p className="text-muted">No finding matches these filters. They hide all {findings.length} {findings.length === 1 ? "finding" : "findings"}.</p>
              <Button variant="secondary" onClick={clear}>Clear filters</Button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[66rem] text-sm">
                <thead><tr><th className={thClass}>Finding</th><th className={thClass}>Witness</th><th className={thClass}>Testimony</th><th className={thClass}>Category</th><th className={thClass}>Citations</th><th className={cx(thClass, "text-right")}>Strength</th><th className={thClass}>Decision</th></tr></thead>
                <tbody>
                  {rows.map((f) => {
                    const d = decisionOf(f.reviewState);
                    return (
                      <tr key={f.id} className={cx(rowClass, "cursor-pointer align-top")} onClick={(e) => !(e.target as HTMLElement).closest("a") && (window.location.hash = href.analysis(f.analysis.id, f.id))}>
                        <td className={cx(tdClass, "max-w-[28rem]")}>
                          <a href={href.analysis(f.analysis.id, f.id)} className="line-clamp-2 font-medium hover:underline">{f.subject ?? f.explanation}</a>
                          {f.source === "fixture" && <span className="mt-1 block text-xs text-muted">Prepared example, not model output</span>}
                        </td>
                        <td className={tdClass}>
                          <span className="block whitespace-nowrap">{f.title}</span>
                          <span className="block text-xs text-muted">{f.caseName}</span>
                        </td>
                        <td className={cx(tdClass, "font-mono text-[12px] whitespace-nowrap text-muted")}><span className="flex items-center gap-1.5">{shortRef(f.a.ref)}<ArrowLeftRight aria-hidden className="size-3 text-faint" />{shortRef(f.b.ref)}</span></td>
                        <td className={tdClass}>
                          <Badge tone={f.group === "contradictions" ? (f.priority === "high" ? "contradiction" : "neutral") : f.group === "unverified" ? "bad" : f.group === "needs_context" ? "warn" : "neutral"}>{findingHeadline(f)}</Badge>
                          {f.group === "contradictions" && <span className="mt-1 block text-xs text-muted">{PRIORITY[f.priority]}</span>}
                        </td>
                        <td className={tdClass}><CitationCheck status={f.evidenceStatus} /></td>
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

// What code found when it checked both citations against the stored lines: an icon and words, never colour alone.
function CitationCheck({ status }: { status: FindingSummary["evidenceStatus"] }) {
  const ok = evidenceCheck(status) !== "not_verified";
  const Icon = ok ? CircleCheck : CircleAlert;
  return (
    <span className={cx("flex items-center gap-1.5 whitespace-nowrap", ok ? "text-ink" : "text-conflict")} title="Checked by code against the stored transcript lines">
      <Icon aria-hidden className={cx("size-3.5 flex-none", ok ? "text-ok" : "text-conflict")} strokeWidth={1.75} />
      {EVIDENCE_STATUS[status]}
    </span>
  );
}

function Filter({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <label className="block max-w-full">
      <span className="sr-only">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={cx(selectClass, "w-auto max-w-full min-w-40")}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}
