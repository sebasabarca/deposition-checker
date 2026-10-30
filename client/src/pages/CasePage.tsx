import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Alert, Badge, Button, Card, CardHeader, Empty, Field, inputClass, Loading } from "../components/ui";
import { api } from "../lib/api";
import { ANALYSIS_STATUS, DEPOSITION_STATUS, formatDate } from "../lib/labels";
import { href, usePoll } from "../lib/router";
import type { CaseDetail, DepositionRow } from "../types";

const MAX_UPLOAD_MB = 50; // server/src/api/depositions.ts

export function CasePage({ id }: { id: number }) {
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.case(id).then(setDetail).catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  const busy = !!detail && (detail.depositions.some((d) => d.status === "processing") || detail.analyses.some((a) => !["completed", "failed", "blocked_budget", "blocked_credentials", "cancelled", "interrupted"].includes(a.status)));
  usePoll(busy, 2000, load);

  if (error) return <Alert title="This case couldn't be loaded">{error}</Alert>;
  if (!detail) return <Loading />;
  const witnessName = (wid: number) => detail.witnesses.find((w) => w.id === wid)?.name ?? "Unknown witness";

  return (
    <div className="space-y-6">
      <div>
        <a href={href.cases()} className="text-sm text-slate-600 hover:text-slate-900">← Cases</a>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">{detail.case.name}</h1>
        <p className="text-sm text-slate-600">
          {detail.witnesses.length} {detail.witnesses.length === 1 ? "witness" : "witnesses"} · {detail.depositions.length} deposition sessions{detail.analyses.length > 0 ? ` · ${detail.case.findings} findings in the latest analysis` : ""}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-6">
          <Card>
            <CardHeader title="Deposition sessions" description="Each uploaded transcript, as read by the parser. Only sessions marked Ready can be compared." />
            <div className="p-5">
              {detail.depositions.length === 0 ? (
                <Empty title="No depositions yet">Upload a deposition PDF to begin.</Empty>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="py-2 pr-4 font-medium">Witness</th>
                        <th className="py-2 pr-4 font-medium">Session date</th>
                        <th className="py-2 pr-4 font-medium">File</th>
                        <th className="py-2 pr-4 font-medium">Pages</th>
                        <th className="py-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {detail.depositions.map((d) => (
                        <DepositionRowView key={d.id} d={d} witness={witnessName(d.witnessId)} onRetry={() => api.retryDeposition(d.id).then(load).catch((e: Error) => setError(e.message))} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Analyses" description="Each analysis compares two sessions of one witness." />
            <div className="p-5">
              {detail.analyses.length === 0 ? (
                <Empty title="No analyses yet">Choose two ready sessions of the same witness and start an analysis.</Empty>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {detail.analyses.map((a) => {
                    const s = ANALYSIS_STATUS[a.status];
                    const date = (dep: number) => formatDate(detail.depositions.find((d) => d.id === dep)?.takenOn ?? null);
                    return (
                      <li key={a.id}>
                        <a href={href.analysis(a.id)} className="flex flex-wrap items-center justify-between gap-3 rounded-md px-2 py-3 hover:bg-slate-50">
                          <div className="min-w-0">
                            <p className="font-medium text-slate-900">
                              {witnessName(a.witnessId)}: {date(a.depositionA)} vs. {date(a.depositionB)}
                            </p>
                            <p className="text-sm text-slate-600">
                              Analysis #{a.id} · {a.progress.findings ?? 0} findings · {a.mode === "demo" ? "Demo (no model calls)" : "Live"}
                            </p>
                          </div>
                          <Badge tone={s.tone}>{s.label}</Badge>
                        </a>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <StartAnalysis detail={detail} />
          <Upload caseId={id} witnesses={detail.witnesses.map((w) => w.name)} onUploaded={load} />
        </div>
      </div>
    </div>
  );
}

function DepositionRowView({ d, witness, onRetry }: { d: DepositionRow; witness: string; onRetry: () => void }) {
  const s = DEPOSITION_STATUS[d.status];
  return (
    <tr className="align-top">
      <td className="py-3 pr-4 text-slate-900">{witness}</td>
      <td className="py-3 pr-4 text-slate-700">{formatDate(d.takenOn)}</td>
      <td className="max-w-48 truncate py-3 pr-4 text-slate-700" title={d.originalFilename ?? `sha256 ${d.fileSha256}…`}>
        {d.originalFilename ?? <span className="text-slate-400">Deposition #{d.id}</span>}
      </td>
      <td className="py-3 pr-4 text-slate-700">
        {d.pageCount ?? "—"}
        {d.needsOcrPages.length > 0 && <span className="block text-xs text-amber-800">{d.needsOcrPages.length} without text</span>}
      </td>
      <td className="py-3">
        <Badge tone={s.tone}>{s.label}</Badge>
        {d.error && <p className="mt-1 max-w-64 text-xs text-rose-800">{d.error}</p>}
        {d.status === "failed" && (
          <button onClick={onRetry} className="mt-1 block text-xs font-medium text-slate-700 underline">
            Try again
          </button>
        )}
      </td>
    </tr>
  );
}

function StartAnalysis({ detail }: { detail: CaseDetail }) {
  const comparable = useMemo(() => detail.witnesses.filter((w) => detail.depositions.filter((d) => d.witnessId === w.id && d.status === "ready").length >= 2), [detail]);
  const [witnessId, setWitnessId] = useState<number | null>(comparable[0]?.id ?? null);
  const sessions = detail.depositions.filter((d) => d.witnessId === witnessId && d.status === "ready");
  const [a, setA] = useState<number | null>(null);
  const [b, setB] = useState<number | null>(null);
  const [mode, setMode] = useState<"demo" | "live">("demo");
  const [budget, setBudget] = useState("3");
  const [strategy, setStrategy] = useState("C");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setA(sessions[0]?.id ?? null);
    setB(sessions[1]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [witnessId, detail.depositions.length]);

  const label = (d: DepositionRow) => `${formatDate(d.takenOn)}${d.originalFilename ? ` · ${d.originalFilename}` : ""}`;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (a === null || b === null) return;
    setBusy(true);
    setError(null);
    try {
      const { analysis } = await api.startAnalysis(detail.case.id, { depositionA: a, depositionB: b, mode, ...(mode === "live" ? { budgetUsd: Number(budget), strategy } : {}) });
      window.location.hash = href.analysis(analysis.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Compare two sessions" />
      {comparable.length === 0 ? (
        <div className="p-5">
          <Empty title="Not enough sessions yet">An analysis needs two ready deposition sessions of the same witness.</Empty>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4 p-5">
          <Field label="Witness">
            <select className={inputClass} value={witnessId ?? ""} onChange={(e) => setWitnessId(Number(e.target.value))}>
              {comparable.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </Field>
          <Field label="First session">
            <select className={inputClass} value={a ?? ""} onChange={(e) => setA(Number(e.target.value))}>
              {sessions.map((d) => (
                <option key={d.id} value={d.id}>{label(d)}</option>
              ))}
            </select>
          </Field>
          <Field label="Second session">
            <select className={inputClass} value={b ?? ""} onChange={(e) => setB(Number(e.target.value))}>
              {sessions.map((d) => (
                <option key={d.id} value={d.id}>{label(d)}</option>
              ))}
            </select>
          </Field>
          <fieldset className="space-y-2 text-sm">
            <legend className="font-medium text-slate-800">Assessment</legend>
            <label className="flex items-start gap-2">
              <input type="radio" name="mode" checked={mode === "demo"} onChange={() => setMode("demo")} className="mt-1" />
              <span>
                <span className="font-medium">Demo</span>
                <span className="block text-slate-600">No model calls and no cost. Shows stored assessments from earlier runs where they exist.</span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="mode" checked={mode === "live"} onChange={() => setMode("live")} className="mt-1" />
              <span>
                <span className="font-medium">Live</span>
                <span className="block text-slate-600">Calls Claude Sonnet for each candidate pair, within the budget. Needs the server to allow paid calls.</span>
              </span>
            </label>
          </fieldset>
          {mode === "live" && (
            <Field label="Budget (USD)" hint="The analysis stops before any call the budget can't fully cover.">
              <input className={inputClass} type="number" min="0.1" max="20" step="0.1" value={budget} onChange={(e) => setBudget(e.target.value)} />
            </Field>
          )}
          {mode === "live" && (
            <Field label="Speed" hint="Requests sent at once. The cost is about the same; each is still budgeted before it is sent.">
              <select className={inputClass} value={strategy} onChange={(e) => setStrategy(e.target.value)}>
                <option value="C">Ten at a time (recommended)</option>
                <option value="B">Five at a time</option>
                <option value="A">One at a time (slowest; use if the service limits requests)</option>
              </select>
            </Field>
          )}
          {a !== null && a === b && <Alert tone="warn">Choose two different sessions.</Alert>}
          {error && <Alert>{error}</Alert>}
          <Button type="submit" disabled={busy || a === null || b === null || a === b} className="w-full">
            {busy ? "Starting…" : "Start analysis"}
          </Button>
        </form>
      )}
    </Card>
  );
}

function Upload({ caseId, witnesses, onUploaded }: { caseId: number; witnesses: string[]; onUploaded: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [witness, setWitness] = useState(witnesses[0] ?? "");
  const [takenOn, setTakenOn] = useState("");
  const [message, setMessage] = useState<{ tone: "bad" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const tooBig = !!file && file.size > MAX_UPLOAD_MB * 1024 * 1024;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const r = await api.upload(caseId, file, witness.trim(), takenOn || undefined);
      setMessage({ tone: "info", text: r.created ? "Uploaded. The transcript is being read; this table updates by itself." : "This file was already uploaded to the case; the existing session is shown." });
      setFile(null);
      onUploaded();
    } catch (err) {
      setMessage({ tone: "bad", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader title="Upload a deposition" description={`A text-based PDF transcript, up to ${MAX_UPLOAD_MB} MB.`} />
      <form onSubmit={submit} className="space-y-4 p-5">
        <Field label="Transcript PDF">
          <input type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium" />
        </Field>
        <Field label="Witness" hint="An existing witness, or a new name.">
          <input className={inputClass} list="witnesses" value={witness} onChange={(e) => setWitness(e.target.value)} required maxLength={200} />
          <datalist id="witnesses">
            {witnesses.map((w) => (
              <option key={w} value={w} />
            ))}
          </datalist>
        </Field>
        <Field label="Session date" hint="Optional; if the transcript doesn't state it, leave it empty.">
          <input className={inputClass} type="date" value={takenOn} onChange={(e) => setTakenOn(e.target.value)} />
        </Field>
        {tooBig && <Alert tone="warn">This file is larger than {MAX_UPLOAD_MB} MB.</Alert>}
        {message && <Alert tone={message.tone}>{message.text}</Alert>}
        <Button type="submit" variant="secondary" disabled={busy || !file || !witness.trim() || tooBig} className="w-full">
          {busy ? "Uploading…" : "Upload"}
        </Button>
      </form>
    </Card>
  );
}
