// One deposition: read it page by page as the transcript, search it, and see where it was checked.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, Pencil } from "lucide-react";
import { DangerZone } from "../components/DangerZone";
import { TranscriptRows } from "../components/FindingView";
import { useNow } from "../components/CheckProgress";
import { Alert, Badge, Breadcrumbs, Button, buttonClass, Card, CardHeader, cx, Dialog, Field, fieldClass, inputClass, Loading, PageHeader, selectClass } from "../components/ui";
import { dateAction } from "../components/sessionActions";
import { DateInput } from "../components/DateInput";
import { api } from "../lib/api";
import { inMarkedRange, isActive } from "../lib/insights";
import { ANALYSIS_STATUS, DEPOSITION_STATUS, formatDate } from "../lib/labels";
import { href, usePoll } from "../lib/router";
import type { AnalysisView, CaseDetail, CaseSummary, DepositionLines, DepositionView } from "../types";

const FORMAT = { pdf: "PDF", html: "HTML", text: "Text", rtf: "RTF", docx: "Word (.docx)" } as const;

export function DepositionPage({ id, page, q, mark }: { id: number; page: number | null; q: string; mark: string }) {
  const [d, setD] = useState<DepositionView | null>(null);
  const [kase, setKase] = useState<CaseDetail | null>(null);
  const [analyses, setAnalyses] = useState<AnalysisView[]>([]);
  const [text, setText] = useState<DepositionLines | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState<"witness" | "case" | null>(null);
  const [editingDate, setEditingDate] = useState(false);
  const load = useCallback(() => {
    api.deposition(id).then((r) => setD(r.deposition)).catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  usePoll(d?.status === "processing", 3000, load);
  const caseId = d?.caseId;
  useEffect(() => {
    if (caseId === undefined) return;
    api.case(caseId).then(async (c) => {
      setKase(c);
      const mine = c.analyses.filter((a) => a.depositionA === id || a.depositionB === id);
      setAnalyses((await Promise.all(mine.map((a) => api.analysis(a.id)))).map((r) => r.analysis).sort((a, b) => b.id - a.id));
    }).catch(() => undefined);
  }, [caseId, id]);
  const ready = d?.status === "ready" || d?.status === "needs_review";
  useEffect(() => {
    if (!ready) return;
    api.lines(id, { page, q }).then(setText).catch((e: Error) => setError(e.message));
  }, [id, page, q, ready]);

  // Opened from a finding: bring its cited lines into view, once they are on the page.
  useEffect(() => {
    if (mark && text) document.querySelector("[data-highlighted]")?.scrollIntoView({ block: "center" });
  }, [mark, text]);

  if (error) return <Alert title="This deposition couldn't be loaded">{error}</Alert>;
  if (!d) return <Loading />;
  const s = DEPOSITION_STATUS[d.status];
  const at = text?.page ?? null;
  const pageIndex = at === null ? -1 : (text?.pages.indexOf(at) ?? -1);
  const go = (p: number | null, query = q) => (window.location.hash = href.deposition(id, { page: p, q: query, mark }));
  const hitLines = new Set(text?.hits.map((h) => h.id));
  const isText = d.sourceFormat === "text";
  const downloadOnly = d.sourceFormat === "rtf" || d.sourceFormat === "docx"; // downloads; the browser can't show it
  const warnings = d.validation?.warnings ?? [];

  return (
    <>
      <PageHeader
        above={<Breadcrumbs items={[{ label: "Cases", href: href.cases() }, ...(kase ? [{ label: kase.case.name, href: href.case(kase.case.id) }] : [])]} />}
        title={<>{d.witness.name}<span className="font-normal text-muted">, {formatDate(d.takenOn)}</span></>}
        description={[d.originalFilename ?? `Deposition #${d.id}`, d.pageCount && d.validation?.layout !== "text-unnumbered-v1" ? `${d.pageCount} ${d.pageCount === 1 ? "page" : "pages"}` : null, d.stored.lines ? `${d.stored.lines.toLocaleString()} lines` : null].filter(Boolean).join(" · ")}
        actions={<a href={api.depositionOriginal(d.id)} target={downloadOnly ? undefined : "_blank"} rel="noreferrer" className={buttonClass("secondary")}><ExternalLink aria-hidden className="size-3.5" />{downloadOnly ? `Download original ${FORMAT[d.sourceFormat]}` : `View original ${isText ? "text" : "PDF"}`}</a>}
      />
      {d.status === "processing" && <Reading since={d.createdAt} scanned={d.sourceFormat === "pdf"} />}
      {(d.status === "failed" || d.status === "unsupported") && <Alert title={s.label} action={d.status === "failed" ? <Button variant="secondary" onClick={() => api.retryDeposition(d.id).then(load).catch((e: Error) => setError(e.message))}>Try again</Button> : undefined}>{d.error ?? "This file's layout isn't recognized."}</Alert>}
      {d.status === "needs_review" && <Alert tone="warn" title="Some pages couldn't be read">{d.error ?? "The pages that were read are shown below."}</Alert>}
      <DateBanner d={d} onSaved={setD} onEnter={() => { setEditingDate(true); document.getElementById("date-taken")?.scrollIntoView({ block: "center" }); }} />
      {d.status === "ready" && warnings.length > 0 && (
        <Alert tone="warn" title="Check before citing">
          <ul className="list-disc space-y-1 pl-5">{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </Alert>
      )}

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_21rem]">
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule px-5 py-3">
            <SearchBox initial={q} onSearch={(query) => go(at, query)} />
            {text && text.pages.length > 1 && (
              <div className="flex items-center gap-1.5">
                <Button variant="secondary" className="w-8 px-0!" aria-label="Previous page" disabled={pageIndex <= 0} onClick={() => go(text.pages[pageIndex - 1])}><ChevronLeft aria-hidden className="size-4" /></Button>
                <label className="flex items-center gap-2 text-sm text-muted">
                  Page
                  <select value={at ?? ""} onChange={(e) => go(Number(e.target.value))} className="h-8 rounded-md border border-control bg-sheet px-2 text-sm text-ink tabular-nums">
                    {text.pages.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                  <span className="tabular-nums">of {text.pages.at(-1)}</span>
                </label>
                <Button variant="secondary" className="w-8 px-0!" aria-label="Next page" disabled={pageIndex < 0 || pageIndex >= text.pages.length - 1} onClick={() => go(text.pages[pageIndex + 1])}><ChevronRight aria-hidden className="size-4" /></Button>
              </div>
            )}
          </div>
          {!ready ? (
            <p className="px-5 py-16 text-center text-sm text-muted">{d.status === "processing" ? "The transcript appears here once it has been read." : "No transcript lines were stored for this file."}</p>
          ) : !text ? (
            <div className="p-5"><Loading rows={8} /></div>
          ) : text.lines.length === 0 ? (
            <p className="px-5 py-16 text-center text-sm text-muted">No lines were stored for this deposition.</p>
          ) : (
            <div className="mx-auto max-w-[52rem]">
              <p className="px-5 pt-5 pb-2 text-right font-mono text-sm text-faint">{at === 0 ? "Text without page numbers, cited by line" : `Page ${at}`}</p>
              <div className="transcript pb-6">
                <TranscriptRows lines={text.lines.map((l) => ({ id: l.id, ref: String(l.lineNo), text: l.text, ocrConfidence: l.ocrConfidence, highlighted: hitLines.has(l.id) || (at !== null && inMarkedRange(mark, at, l.lineNo)) }))} />
              </div>
            </div>
          )}
        </Card>

        <div className="space-y-6 xl:sticky xl:top-6">
          {q && text && (
            <Card>
              <CardHeader title={`“${q}”`} count={text.hits.length} action={<button type="button" onClick={() => go(at, "")} className="text-sm font-medium text-info hover:underline">Clear</button>} />
              {text.hits.length === 0 ? <p className="px-5 py-4 text-sm text-muted">No line contains these words.</p> : (
                <ol className="max-h-[50vh] divide-y divide-rule overflow-y-auto">
                  {text.hits.map((h) => (
                    <li key={h.id}>
                      <a href={href.deposition(id, { page: h.page, q })} className={cx("grid grid-cols-[3.5rem_1fr] gap-2 px-5 py-2.5 text-sm hover:bg-hover", h.page === at && "bg-info-bg")}>
                        <span className="font-mono text-[12px] text-faint tabular-nums">{h.page}:{String(h.lineNo).padStart(2, "0")}</span>
                        <span className="line-clamp-2 font-mono text-[13px]"><Highlight text={h.text} term={q} /></span>
                      </a>
                    </li>
                  ))}
                </ol>
              )}
              {text.moreHits && <p className="border-t border-rule px-5 py-2.5 text-xs text-faint">Showing the first {text.hits.length}. Search for more exact words to narrow it.</p>}
            </Card>
          )}

          <Card>
            <CardHeader title="Details" />
            <dl className="divide-y divide-rule text-sm">
              <Row label="Status"><Badge tone={s.tone} dot>{s.label}</Badge></Row>
              <DateRow d={d} onSaved={setD} editing={editingDate} setEditing={setEditingDate} />
              <Row label="Witness"><span className="flex items-center gap-2"><span className="font-medium">{d.witness.name}</span><ChangeButton label="Change witness" onClick={() => setMoving("witness")} /></span></Row>
              <Row label="Case"><span className="flex min-w-0 items-center justify-end gap-2">{kase ? <a href={href.case(kase.case.id)} className="min-w-0 truncate font-medium hover:underline">{kase.case.name}</a> : "–"}<ChangeButton label="Change case" onClick={() => setMoving("case")} /></span></Row>
              <Row label="Source">{d.sourceFormat === "pdf" && d.validation?.ocr ? "Scanned PDF, read from the page images" : FORMAT[d.sourceFormat]}</Row>
              {d.validation?.ocr?.meanConfidence != null && <Row label="Reading accuracy">{d.validation.ocr.meanConfidence}% average</Row>}
              <Row label="Pages">{d.pageCount ?? "–"}</Row>
              <Row label="Question and answer exchanges">{d.stored.exchanges ? d.stored.exchanges.toLocaleString() : "–"}</Row>
              <Row label="Added">{formatDate(d.createdAt)}</Row>
            </dl>
          </Card>

          <Card>
            <CardHeader title="Analyses" count={analyses.length} />
            {analyses.length === 0 ? (
              <p className="px-5 py-4 text-sm text-muted">Not checked yet. Open the case and select this session with another of the same witness.</p>
            ) : (
              <ul className="divide-y divide-rule">
                {analyses.map((a) => {
                  const other = a.depositions.find((x) => x.id !== id);
                  return (
                    <li key={a.id}>
                      <a href={href.analysis(a.id)} className="flex items-center justify-between gap-3 px-5 py-3 text-sm hover:bg-hover">
                        <span className="min-w-0">
                          <span className="block font-medium">Against {formatDate(other?.takenOn ?? null)}</span>
                          <span className="block text-xs text-muted">{a.status === "completed" ? `${a.findings.groups.contradictions} potential contradictions · ${a.findings.groups.needs_context} need context` : ANALYSIS_STATUS[a.status].label}</span>
                        </span>
                        {isActive(a.status) && <Badge tone="active" dot>Checking</Badge>}
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {moving && <MoveDialog d={d} mode={moving} onClose={() => setMoving(null)} />}

      <DangerZone
        what="deposition"
        name={`${d.witness.name}, ${formatDate(d.takenOn)}`}
        consequence={`Deletes this transcript${analyses.length ? `, the ${analyses.length === 1 ? "analysis" : `${analyses.length} analyses`} that compared it, and their findings, decisions and notes` : ""}. Cost records are kept.`}
        onDelete={async () => {
          await api.deleteDeposition(d.id);
          window.location.hash = kase ? href.case(kase.case.id) : href.depositions();
        }}
      />
    </>
  );
}

const saveDate = (d: DepositionView, date: string | null) => api.setDepositionDate(d.id, date).then((r) => r.deposition);

// At the top of the page while the date is missing, or differs from the one the transcript states: the
// fix is right there, since no check can start without it.
function DateBanner({ d, onSaved, onEnter }: { d: DepositionView; onSaved: (d: DepositionView) => void; onEnter: () => void }) {
  const [problem, setProblem] = useState<string | null>(null);
  const found = d.dateFound;
  if (!dateAction(d)) return null;
  const where = found ? `page ${found.ref.split(":")[0]}, line ${found.ref.split(":")[1]}` : "";
  const use = found && <Button onClick={() => saveDate(d, found.date).then(onSaved).catch((e: Error) => setProblem(e.message))}>Use {formatDate(found.date)}</Button>;
  return (
    <Alert
      tone="warn"
      title={d.takenOn ? "The transcript gives a different date" : "Add the date this session was taken"}
      action={<div className="flex flex-wrap gap-2">{use}{d.takenOn && <Button variant="secondary" onClick={() => saveDate(d, d.takenOn).then(onSaved).catch((e: Error) => setProblem(e.message))}>Keep {formatDate(d.takenOn)}</Button>}<Button variant="secondary" onClick={onEnter}><Pencil aria-hidden className="size-4" />{d.takenOn ? "Edit date" : "Enter the date"}</Button></div>}
    >
      {d.takenOn
        ? `You entered ${formatDate(d.takenOn)}; the transcript's cover says ${formatDate(found!.date)} (${where}). The dates decide which testimony came first.`
        : found
          ? `The transcript's cover says ${formatDate(found.date)} (${where}). Confirm it, or enter the right date. A check can't start without it.`
          : "Veridict didn't find a date on the transcript's cover. Enter it: the dates decide which testimony came first, and a check can't start without them."}
      {problem && <span className="mt-1 block text-conflict">{problem}</span>}
    </Alert>
  );
}

// The date taken, edited in place from the Details card (or from the banner above).
function DateRow({ d, onSaved, editing, setEditing }: { d: DepositionView; onSaved: (d: DepositionView) => void; editing: boolean; setEditing: (on: boolean) => void }) {
  const [value, setValue] = useState(d.takenOn ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => { if (editing) setValue(d.takenOn ?? d.dateFound?.date ?? ""); }, [editing, d.takenOn, d.dateFound]);
  const save = (date: string) => saveDate(d, date).then((r) => { onSaved(r); setEditing(false); setProblem(null); }).catch((e: Error) => setProblem(e.message));
  return (
    <div id="date-taken" className="scroll-mt-24 px-5 py-2.5">
      <div className="flex items-center justify-between gap-4">
        <dt className="text-muted">Date taken</dt>
        <dd className="flex items-center gap-2 text-right tabular-nums">
          {d.takenOn ? formatDate(d.takenOn) : <Badge tone="warn" dot>Needed</Badge>}
          {!editing && <Button variant="secondary" className="h-7! px-2.5! text-xs!" onClick={() => setEditing(true)}><Pencil aria-hidden className="size-3.5" />{d.takenOn ? "Edit" : "Add"}</Button>}
        </dd>
      </div>
      {editing && (
        <form onSubmit={(e) => { e.preventDefault(); if (value) void save(value); }} className="mt-2.5 flex flex-wrap items-center justify-end gap-2">
          <DateInput value={value} onChange={setValue} />
          <Button type="submit" disabled={!value}>Save</Button>
          <Button variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>
        </form>
      )}
      {problem && <p className="mt-1.5 text-xs text-conflict">{problem}</p>}
    </div>
  );
}

// File the deposition under another witness or case. Every stored line carries its witness, so the
// file is read again there, and the checks that compared it go: the dialog says so before anything moves.
const ChangeButton = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <Button variant="secondary" className="h-7! flex-none px-2.5! text-xs!" aria-label={label} onClick={onClick}><Pencil aria-hidden className="size-3.5" />Change</Button>
);

function MoveDialog({ d, mode, onClose }: { d: DepositionView; mode: "witness" | "case"; onClose: () => void }) {
  const [cases, setCases] = useState<CaseSummary[] | null>(null);
  const [caseId, setCaseId] = useState(String(d.caseId));
  const [witnesses, setWitnesses] = useState<string[]>([]);
  const [witness, setWitness] = useState(d.witness.name);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    api.cases().then((r) => setCases(r.cases)).catch((e: Error) => setProblem(e.message));
  }, []);
  useEffect(() => {
    api.case(Number(caseId)).then((c) => setWitnesses(c.witnesses.map((w) => w.name))).catch(() => setWitnesses([]));
  }, [caseId]);
  const unchanged = Number(caseId) === d.caseId && witness.trim() === d.witness.name;
  const move = async (e: FormEvent) => {
    e.preventDefault();
    if (unchanged || !witness.trim()) return;
    setBusy(true);
    try {
      const { deposition } = await api.moveDeposition(d.id, Number(caseId), witness.trim());
      onClose();
      window.location.hash = href.deposition(deposition.id);
    } catch (err) {
      setProblem((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title={mode === "witness" ? "Change witness" : "Change case"} description={mode === "witness" ? "For when this session was filed under the wrong witness." : "For when this session was added to the wrong case."} size="md">
      <form onSubmit={move} className="space-y-4 px-6 py-5">
        {mode === "case" && (
          <Field label="Case" htmlFor="move-case">
            <select id="move-case" autoFocus className={cx(selectClass, "w-full")} value={caseId} onChange={(e) => setCaseId(e.target.value)} disabled={!cases || busy}>
              {!cases && <option value={d.caseId}>Loading cases…</option>}
              {cases?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        )}
        <Field label={mode === "witness" ? "Witness" : "Witness in that case"} htmlFor="move-witness" hint={mode === "witness" ? "Pick another witness in this case or type a new name." : "The same name is kept; change it if the witness is named differently in that case."}>
          <input id="move-witness" autoFocus={mode === "witness"} className={inputClass} list="move-witnesses" value={witness} onChange={(e) => setWitness(e.target.value)} maxLength={200} disabled={busy} />
          <datalist id="move-witnesses">{witnesses.map((w) => <option key={w} value={w} />)}</datalist>
        </Field>
        <Alert tone="info">
          Veridict reads the file again under the new {Number(caseId) === d.caseId ? "witness" : "case"}; the date and the original file are kept.
          {d.checks > 0 && ` The ${d.checks === 1 ? "check" : `${d.checks} checks`} that compared this session, with their findings and decisions, will be deleted.`}
        </Alert>
        {problem && <Alert>{problem}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={unchanged || !witness.trim() || busy}>{busy ? "Saving…" : mode === "witness" ? "Change witness" : "Move to this case"}</Button>
        </div>
      </form>
    </Dialog>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-2.5">
      <dt className="flex-none text-muted">{label}</dt>
      <dd className="min-w-0 text-right tabular-nums">{children}</dd>
    </div>
  );
}

function SearchBox({ initial, onSearch }: { initial: string; onSearch: (q: string) => void }) {
  const [value, setValue] = useState(initial);
  useEffect(() => setValue(initial), [initial]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSearch(value.trim());
  };
  return (
    <form onSubmit={submit} role="search" className="flex min-w-0 flex-1 basis-72 gap-2">
      <input type="search" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Search this transcript" placeholder="Search this transcript" className={cx(fieldClass, "h-8 w-full max-w-sm")} />
      <Button type="submit" variant="secondary">Search</Button>
    </form>
  );
}

function Highlight({ text, term }: { text: string; term: string }) {
  const i = text.toLowerCase().indexOf(term.toLowerCase());
  if (i < 0 || !term) return <>{text}</>;
  return <>{text.slice(0, i)}<mark className="bg-mark text-ink">{text.slice(i, i + term.length)}</mark>{text.slice(i + term.length)}</>;
}

// While a deposition is being read: the time so far, a moving bar, and what happens next.
function Reading({ since, scanned }: { since: string; scanned: boolean }) {
  const now = useNow(true);
  const s = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1000));
  return (
    <section className="overflow-hidden rounded-lg border border-line bg-sheet" aria-live="polite">
      <div aria-hidden className="h-1 overflow-hidden bg-rule"><div className="progress-sweep h-full w-1/3 bg-slate" /></div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div>
          <p className="font-semibold">Reading this deposition</p>
          <p className="mt-0.5 text-sm text-muted">{scanned ? "Turning every page into numbered lines. Scanned pages are read from their images, which can take a few minutes for a long transcript." : "Turning the text into numbered lines. This takes a few seconds."} You can leave this page; it keeps going.</p>
        </div>
        <span className="font-mono text-[15px] tabular-nums">{s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`}</span>
      </div>
    </section>
  );
}
