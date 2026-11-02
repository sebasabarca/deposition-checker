// One deposition: read it page by page as the transcript, search it, and see where it was checked.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import { TranscriptRows } from "../components/FindingView";
import { Alert, Badge, Button, buttonClass, Card, CardHeader, cx, fieldClass, Loading, PageHeader } from "../components/ui";
import { api } from "../lib/api";
import { isActive } from "../lib/insights";
import { ANALYSIS_STATUS, DEPOSITION_STATUS, formatDate } from "../lib/labels";
import { href, usePoll } from "../lib/router";
import type { AnalysisView, CaseDetail, DepositionLines, DepositionView } from "../types";

export function DepositionPage({ id, page, q }: { id: number; page: number | null; q: string }) {
  const [d, setD] = useState<DepositionView | null>(null);
  const [kase, setKase] = useState<CaseDetail | null>(null);
  const [analyses, setAnalyses] = useState<AnalysisView[]>([]);
  const [text, setText] = useState<DepositionLines | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  if (error) return <Alert title="This deposition couldn't be loaded">{error}</Alert>;
  if (!d) return <Loading />;
  const s = DEPOSITION_STATUS[d.status];
  const at = text?.page ?? null;
  const pageIndex = at === null ? -1 : (text?.pages.indexOf(at) ?? -1);
  const go = (p: number | null, query = q) => (window.location.hash = href.deposition(id, { page: p, q: query }));
  const hitLines = new Set(text?.hits.map((h) => h.id));
  const isText = /\.txt$/i.test(d.originalFilename ?? "");

  return (
    <>
      <PageHeader
        above={kase && <a href={href.case(kase.case.id)} className="mb-1 inline-block text-sm text-muted hover:text-ink">{kase.case.name}</a>}
        title={<>{d.witness.name}<span className="font-normal text-muted">, {formatDate(d.takenOn)}</span></>}
        description={[d.originalFilename ?? `Deposition #${d.id}`, d.pageCount && d.validation?.layout !== "text-unnumbered-v1" ? `${d.pageCount} ${d.pageCount === 1 ? "page" : "pages"}` : null, d.stored.lines ? `${d.stored.lines.toLocaleString()} lines` : null].filter(Boolean).join(" · ")}
        actions={<a href={api.depositionOriginal(d.id)} target="_blank" rel="noreferrer" className={buttonClass("secondary")}><ExternalLink aria-hidden className="size-3.5" />View original {isText ? "text" : "PDF"}</a>}
      />
      {d.status === "processing" && <Alert tone="info" title="Reading this deposition">Veridict is turning it into page and line references. Text takes a few seconds, scans can take several minutes. This page updates by itself.</Alert>}
      {(d.status === "failed" || d.status === "unsupported") && <Alert title={s.label} action={d.status === "failed" ? <Button variant="secondary" onClick={() => api.retryDeposition(d.id).then(load).catch((e: Error) => setError(e.message))}>Try again</Button> : undefined}>{d.error ?? "This file's layout isn't recognized."}</Alert>}
      {d.status === "needs_review" && <Alert tone="warn" title="Some pages couldn't be read">{d.error ?? "The pages that were read are shown below."}</Alert>}

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
                <TranscriptRows lines={text.lines.map((l) => ({ id: l.id, ref: String(l.lineNo), text: l.text, ocrConfidence: l.ocrConfidence, highlighted: hitLines.has(l.id) }))} />
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
              <Row label="Case">{kase ? <a href={href.case(kase.case.id)} className="font-medium hover:underline">{kase.case.name}</a> : "–"}</Row>
              <Row label="Source">{isText ? "Text" : d.validation?.ocr ? "Scanned PDF, read by OCR" : "PDF"}</Row>
              {d.validation?.ocr?.meanConfidence != null && <Row label="OCR confidence">{d.validation.ocr.meanConfidence}% average</Row>}
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
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-2.5">
      <dt className="text-muted">{label}</dt>
      <dd className="text-right tabular-nums">{children}</dd>
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
