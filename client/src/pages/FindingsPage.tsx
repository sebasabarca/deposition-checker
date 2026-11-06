// Every finding of each case's latest whole-case analysis, filtered by case, category, review priority, citation
// check and decision. Each row opens its analysis, where the finding is reviewed with its testimony.

import { useMemo, useState } from "react";
import { ArrowLeftRight, CircleAlert, CircleCheck } from "lucide-react";
import { Alert, Badge, Button, Card, cx, Empty, Loading, PageHeader, rowClass, Search, selectClass, Strength, tdClass, thClass } from "../components/ui";
import { DECISION_DOT, shortRef } from "../components/FindingParts";
import { EVIDENCE_STATUS, GROUP_LABEL, PRIORITY } from "../lib/labels";
import { REVIEW_LABEL, SHOWN_DECISION_LABEL } from "../lib/review";
import { href } from "../lib/router";
import { decisionShown, evidenceCheck, filterFindings, GROUP_ORDER, isFiltered, NO_FILTERS, PRIORITY_ORDER, type FindingFilters } from "../lib/findingFilters";
import { useWorkspace } from "../lib/workspace";
import type { WorkspaceFinding } from "../types";

const EVIDENCE_FILTER: [string, string][] = [["verified", "Citations verified"], ["approximate", "Verified (approximate)"], ["not_verified", "Citation not verified"]];

// What a finding is, in a lawyer's words: the kind of contradiction, or its category.
export const headline = (f: Pick<WorkspaceFinding, "lane" | "type" | "crossWitness">) =>
  f.lane === "contradictions" ? (f.crossWitness ? "Potential conflict between witnesses" : f.type === "direct" ? "Potential direct contradiction" : "Potential inferential contradiction") : GROUP_LABEL[f.lane];

export function FindingsPage() {
  const { data, error } = useWorkspace();
  const findings = data?.findings ?? null;
  const [filters, setFilters] = useState<FindingFilters>(NO_FILTERS);
  const set = (k: keyof FindingFilters) => (v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const rows = useMemo(() => filterFindings(findings ?? [], filters), [findings, filters]);
  const filtered = isFiltered(filters);
  const clear = () => setFilters(NO_FILTERS);

  if (error) return <Alert title="Findings couldn't be loaded">{error}</Alert>;
  const analyses = new Set((findings ?? []).map((f) => f.runId)).size;
  return (
    <>
      <PageHeader title="Findings" description={findings ? `${findings.length.toLocaleString()} from the latest analysis of ${analyses} ${analyses === 1 ? "case" : "cases"}. Leads for your review, not conclusions.` : undefined} />
      {!findings ? <Loading label="Loading findings" /> : findings.length === 0 ? (
        <Empty title="No findings yet">Findings appear here once an analysis of a case has read its testimony.</Empty>
      ) : (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-rule px-5 py-3">
            <Filter label="Case" value={filters.caseId} onChange={set("caseId")} options={[["", "All cases"], ...(data?.cases ?? []).map((c) => [String(c.id), c.name] as [string, string])]} />
            <Filter label="Category" value={filters.group} onChange={set("group")} options={[["", "All categories"], ...GROUP_ORDER.map((g) => [g, GROUP_LABEL[g]] as [string, string])]} />
            <Filter label="Review priority" value={filters.priority} onChange={set("priority")} options={[["", "Any priority"], ...PRIORITY_ORDER.map((p) => [p, PRIORITY[p]] as [string, string])]} />
            <Filter label="Citation check" value={filters.evidence} onChange={set("evidence")} options={[["", "Any citation check"], ...EVIDENCE_FILTER]} />
            <Filter label="Decision" value={filters.decision} onChange={set("decision")} options={[["", "Any decision"], ...(["unreviewed", "confirmed", "needs_context", "dismissed"] as const).map((d) => [d, REVIEW_LABEL[d]] as [string, string])]} />
            <Search value={filters.q} onChange={set("q")} label="Search wording, witness or page:line" className="w-72 max-w-full" />
            <span className="ml-auto flex items-center gap-3 text-sm text-muted tabular-nums">{filtered && rows.length > 0 && <button type="button" onClick={clear} className="font-medium text-ink hover:underline">Clear filters</button>}{rows.length.toLocaleString()} of {findings.length.toLocaleString()} shown</span>
          </div>
          {rows.length === 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-6 text-sm">
              <p className="text-muted">No finding matches these filters. They hide all {findings.length.toLocaleString()} {findings.length === 1 ? "finding" : "findings"}.</p>
              <Button variant="secondary" onClick={clear}>Clear filters</Button>
            </div>
          ) : (
            <FindingsTable key={JSON.stringify(filters)} rows={rows} />
          )}
        </Card>
      )}
    </>
  );
}

