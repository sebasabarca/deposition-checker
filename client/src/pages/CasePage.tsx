// One case, top to bottom: its depositions, a new check of two of them, and its reports. Nothing
// here is a separate page, so a lawyer never has to work out where something lives.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ArrowRight, ChevronRight, FileUp } from "lucide-react";
import { CHECK_ESTIMATE, CheckAgain, useStartCheck } from "../components/CheckAgain";
import { Crumbs } from "../components/Shell";
import { Alert, Badge, Button, buttonClass, Card, CardHeader, cx, Dialog, Field, inputClass, Loading, PageHeader, tdClass, thClass } from "../components/ui";
import { api } from "../lib/api";
import { checkState, isActive, pairsChecked } from "../lib/insights";
import { ANALYSIS_STATUS, DEPOSITION_STATUS, formatDate } from "../lib/labels";
import { href, usePoll } from "../lib/router";
import type { AnalysisView, CaseDetail, DepositionRow } from "../types";

const MAX_UPLOAD_MB = 50; // server/src/api/depositions.ts
const sourceOf = (d: DepositionRow) => (d.scanned ? "Scanned PDF" : "PDF");

export function CasePage({ id }: { id: number }) {
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [reports, setReports] = useState<AnalysisView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const load = useCallback(() => {
    api.case(id)
      .then(async (d) => {
        setDetail(d);
        setReports((await Promise.all(d.analyses.map((a) => api.analysis(a.id)))).map((r) => r.analysis));
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  const busy = !!detail && (detail.depositions.some((d) => d.status === "processing") || detail.analyses.some((a) => isActive(a.status)));
  usePoll(busy, 3000, load);

  if (error) return <Alert title="This case couldn't be loaded">{error}</Alert>;
  if (!detail) return <Loading />;
  const witnessName = (w: number) => detail.witnesses.find((x) => x.id === w)?.name ?? "Unknown witness";
  const toggle = (d: number) => setSelected((s) => (s.includes(d) ? s.filter((x) => x !== d) : [...s, d]));
  const needReview = Math.max(reports.reduce((n, r) => n + r.findings.groups.contradictions + r.findings.groups.needs_context - r.findings.decided, 0), 0);
  const summary = [`${detail.depositions.length} ${detail.depositions.length === 1 ? "deposition" : "depositions"}`, `${detail.witnesses.length} ${detail.witnesses.length === 1 ? "witness" : "witnesses"}`, `${reports.length} ${reports.length === 1 ? "report" : "reports"}`, ...(needReview > 0 ? [`${needReview} ${needReview === 1 ? "finding needs" : "findings need"} review`] : [])].join(" · ");

  return (
    <>
      <Crumbs items={[{ label: "Cases", to: href.cases() }, { label: detail.case.name }]} />
      <PageHeader title={detail.case.name} description={summary} actions={<Button className="h-10" onClick={() => setAdding(true)}><FileUp aria-hidden className="size-[18px]" />Add deposition</Button>} />

      <Card className="overflow-hidden">
        <CardHeader title="Depositions" description="Select two depositions of the same witness to compare them." />
        {detail.depositions.length === 0 ? (
          <div className="px-space-lg pb-space-lg text-center">
            <p className="py-6 text-body-sm text-on-surface-variant">Upload two deposition sessions of the same witness to compare them.</p>
            <Button onClick={() => setAdding(true)}>Upload a file</Button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[42rem] border-collapse text-left text-body-sm">
              <thead className="text-on-surface-variant">
                <tr>
                  <th className={cx(thClass, "w-10 pr-0")}><span className="sr-only">Select</span></th>
                  {["Witness", "Date taken", "File", "Source", "Pages", "Status"].map((h) => <th key={h} className={thClass}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {detail.depositions.map((d) => (
                  <DepositionRowView key={d.id} d={d} witness={witnessName(d.witnessId)} selected={selected.includes(d.id)} onToggle={() => toggle(d.id)} onRetry={() => api.retryDeposition(d.id).then(load).catch((e: Error) => setError(e.message))} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {detail.depositions.length > 0 && <NewCheck detail={detail} selected={selected} witnessName={witnessName} />}

      <Card className="overflow-hidden">
        <CardHeader title="Reports" action={<PairsNote detail={detail} />} />
        {reports.length === 0 ? (
          <p className="px-space-lg pb-space-lg text-body-sm text-on-surface-variant">No reports yet. Select two depositions above to start.</p>
        ) : (
          <ul className="space-y-space-sm px-space-lg pb-space-lg">{reports.map((r) => <ReportRow key={r.id} r={r} />)}</ul>
        )}
      </Card>

      <Dialog open={adding} onClose={() => setAdding(false)} title="Add deposition"><Upload caseId={id} witnesses={detail.witnesses.map((w) => w.name)} onDone={() => { setAdding(false); load(); }} onCancel={() => setAdding(false)} /></Dialog>
    </>
  );
}

function DepositionRowView({ d, witness, selected, onToggle, onRetry }: { d: DepositionRow; witness: string; selected: boolean; onToggle: () => void; onRetry: () => void }) {
  const s = DEPOSITION_STATUS[d.status];
  const name = d.originalFilename ?? `Deposition #${d.id}`;
  const note = d.status === "failed" || d.status === "unsupported" ? `Couldn't be read: ${d.error ?? "this file's layout isn't recognized."}` : d.status === "needs_review" ? (d.error ?? "Some pages couldn't be read.") : d.scanned ? "Read by OCR. Check the scan before quoting." : null;
  return (
    <>
      <tr className={cx("border-t border-white/60 align-top transition-colors", selected ? "bg-secondary-fixed/40" : "hover:bg-white/50")}>
        <td className={cx(tdClass, "pr-0")}><input type="checkbox" aria-label={`Select ${witness}, ${formatDate(d.takenOn)}`} checked={selected} disabled={d.status !== "ready"} onChange={onToggle} className="mt-0.5 size-4 accent-secondary" /></td>
        <td className={cx(tdClass, "font-semibold whitespace-nowrap")}>{witness}</td>
        <td className={cx(tdClass, "whitespace-nowrap")}>{formatDate(d.takenOn)}</td>
        <td className={cx(tdClass, "max-w-64")}>
          <a href={api.depositionPdf(d.id, 1)} target="_blank" rel="noreferrer" title={`Open the original: ${name}`} className="block truncate hover:text-secondary hover:underline">{name}</a>
          {note && <span className="mt-0.5 block whitespace-normal text-label-sm text-on-surface-variant">{note}</span>}
        </td>
        <td className={cx(tdClass, "whitespace-nowrap")}>{sourceOf(d)}</td>
        <td className={cx(tdClass, "tabular-nums")}>{d.pageCount ?? "—"}</td>
        <td className={cx(tdClass, "whitespace-nowrap")}>
          <Badge tone={s.tone} dot>{s.label}</Badge>
          {d.status === "failed" && <Button variant="secondary" className="ml-2 h-7" onClick={onRetry}>Try again</Button>}
        </td>
      </tr>
    </>
  );
}

function NewCheck({ detail, selected, witnessName }: { detail: CaseDetail; selected: number[]; witnessName: (w: number) => string }) {
  const { start, error, busy } = useStartCheck(detail.case.id);
  const state = checkState(selected, detail.depositions, detail.analyses);
  const title = () => {
    const [a, b] = selected.map((id) => detail.depositions.find((d) => d.id === id)!).sort((x, y) => (x.takenOn ?? "").localeCompare(y.takenOn ?? ""));
    return `${witnessName(a.witnessId)}: ${formatDate(a.takenOn)} vs ${formatDate(b.takenOn)}`;
  };
  const message = { pick: "Select two depositions of the same witness to compare them.", too_many: "Select exactly two. Each report compares two depositions.", different_witness: "These are different witnesses. A check compares two sessions of the same witness.", not_ready: "Both depositions must finish reading first." };
  return (
    <Card className="p-space-lg">
      <div aria-live="polite">
        {state.kind in message ? (
          <p className="text-body-md text-on-surface-variant">{message[state.kind as keyof typeof message]}</p>
        ) : (
          <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
            <div className="min-w-0">
              <h2 className="text-headline-lg">{title()}</h2>
              <p className="mt-0.5 text-body-sm text-on-surface-variant">
                {state.kind === "new" && CHECK_ESTIMATE}
                {state.kind === "running" && "These depositions are being checked."}
                {state.kind === "done" && `Already checked on ${formatDate(state.report.createdAt)}.`}
              </p>
            </div>
            <div className="flex flex-none flex-wrap items-center gap-2">
              {state.kind === "new" && <Button className="h-10" disabled={busy} onClick={() => void start(state.a, state.b)}>{busy ? "Starting…" : "Check these depositions"}</Button>}
              {state.kind === "running" && <a href={href.analysis(state.report.id)} className={buttonClass("primary", "h-10")}>View progress</a>}
              {state.kind === "done" && (
                <>
                  <CheckAgain caseId={detail.case.id} a={state.a} b={state.b} />
                  <a href={href.analysis(state.report.id)} className={buttonClass("primary", "h-10")}>Open report<ArrowRight aria-hidden className="size-4" /></a>
                </>
              )}
            </div>
          </div>
        )}
      </div>
      {error && <div className="mt-3"><Alert>{error}</Alert></div>}
    </Card>
  );
}

function PairsNote({ detail }: { detail: CaseDetail }) {
  const notes = detail.witnesses.map((w) => pairsChecked(detail.depositions.filter((d) => d.witnessId === w.id && d.status === "ready").map((d) => d.id), detail.analyses)).filter((p) => p.total > 1);
  if (notes.length === 0) return null;
  return <Badge>{notes.reduce((n, p) => n + p.checked, 0)} of {notes.reduce((n, p) => n + p.total, 0)} session pairs checked</Badge>;
}

function ReportRow({ r }: { r: AnalysisView }) {
  const s = ANALYSIS_STATUS[r.status];
  const [a, b] = r.depositions;
  return (
    <li>
      <a href={href.analysis(r.id)} className="group flex flex-col justify-between gap-2 rounded-xl bg-white/50 p-space-md transition-colors hover:bg-white/85 md:flex-row md:items-center">
        <span className="min-w-0">
          <span className="block font-semibold group-hover:text-secondary">{a.witness}: {formatDate(a.takenOn)} vs {formatDate(b.takenOn)}</span>
          <span className="block text-body-sm text-on-surface-variant">
            {formatDate(r.createdAt)}
            {r.status === "completed" && ` · ${r.findings.groups.contradictions} potential ${r.findings.groups.contradictions === 1 ? "contradiction" : "contradictions"} · ${r.findings.groups.needs_context} need context`}
          </span>
        </span>
        <span className="flex flex-none items-center gap-4">
          {r.status === "completed" ? <span className="text-label-md tabular-nums text-on-surface-variant">{Math.min(r.findings.decided, r.findings.total)} of {r.findings.total} decided</span> : <Badge tone={s.tone} dot>{isActive(r.status) ? "Checking…" : "Couldn't finish"}</Badge>}
          {r.mode === "demo" && <Badge tone="accent">Example</Badge>}
          <ChevronRight aria-hidden className="size-5 text-on-surface-variant" />
        </span>
      </a>
    </li>
  );
}

function Upload({ caseId, witnesses, onDone, onCancel }: { caseId: number; witnesses: string[]; onDone: () => void; onCancel: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [witness, setWitness] = useState(witnesses[0] ?? "");
  const [takenOn, setTakenOn] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const tooBig = !!file && file.size > MAX_UPLOAD_MB * 1024 * 1024;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await api.upload(caseId, file, witness.trim(), takenOn || undefined);
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-4 p-space-lg">
      <Field label="Deposition PDF" hint={`Up to ${MAX_UPLOAD_MB} MB.`}>
        <input type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-body-sm file:mr-3 file:rounded-lg file:border-0 file:bg-surface-container file:px-3 file:py-2 file:font-medium" />
      </Field>
      <Field label="Witness name">
        <input className={inputClass} list="witnesses" value={witness} onChange={(e) => setWitness(e.target.value)} required maxLength={200} />
        <datalist id="witnesses">{witnesses.map((w) => <option key={w} value={w} />)}</datalist>
      </Field>
      <Field label="Date taken"><input className={inputClass} type="date" value={takenOn} onChange={(e) => setTakenOn(e.target.value)} /></Field>
      {tooBig && <Alert tone="warn">This file is larger than {MAX_UPLOAD_MB} MB.</Alert>}
      {error && <Alert>{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={busy || !file || !witness.trim() || tooBig}>{busy ? "Adding…" : "Add deposition"}</Button>
      </div>
    </form>
  );
}
