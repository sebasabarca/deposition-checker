// Every deposition across cases, filtered by case and searchable by witness or file.

import { useMemo, useState } from "react";
import { FileUp } from "lucide-react";
import { useAddDeposition } from "../components/Shell";
import { Alert, Badge, Button, Card, cx, Empty, Loading, PageHeader, rowClass, Search, selectClass, tdClass, thClass } from "../components/ui";
import { DEPOSITION_STATUS, formatDate } from "../lib/labels";
import { href } from "../lib/router";
import { useWorkspace } from "../lib/workspace";
import { sourceOf } from "./CasePage";

export function DepositionsPage({ caseId }: { caseId: number | null }) {
  const { data, error } = useWorkspace();
  const add = useAddDeposition();
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (data?.details ?? [])
      .filter((d) => caseId === null || d.case.id === caseId)
      .flatMap((d) => d.depositions.map((x) => ({ ...x, caseName: d.case.name, caseId: d.case.id, witness: d.witnesses.find((w) => w.id === x.witnessId)?.name ?? "Unknown witness", analyses: d.analyses.filter((a) => a.depositionA === x.id || a.depositionB === x.id).length })))
      .filter((r) => !term || [r.witness, r.caseName, r.originalFilename ?? ""].some((s) => s.toLowerCase().includes(term)))
      .sort((a, b) => a.caseName.localeCompare(b.caseName) || a.witness.localeCompare(b.witness) || (a.takenOn ?? "").localeCompare(b.takenOn ?? ""));
  }, [data, caseId, q]);

  if (error) return <Alert title="Depositions couldn't be loaded">{error}</Alert>;
  const total = data?.details.reduce((n, d) => n + d.depositions.length, 0) ?? 0;
  return (
    <>
      <PageHeader title="Depositions" description={data ? `${total} ${total === 1 ? "session" : "sessions"} across ${data.cases.length} ${data.cases.length === 1 ? "case" : "cases"}.` : undefined} actions={<Button onClick={() => add.open(caseId ?? undefined)}><FileUp aria-hidden className="size-4" />Add deposition</Button>} />
      {!data ? <Loading label="Loading depositions" /> : total === 0 ? (
        <Empty title="No depositions yet" action={<Button onClick={() => add.open()}>Add deposition</Button>}>Add a PDF or text transcript. Veridict reads it into page and line references you can search and cite.</Empty>
      ) : (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-rule px-5 py-3">
            <label htmlFor="case-filter" className="sr-only">Case</label>
            <select id="case-filter" value={caseId ?? ""} onChange={(e) => (window.location.hash = href.depositions(e.target.value ? Number(e.target.value) : null))} className={cx(selectClass, "w-60")}>
              <option value="">All cases</option>
              {data.cases.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <Search value={q} onChange={setQ} label="Search witness or file" className="w-72 max-w-full" />
            <span className="ml-auto text-sm text-muted tabular-nums">{rows.length} shown</span>
          </div>
          {rows.length === 0 ? <p className="px-5 py-6 text-sm text-muted">No deposition matches this filter.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[56rem] text-sm">
                <thead>
                  <tr>
                    <th className={thClass}>Witness</th>
                    <th className={thClass}>Date taken</th>
                    {caseId === null && <th className={thClass}>Case</th>}
                    <th className={thClass}>File</th>
                    <th className={thClass}>Source</th>
                    <th className={cx(thClass, "text-right")}>Pages</th>
                    <th className={cx(thClass, "text-right")}>Analyses</th>
                    <th className={thClass}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <tr key={d.id} className={cx(rowClass, "cursor-pointer")} onClick={(e) => !(e.target as HTMLElement).closest("a") && (window.location.hash = href.deposition(d.id))}>
                      <td className={tdClass}><a href={href.deposition(d.id)} className="font-semibold hover:underline">{d.witness}</a></td>
                      <td className={cx(tdClass, "whitespace-nowrap tabular-nums")}>{formatDate(d.takenOn)}</td>
                      {caseId === null && <td className={cx(tdClass, "text-muted")}><a href={href.case(d.caseId)} className="hover:text-ink hover:underline">{d.caseName}</a></td>}
                      <td className={cx(tdClass, "max-w-72 truncate text-muted")} title={d.originalFilename ?? undefined}>{d.originalFilename ?? `Deposition #${d.id}`}</td>
                      <td className={cx(tdClass, "text-muted whitespace-nowrap")}>{sourceOf(d)}</td>
                      <td className={cx(tdClass, "text-right tabular-nums")}>{d.pageCount ?? "–"}</td>
                      <td className={cx(tdClass, "text-right tabular-nums")}>{d.analyses}</td>
                      <td className={tdClass}><Badge tone={DEPOSITION_STATUS[d.status].tone} dot>{DEPOSITION_STATUS[d.status].label}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
