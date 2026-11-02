// One case: its depositions by witness, a check of two sessions of one witness, and its analyses.

import { useCallback, useEffect, useState } from "react";
import { ArrowRight, FileUp, X } from "lucide-react";
import { CHECK_ESTIMATE, CheckAgain, useStartCheck } from "../components/CheckAgain";
import { useAddDeposition } from "../components/Shell";
import { Alert, Badge, Button, buttonClass, Card, CardHeader, cx, Empty, Loading, PageHeader, rowClass, tdClass, thClass } from "../components/ui";
import { api } from "../lib/api";
import { checkState, isActive, pairsChecked } from "../lib/insights";
import { ANALYSIS_STATUS, DEPOSITION_STATUS, formatDate, formatUsd } from "../lib/labels";
import { href, usePoll } from "../lib/router";
import type { AnalysisView, CaseDetail, DepositionRow } from "../types";

export const sourceOf = (d: Pick<DepositionRow, "scanned" | "originalFilename">) => (/\.txt$/i.test(d.originalFilename ?? "") ? "Text" : d.scanned ? "Scanned PDF" : "PDF");

export function CasePage({ id }: { id: number }) {
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [analyses, setAnalyses] = useState<AnalysisView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const add = useAddDeposition();
  const load = useCallback(() => {
    api.case(id)
      .then(async (d) => {
        setDetail(d);
        setAnalyses((await Promise.all(d.analyses.map((a) => api.analysis(a.id)))).map((r) => r.analysis).sort((a, b) => b.id - a.id));
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  const busy = !!detail && (detail.depositions.some((d) => d.status === "processing") || detail.analyses.some((a) => isActive(a.status)));
  usePoll(busy, 3000, load);

  if (error) return <Alert title="This case couldn't be loaded">{error}</Alert>;
  if (!detail) return <Loading />;
  const toggle = (d: number) => setSelected((s) => (s.includes(d) ? s.filter((x) => x !== d) : [...s, d]));
  const toDecide = Math.max(analyses.reduce((n, r) => n + r.findings.groups.contradictions + r.findings.groups.needs_context - r.findings.decided, 0), 0);
  const summary = [`${detail.witnesses.length} ${detail.witnesses.length === 1 ? "witness" : "witnesses"}`, `${detail.depositions.length} ${detail.depositions.length === 1 ? "deposition" : "depositions"}`, `${analyses.length} ${analyses.length === 1 ? "analysis" : "analyses"}`, ...(toDecide > 0 ? [`${toDecide} ${toDecide === 1 ? "finding" : "findings"} to decide`] : [])].join(" · ");

  return (
    <>
      <PageHeader
        above={<a href={href.cases()} className="mb-1 inline-block text-sm text-muted hover:text-ink">Cases</a>}
        title={detail.case.name}
        description={summary}
        actions={<Button onClick={() => add.open(id)}><FileUp aria-hidden className="size-4" />Add deposition</Button>}
      />

      {detail.depositions.length === 0 ? (
        <Empty title="No depositions in this case yet" action={<Button onClick={() => add.open(id)}>Add deposition</Button>}>Add two sessions of the same witness, as PDF or text, to check them against each other.</Empty>
      ) : (
        detail.witnesses.filter((w) => w.depositions.length > 0).map((w) => {
          const sessions = detail.depositions.filter((d) => d.witnessId === w.id).sort((a, b) => (a.takenOn ?? "").localeCompare(b.takenOn ?? ""));
          const pairs = pairsChecked(sessions.filter((d) => d.status === "ready").map((d) => d.id), detail.analyses);
          return (
            <Card key={w.id} className="overflow-hidden">
              <CardHeader
                title={w.name}
                count={sessions.length}
                description={sessions.length < 2 ? "Add another session of this witness to check them against each other." : "Select two sessions to check them against each other."}
                action={pairs.total > 0 ? <span className="text-sm text-muted tabular-nums">{pairs.checked} of {pairs.total} {pairs.total === 1 ? "pair" : "pairs"} checked</span> : undefined}
              />
              <div className="overflow-x-auto">
                <table className="w-full min-w-[44rem] text-sm">
                  <thead>
                    <tr>
                      <th className={cx(thClass, "w-12")}><span className="sr-only">Select</span></th>
                      <th className={thClass}>Date taken</th>
                      <th className={thClass}>File</th>
                      <th className={thClass}>Source</th>
                      <th className={cx(thClass, "text-right")}>Pages</th>
                      <th className={thClass}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((d) => <SessionRow key={d.id} d={d} witness={w.name} selected={selected.includes(d.id)} onToggle={() => toggle(d.id)} onRetry={() => api.retryDeposition(d.id).then(load).catch((e: Error) => setError(e.message))} />)}
                  </tbody>
                </table>
              </div>
            </Card>
          );
        })
      )}

      <Card className="overflow-hidden">
        <CardHeader title="Analyses" count={analyses.length} />
        {analyses.length === 0 ? (
          <p className="px-5 py-5 text-sm text-muted">No analyses yet. Select two sessions of one witness above to start one.</p>
        ) : (
          <AnalysesTable analyses={analyses} />
        )}
      </Card>

      {selected.length > 0 && <CompareBar detail={detail} selected={selected} onClear={() => setSelected([])} />}
    </>
  );
}

function SessionRow({ d, witness, selected, onToggle, onRetry }: { d: DepositionRow; witness: string; selected: boolean; onToggle: () => void; onRetry: () => void }) {
  const s = DEPOSITION_STATUS[d.status];
  const name = d.originalFilename ?? `Deposition #${d.id}`;
  const note = d.status === "failed" || d.status === "unsupported" ? `Couldn't be read: ${d.error ?? "this file's layout isn't recognized."}` : d.status === "needs_review" ? (d.error ?? "Some pages couldn't be read.") : d.scanned ? "Read by OCR. Check the scan before quoting." : null;
  return (
    <tr className={cx(rowClass, selected && "bg-info-bg hover:bg-info-bg")}>
      <td className={cx(tdClass, "align-top")}>
        <input type="checkbox" aria-label={`Select ${witness}, ${formatDate(d.takenOn)}`} checked={selected} disabled={d.status !== "ready"} onChange={onToggle} className="size-4 rounded accent-navy" />
      </td>
      <td className={cx(tdClass, "align-top font-medium whitespace-nowrap tabular-nums")}>{formatDate(d.takenOn)}</td>
      <td className={cx(tdClass, "max-w-80 align-top")}>
        <a href={href.deposition(d.id)} className="block truncate font-medium hover:underline" title={name}>{name}</a>
        {note && <span className="mt-0.5 block text-xs text-muted">{note}</span>}
      </td>
      <td className={cx(tdClass, "align-top text-muted whitespace-nowrap")}>{sourceOf(d)}</td>
      <td className={cx(tdClass, "text-right align-top tabular-nums")}>{d.pageCount ?? "–"}</td>
      <td className={cx(tdClass, "align-top whitespace-nowrap")}>
        <span className="flex items-center gap-2">
          <Badge tone={s.tone} dot>{s.label}</Badge>
          {d.status === "failed" && <Button variant="secondary" className="h-6! px-2! text-xs!" onClick={onRetry}>Try again</Button>}
        </span>
      </td>
    </tr>
  );
}

// The selection's next step, docked at the bottom of the window so it stays in reach.
function CompareBar({ detail, selected, onClear }: { detail: CaseDetail; selected: number[]; onClear: () => void }) {
  const { start, error, busy } = useStartCheck(detail.case.id);
  const state = checkState(selected, detail.depositions, detail.analyses);
  const message = { pick: "Select one more session of the same witness.", too_many: "Select exactly two sessions. An analysis compares two.", different_witness: "These are different witnesses. An analysis compares two sessions of one witness.", not_ready: "Both sessions must finish reading first." };
  const pair = () => {
    const [a, b] = selected.map((s) => detail.depositions.find((d) => d.id === s)!).sort((x, y) => (x.takenOn ?? "").localeCompare(y.takenOn ?? ""));
    return `${detail.witnesses.find((w) => w.id === a.witnessId)?.name}: ${formatDate(a.takenOn)} and ${formatDate(b.takenOn)}`;
  };
  return (
    <div className="sticky bottom-4 z-20">
      <div aria-live="polite" className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-navy px-5 py-3 text-white shadow-[0_12px_32px_-8px_rgb(19_33_58/0.5)]">
        <div className="min-w-0">
          {state.kind in message ? (
            <p className="text-sm">{message[state.kind as keyof typeof message]}</p>
          ) : (
            <>
              <p className="font-semibold">{pair()}</p>
              <p className="text-sm text-navy-ink">
                {state.kind === "new" && `${CHECK_ESTIMATE}. Nothing is charged until you start.`}
                {state.kind === "running" && "These sessions are being checked now."}
                {state.kind === "done" && `Already checked on ${formatDate(state.report.createdAt)}.`}
              </p>
            </>
          )}
          {error && <p className="mt-1 text-sm text-[#ffc9c9]">{error}</p>}
        </div>
        <div className="flex flex-none flex-wrap items-center gap-2">
          <button type="button" onClick={onClear} className="flex h-8 items-center gap-1 rounded-md px-2.5 text-sm text-navy-ink hover:bg-navy-2 hover:text-white"><X aria-hidden className="size-4" />Clear</button>
          {state.kind === "new" && <button type="button" disabled={busy} onClick={() => void start(state.a, state.b)} className={buttonClass("secondary", "ring-0!")}>{busy ? "Starting…" : "Check these sessions"}</button>}
          {state.kind === "running" && <a href={href.analysis(state.report.id)} className={buttonClass("secondary", "ring-0!")}>View progress</a>}
          {state.kind === "done" && (
            <>
              <CheckAgain caseId={detail.case.id} a={state.a} b={state.b} />
              <a href={href.analysis(state.report.id)} className={buttonClass("secondary", "ring-0!")}>Open analysis<ArrowRight aria-hidden className="size-4" /></a>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function AnalysesTable({ analyses, caseNames }: { analyses: AnalysisView[]; caseNames?: Map<number, string> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem] text-sm">
        <thead>
          <tr>
            <th className={thClass}>Sessions compared</th>
            {caseNames && <th className={thClass}>Case</th>}
            <th className={thClass}>Status</th>
            <th className={cx(thClass, "text-right")}>Contradictions</th>
            <th className={cx(thClass, "text-right")}>Need context</th>
            <th className={cx(thClass, "text-right")}>Decided</th>
            <th className={cx(thClass, "text-right")}>Cost</th>
            <th className={cx(thClass, "text-right")}>Checked</th>
          </tr>
        </thead>
        <tbody>
          {analyses.map((r) => {
            const s = ANALYSIS_STATUS[r.status];
            const [a, b] = r.depositions;
            const done = r.status === "completed";
            return (
              <tr key={r.id} className={cx(rowClass, "cursor-pointer")} onClick={(e) => !(e.target as HTMLElement).closest("a") && (window.location.hash = href.analysis(r.id))}>
                <td className={tdClass}>
                  <a href={href.analysis(r.id)} className="font-semibold hover:underline">{a.witness}</a>
                  <span className="block text-xs text-muted tabular-nums">{formatDate(a.takenOn)} and {formatDate(b.takenOn)}</span>
                </td>
                {caseNames && <td className={cx(tdClass, "text-muted")}>{caseNames.get(r.caseId) ?? "–"}</td>}
                <td className={tdClass}>
                  <span className="flex items-center gap-1.5">
                    <Badge tone={done ? "good" : s.tone} dot>{isActive(r.status) ? "Checking" : s.label}</Badge>
                    {r.mode === "demo" && <Badge tone="accent">Example</Badge>}
                  </span>
                </td>
                <td className={cx(tdClass, "text-right tabular-nums", done && r.findings.groups.contradictions > 0 && "font-semibold")}>{done ? r.findings.groups.contradictions : "–"}</td>
                <td className={cx(tdClass, "text-right tabular-nums")}>{done ? r.findings.groups.needs_context : "–"}</td>
                <td className={cx(tdClass, "text-right tabular-nums text-muted")}>{done ? `${Math.min(r.findings.decided, r.findings.total)} of ${r.findings.total}` : "–"}</td>
                <td className={cx(tdClass, "text-right tabular-nums text-muted")}>{formatUsd(r.cost.actualUsd)}</td>
                <td className={cx(tdClass, "text-right tabular-nums text-muted whitespace-nowrap")}>{formatDate(r.finishedAt ?? r.createdAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
