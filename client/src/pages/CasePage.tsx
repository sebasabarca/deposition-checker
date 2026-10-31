import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { BookOpen, FileText, FileUp, GitCompareArrows, RefreshCw, TriangleAlert } from "lucide-react";
import { PassageLines, Term } from "../components/FindingView";
import { Alert, Badge, Button, buttonClass, Card, CardHeader, cx, Dialog, Empty, Field, inputClass, Loading, Meter, Metric, ModelMark, OcrMark, PageHeader, tdClass, TestimonyMark, thClass } from "../components/ui";
import { api } from "../lib/api";
import { isActive, ocrPassage } from "../lib/insights";
import { ANALYSIS_STATUS, DEPOSITION_STATUS, formatDate } from "../lib/labels";
import { href, usePoll } from "../lib/router";
import type { CaseDetail, CaseSummary, DepositionRow, FindingDetail, OcrReadout } from "../types";

const MAX_UPLOAD_MB = 50; // server/src/api/depositions.ts
const selectClass = "h-10 max-w-64 min-w-0 truncate rounded-lg bg-surface-container-lowest px-space-md text-body-sm font-medium shadow-sm";

export function CasePage({ id }: { id: number }) {
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [witnessId, setWitnessId] = useState<number | "all">("all");
  const [selected, setSelected] = useState<number | null>(null);
  const [dialog, setDialog] = useState<"upload" | "compare" | null>(null);
  const load = useCallback(() => {
    api.case(id).then(setDetail).catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  useEffect(() => {
    api.cases().then((r) => setCases(r.cases)).catch((e: Error) => setError(e.message));
  }, []);
  const busy = !!detail && (detail.depositions.some((d) => d.status === "processing") || detail.analyses.some((a) => isActive(a.status)));
  usePoll(busy, 2000, load);

  if (error) return <Alert title="This case couldn't be loaded">{error}</Alert>;
  if (!detail) return <Loading />;
  const witnessName = (wid: number) => detail.witnesses.find((w) => w.id === wid)?.name ?? "Unknown witness";
  const sessions = detail.depositions.filter((d) => witnessId === "all" || d.witnessId === witnessId);
  const pages = detail.depositions.reduce((n, d) => n + (d.pageCount ?? 0), 0);
  const noText = detail.depositions.reduce((n, d) => n + d.needsOcrPages.length, 0);
  const attention = detail.depositions.filter((d) => d.status === "needs_review" || d.status === "failed" || d.status === "unsupported").length;
  const inspected = selected ?? sessions.find((d) => d.status === "ready")?.id ?? null;

  return (
    <>
      <PageHeader
        above={
          <p className="text-label-md text-on-surface-variant">
            <a href={href.cases()} className="hover:text-secondary">Cases</a> <span aria-hidden className="text-outline-variant">/</span> <span className="text-secondary">{detail.case.name}</span>
          </p>
        }
        title="Deposition management"
        description="Uploaded transcripts as the parser read them. Only sessions marked Ready can be compared."
        actions={
          <>
            <select aria-label="Case" value={id} onChange={(e) => (window.location.hash = href.case(Number(e.target.value)))} className={selectClass}>
              {(cases.length ? cases : [detail.case]).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select aria-label="Witness" value={witnessId} onChange={(e) => setWitnessId(e.target.value === "all" ? "all" : Number(e.target.value))} className={selectClass}>
              <option value="all">All witnesses</option>
              {detail.witnesses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <Button variant="secondary" className="h-10" onClick={() => setDialog("compare")}><GitCompareArrows aria-hidden className="size-[18px] text-on-surface-variant" />New analysis</Button>
            <Button className="h-10" onClick={() => setDialog("upload")}><FileUp aria-hidden className="size-[18px]" />Upload transcript</Button>
          </>
        }
      />

      <div className="grid gap-space-md sm:grid-cols-2 xl:grid-cols-4">
        <Metric icon={FileText} value={detail.depositions.length} label={detail.depositions.length === 1 ? "Session" : "Sessions"} note={`${detail.witnesses.length} ${detail.witnesses.length === 1 ? "witness" : "witnesses"}`} />
        <Metric icon={BookOpen} value={pages.toLocaleString()} label="Pages read" note={noText ? `${noText} without text` : "All with text"} />
        <Metric icon={RefreshCw} value={detail.depositions.filter((d) => d.status === "processing").length} label="Being read" />
        <Metric icon={TriangleAlert} value={attention} label="Need attention" note="Failed, unsupported or needs review" tone={attention ? "bad" : undefined} />
      </div>

      <div className="grid grid-cols-1 items-start gap-space-md xl:grid-cols-12">
        <div className="space-y-space-md xl:col-span-7">
          <Card className="overflow-hidden">
            <CardHeader title="Deposition sessions" action={<Badge>{sessions.length} shown</Badge>} />
            {sessions.length === 0 ? (
              <div className="px-space-md pb-space-md"><Empty title="No depositions yet"><Button className="mt-space-sm" onClick={() => setDialog("upload")}>Upload a PDF</Button></Empty></div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[36rem] border-collapse text-left text-body-sm">
                  <thead className="bg-surface-container-low text-on-surface-variant">
                    <tr>
                      {["Session", "Date", "Status", "Extent"].map((h) => <th key={h} className={thClass}>{h}</th>)}
                      <th className={cx(thClass, "pl-0 text-right")}><span className="sr-only">Action</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((d) => (
                      <DepositionRowView key={d.id} d={d} witness={witnessName(d.witnessId)} active={d.id === inspected} onInspect={() => setSelected(d.id)} onRetry={() => api.retryDeposition(d.id).then(load).catch((e: Error) => setError(e.message))} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card className="overflow-hidden">
            <CardHeader title="Analyses" description="Each analysis compares two sessions of one witness." />
            {detail.analyses.length === 0 ? (
              <div className="px-space-md pb-space-md"><Empty title="No analyses yet">Choose two ready sessions of the same witness and start an analysis.</Empty></div>
            ) : (
              <ul className="pb-space-sm">
                {detail.analyses.map((a) => {
                  const s = ANALYSIS_STATUS[a.status];
                  const date = (dep: number) => formatDate(detail.depositions.find((d) => d.id === dep)?.takenOn ?? null);
                  return (
                    <li key={a.id}>
                      <a href={href.analysis(a.id)} className="flex flex-wrap items-center justify-between gap-3 px-space-lg py-space-sm transition-colors hover:bg-surface-container-low/70">
                        <span className="min-w-0">
                          <span className="block font-semibold">{witnessName(a.witnessId)}: {date(a.depositionA)} vs. {date(a.depositionB)}</span>
                          <span className="block text-body-sm text-on-surface-variant">Analysis #{a.id} · {a.progress.findings ?? 0} findings · {a.mode === "demo" ? "Demo (no model calls)" : "Live"}</span>
                        </span>
                        <Badge tone={s.tone} dot>{s.label}</Badge>
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
        <div className="space-y-space-md xl:col-span-5">
          {inspected !== null && <ScanReadout key={`scan${inspected}`} depositionId={inspected} />}
          <TranscriptInspector key={inspected} depositionId={inspected} analyses={detail.analyses} />
        </div>
      </div>

      <Dialog open={dialog === "compare"} onClose={() => setDialog(null)} title="Compare two sessions"><StartAnalysis detail={detail} /></Dialog>
      <Dialog open={dialog === "upload"} onClose={() => setDialog(null)} title="Upload a deposition"><Upload caseId={id} witnesses={detail.witnesses.map((w) => w.name)} onUploaded={load} /></Dialog>
    </>
  );
}

function DepositionRowView({ d, witness, active, onInspect, onRetry }: { d: DepositionRow; witness: string; active: boolean; onInspect: () => void; onRetry: () => void }) {
  const s = DEPOSITION_STATUS[d.status];
  const name = d.originalFilename ?? `Deposition #${d.id}`;
  return (
    <tr className={cx("align-top transition-colors", active ? "bg-surface-container/60" : "hover:bg-surface-container-low")}>
      <td className={cx(tdClass, "max-w-56")}>
        <span className="block truncate font-semibold" title={`${name} · SHA-256 ${d.fileSha256}`}>{name}</span>
        <span className="block text-on-surface-variant">{witness}</span>
      </td>
      <td className={cx(tdClass, "whitespace-nowrap")}>{formatDate(d.takenOn)}</td>
      <td className={tdClass}>
        <Badge tone={s.tone} dot>{s.label}</Badge>
        {d.error && <p className="mt-1 max-w-48 text-label-sm text-on-error-container">{d.error}</p>}
      </td>
      <td className={tdClass}>
        {d.pageCount === null ? "—" : <span className="whitespace-nowrap tabular-nums">{d.pageCount.toLocaleString()} pp.</span>}
        {!!d.pageCount && <Meter value={(d.pageCount - d.needsOcrPages.length) / d.pageCount} label={`Pages of ${name} with text`} />}
        {d.needsOcrPages.length > 0 && <span className="mt-1 block text-label-sm text-on-warning-container">{d.needsOcrPages.length} without text</span>}
      </td>
      <td className={cx(tdClass, "pl-0 text-right")}>
        {d.status === "failed" ? (
          <Button variant="secondary" className="h-8" onClick={onRetry}>Try again</Button>
        ) : (
          <Button variant={active ? "primary" : "ghost"} className="h-8" disabled={d.status !== "ready" && d.status !== "needs_review"} aria-pressed={active} onClick={onInspect}>Inspect</Button>
        )}
      </td>
    </tr>
  );
}

// Everything OCR changed or left out is counted here. Nothing shows for a file with a text layer.
function ScanReadout({ depositionId }: { depositionId: number }) {
  const [ocr, setOcr] = useState<OcrReadout | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.deposition(depositionId).then((r) => setOcr(r.deposition.validation?.ocr ?? null)).catch((e: Error) => setError(e.message));
  }, [depositionId]);
  if (error) return <Alert title="This session's OCR details couldn't be loaded">{error}</Alert>;
  if (!ocr) return null;
  const pageLink = (p: number) => <a key={p} href={api.depositionPdf(depositionId, p)} target="_blank" rel="noreferrer" className="underline">{p}</a>;
  return (
    <Card>
      <CardHeader title="Scanned file" description="This file has no text layer. Its text was read by OCR and may differ from the scan." action={<OcrMark />} />
      <div className="space-y-space-md px-space-lg pb-space-lg text-body-sm">
        {ocr.inferredPages.length > 0 && (
          <Alert tone="warn" title="Inferred page numbers">
            OCR couldn't read the printed number on these PDF pages, so it was worked out from the pages either side. Check them against the scan before citing: {ocr.inferredPages.map((p, i) => <span key={p}>{i > 0 && ", "}{pageLink(p)}</span>)}.
          </Alert>
        )}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
          <Term label="OCR engine">{ocr.engine}</Term>
          <Term label="Mean confidence">{ocr.meanConfidence === null ? "Not measured" : `${Math.round(ocr.meanConfidence)}%`}</Term>
          <Term label="Low-confidence words">{ocr.lowConfidenceWords.toLocaleString()}</Term>
          <Term label="Line markers corrected">{ocr.markersCorrected.toLocaleString()}</Term>
          <Term label="Noise marks removed">{ocr.noiseWords.toLocaleString()}</Term>
          <Term label="Cover pages">{ocr.coverPages.length ? ocr.coverPages.join(", ") : "None"}</Term>
        </dl>
        {ocr.annotations.length > 0 && (
          <details>
            <summary className="cursor-pointer font-medium">{ocr.annotations.length} {ocr.annotations.length === 1 ? "mark" : "marks"} outside the transcript lines, left out of the testimony</summary>
            <ul className="mt-1 space-y-0.5 text-on-surface-variant">
              {ocr.annotations.map((a, i) => <li key={i}>PDF page {a.pdfPage}: {a.text}</li>)}
            </ul>
          </details>
        )}
      </div>
    </Card>
  );
}

// The API serves no whole transcript pages yet, so this shows the stored lines that findings cite.
function TranscriptInspector({ depositionId, analyses }: { depositionId: number | null; analyses: CaseDetail["analyses"] }) {
  const [cited, setCited] = useState<{ id: number; ref: string | null }[] | null>(null);
  const [findingId, setFindingId] = useState<number | null>(null);
  const [finding, setFinding] = useState<FindingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const analysisIds = analyses.map((a) => a.id).join();
  useEffect(() => {
    if (depositionId === null) return;
    Promise.all(analyses.map((a) => api.findings(a.id)))
      .then((all) => {
        const rows = all.flatMap((r) => r.groups.flatMap((g) => g.findings)).flatMap((f) => (f.a.depositionId === depositionId ? [{ id: f.id, ref: f.a.ref }] : f.b.depositionId === depositionId ? [{ id: f.id, ref: f.b.ref }] : []));
        setCited(rows);
        setFindingId(rows[0]?.id ?? null);
      })
      .catch((e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depositionId, analysisIds]);
  useEffect(() => {
    if (findingId === null) return;
    api.finding(findingId).then((r) => setFinding(r.finding)).catch((e: Error) => setError(e.message));
  }, [findingId]);
  const side = finding && (finding.a.deposition.id === depositionId ? finding.a : finding.b);

  return (
    <Card className="flex flex-col overflow-hidden">
      <CardHeader title="Transcript inspector" description="Stored lines cited by findings in this session." action={side && ocrPassage(side) ? <OcrMark /> : <TestimonyMark />} />
      {error && <div className="px-space-md pb-space-md"><Alert>{error}</Alert></div>}
      {depositionId === null && <div className="px-space-md pb-space-md"><Empty title="No ready session to inspect" /></div>}
      {depositionId !== null && !error && !cited && <Loading />}
      {cited?.length === 0 && <div className="px-space-md pb-space-md"><Empty title="No cited passages yet">Cited lines appear here once an analysis of this session has findings.</Empty></div>}
      {cited && cited.length > 0 && (
        <>
          <div className="px-space-lg pb-space-md">
            <select aria-label="Cited passage" value={findingId ?? ""} onChange={(e) => setFindingId(Number(e.target.value))} className={cx(selectClass, "w-full")}>
              {cited.map((c, i) => <option key={c.id} value={c.id}>Passage {i + 1} of {cited.length}: {c.ref ?? "no page:line"}</option>)}
            </select>
          </div>
          <div className="max-h-[36rem] overflow-y-auto bg-surface p-space-md">{side ? <PassageLines side={side} mark={finding.classification === "direct" || finding.classification === "inferential" ? "red" : "amber"} /> : <Loading />}</div>
          {finding && (
            <div className="space-y-space-sm p-space-md">
              <ModelMark />
              <p className="text-body-sm">{finding.assessment.explanation}</p>
              <a href={href.analysis(finding.analysisId ?? 0, finding.id)} className={buttonClass("primary", "w-full")}>Open in workbench</a>
            </div>
          )}
        </>
      )}
    </Card>
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
    <>
      {comparable.length === 0 ? (
        <div className="p-space-lg">
          <Empty title="Not enough sessions yet">An analysis needs two ready deposition sessions of the same witness.</Empty>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4 p-space-lg">
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
          <fieldset className="space-y-2 text-body-sm">
            <legend className="font-medium">Assessment</legend>
            <label className="flex items-start gap-2">
              <input type="radio" name="mode" checked={mode === "demo"} onChange={() => setMode("demo")} className="mt-1" />
              <span>
                <span className="font-medium">Demo</span>
                <span className="block text-on-surface-variant">No model calls and no cost. Shows stored assessments from earlier runs where they exist.</span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="mode" checked={mode === "live"} onChange={() => setMode("live")} className="mt-1" />
              <span>
                <span className="font-medium">Live</span>
                <span className="block text-on-surface-variant">Calls Claude Sonnet for each candidate pair, within the budget. Needs the server to allow paid calls.</span>
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
    </>
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
    <form onSubmit={submit} className="space-y-4 p-space-lg">
        <p className="text-body-sm text-on-surface-variant">A PDF transcript, up to {MAX_UPLOAD_MB} MB. Scanned files are supported where the layout is recognised; their OCR text may differ from the scan.</p>
        <Field label="Transcript PDF">
          <input type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="block w-full text-body-sm file:mr-3 file:rounded-lg file:border-0 file:bg-surface-container file:px-3 file:py-2 file:text-body-sm file:font-medium" />
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
        <Button type="submit" disabled={busy || !file || !witness.trim() || tooBig} className="w-full">
          {busy ? "Uploading…" : "Upload"}
        </Button>
    </form>
  );
}