// Long lists are shown a page at a time, so a case with thousands of findings stays quick.
const PAGE = 100;
function FindingsTable({ rows }: { rows: WorkspaceFinding[] }) {
  const [shown, setShown] = useState(PAGE);
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[66rem] text-sm">
          <thead><tr><th className={thClass}>Finding</th><th className={thClass}>Witness</th><th className={thClass}>Testimony</th><th className={thClass}>Category</th><th className={thClass}>Citations</th><th className={cx(thClass, "text-right")}>Strength</th><th className={thClass}>Decision</th></tr></thead>
          <tbody>
            {rows.slice(0, shown).map((f) => {
              const d = decisionShown(f);
              const setAside = f.lane === "quarantined";
              const witnesses = [...new Set([f.a.witness, f.b.witness].filter((w): w is string => !!w))].join(" and ");
              return (
                <tr key={f.id} className={cx(rowClass, "cursor-pointer align-top")} onClick={(e) => !(e.target as HTMLElement).closest("a") && (window.location.hash = href.caseRun(f.runId))}>
                  <td className={cx(tdClass, "w-[30rem] min-w-[22rem]")}>
                    <a href={href.caseRun(f.runId)} className="font-medium hover:underline">{headline(f)}</a>
                    {f.explanation && <p className="mt-0.5 line-clamp-2 text-muted">{f.explanation}</p>}
                    {setAside && <span className="mt-0.5 block text-xs text-muted">Needs revalidation: the transcript was re-read with a corrected parser. Kept for audit, not a current finding.</span>}
                  </td>
                  <td className={tdClass}>
                    <span className="block">{witnesses || "–"}</span>
                    <span className="block text-xs text-muted">{f.caseName}</span>
                  </td>
                  <td className={cx(tdClass, "font-mono text-[12px] whitespace-nowrap text-muted")}><span className="flex items-center gap-1.5">{shortRef(f.a.range)}<ArrowLeftRight aria-hidden className="size-3 text-faint" />{shortRef(f.b.range)}</span></td>
                  <td className={tdClass}>
                    <Badge tone={f.lane === "contradictions" ? (f.priority === "high" ? "contradiction" : "neutral") : f.lane === "unverified" ? "bad" : f.lane === "needs_context" ? "warn" : "neutral"}>{GROUP_LABEL[f.lane]}</Badge>
                    {f.lane === "contradictions" && <span className="mt-1 block text-xs text-muted">{PRIORITY[f.priority as keyof typeof PRIORITY] ?? f.priority}</span>}
                  </td>
                  <td className={tdClass}>{setAside ? <span className="text-muted">Transcript re-read</span> : <CitationCheck status={f.evidenceStatus} />}</td>
                  <td className={cx(tdClass, "text-right")}>{f.lane !== "compatible" && !setAside && f.score !== null ? <Strength score={f.score} /> : <span className="text-faint">–</span>}</td>
                  <td className={cx(tdClass, "whitespace-nowrap")}><span className="flex items-center gap-2"><span aria-hidden className={cx("size-2.5 rounded-full", DECISION_DOT[d])} />{SHOWN_DECISION_LABEL[d]}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > shown && (
        <div className="flex items-center justify-between gap-3 border-t border-rule px-5 py-3">
          <span className="text-sm text-muted tabular-nums">Showing {shown.toLocaleString()} of {rows.length.toLocaleString()}</span>
          <Button variant="secondary" onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, rows.length - shown)} more</Button>
        </div>
      )}
    </>
  );
}

// What code found when it checked both citations against the stored lines: an icon and words, never colour alone.
function CitationCheck({ status }: { status: string }) {
  const ok = evidenceCheck(status) !== "not_verified";
  const Icon = ok ? CircleCheck : CircleAlert;
  return (
    <span className={cx("flex items-center gap-1.5 whitespace-nowrap", ok ? "text-ink" : "text-conflict")} title="Checked by code against the stored transcript lines">
      <Icon aria-hidden className={cx("size-3.5 flex-none", ok ? "text-ok" : "text-conflict")} strokeWidth={1.75} />
      {EVIDENCE_STATUS[status as keyof typeof EVIDENCE_STATUS] ?? status}
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
