// A case's report: the findings the reviewer kept, from the analyses they choose, previewed here and
// downloaded as a PDF the server builds (server/src/api/report.ts). Each one
// carries its citation, the cited testimony verbatim, Veridict's analysis (labelled), and the
// reviewer's note. A finding checked more than once appears once, from its latest analysis.

import { useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import { TranscriptRows } from "../components/FindingView";
import { Mark } from "../components/Shell";
import { Alert, Button, buttonClass, cx, Loading } from "../components/ui";
import { api } from "../lib/api";
import { displayRef, PHYSICAL_LINE, pinpointCitation } from "../lib/insights";
import { findingHeadline, formatDate } from "../lib/labels";
import { decisionOf, isQuarantined, REVIEW_LABEL, shownDecision } from "../lib/review";
import { href } from "../lib/router";
import type { CaseDetail, FindingDetail, FindingSummary } from "../types";

type Entry = { summary: FindingSummary; detail: FindingDetail };

// The first few witnesses by name, then a count, as in the PDF (server/src/api/report.ts).
const witnessSummary = (names: string[], shown = 3) => (names.length === 0 ? "–" : names.length <= shown + 1 ? names.join(", ") : `${names.slice(0, shown).join(", ")} and ${names.length - shown} more`);

export function ReportPage({ id }: { id: number }) {
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  // Each finished analysis, newest first, with its findings.
  const [checks, setChecks] = useState<{ id: number; label: string; findings: FindingSummary[] }[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [entries, setEntries] = useState<Map<number, FindingDetail>>(new Map());
  const [withContext, setWithContext] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.case(id).then(async (d) => {
      setDetail(d);
      const done = d.analyses.filter((a) => a.status === "completed").sort((a, b) => b.id - a.id);
      const found = await Promise.all(done.map((a) => api.findings(a.id)));
      const witness = (wid: number) => d.witnesses.find((w) => w.id === wid)?.name ?? "Witness";
      const taken = (did: number) => formatDate(d.depositions.find((x) => x.id === did)?.takenOn ?? null);
      setChecks(done.map((a, i) => ({ id: a.id, label: a.kind === "cross_witness" ? `${witness(a.witnessId)}, ${taken(a.depositionA)}, and ${witness(a.witnessBId ?? 0)}, ${taken(a.depositionB)}` : `${witness(a.witnessId)}: ${taken(a.depositionA)} and ${taken(a.depositionB)}`, findings: found[i].groups.flatMap((g) => g.findings) })));
      setPicked(new Set(done.map((a) => a.id)));
    }).catch((e: Error) => setError(e.message));
  }, [id]);

  // Newest analysis first, so the first copy of a re-checked finding is its latest.
  const summaries = useMemo(() => {
    if (!checks) return null;
    const seen = new Set<string>();
    // A finding that needs revalidation never goes in a report, and never hides an older current copy of itself.
    return checks.filter((c) => picked.has(c.id)).flatMap((c) => c.findings).filter((f) => !isQuarantined(f)).filter((f) => {
      const key = f.direct?.evidenceKey ?? `id:${f.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [checks, picked]);

  const chosen = useMemo(() => (summaries ?? []).filter((f) => decisionOf(f.reviewState) === "confirmed" || (withContext && decisionOf(f.reviewState) === "needs_context")), [summaries, withContext]);
  useEffect(() => {
    const missing = chosen.filter((f) => !entries.has(f.id));
    if (missing.length === 0) return;
    Promise.all(missing.map((f) => api.finding(f.id).then((r) => r.finding)))
      .then((found) => setEntries((m) => new Map([...m, ...found.map((f) => [f.id, f] as const)])))
      .catch((e: Error) => setError(e.message));
  }, [chosen, entries]);

  if (error) return <Alert title="This report couldn't be prepared">{error}</Alert>;
  if (!detail || !checks || !summaries) return <Loading label="Loading the report" />;
  const ready: Entry[] = chosen.flatMap((s) => (entries.has(s.id) ? [{ summary: s, detail: entries.get(s.id)! }] : []));
  const loading = ready.length < chosen.length;
  const kept = summaries.filter((f) => decisionOf(f.reviewState) === "confirmed").length;
  const context = summaries.filter((f) => decisionOf(f.reviewState) === "needs_context").length;
  const keptIn = (fs: FindingSummary[]) => fs.filter((f) => shownDecision(f) === "confirmed").length;
  const toggle = (aid: number) => setPicked((s) => {
    const next = new Set(s);
    if (!next.delete(aid)) next.add(aid);
    return next;
  });
  const all = picked.size === checks.length;
  const pdf = api.reportPdf(id, all ? undefined : checks.filter((c) => picked.has(c.id)).map((c) => c.id), withContext);

  return (
    <>
      <a href={href.case(id)} className="text-sm text-muted hover:text-ink print:hidden">{detail.case.name}</a>

      <section className="rounded-lg border border-line bg-sheet print:hidden" aria-labelledby="report-scope">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-rule px-5 py-4">
          <div>
            <h2 id="report-scope" className="text-md font-semibold">Export report</h2>
            <p className="text-sm text-muted">A PDF of the findings you kept, with citations, the testimony and your notes. Choose which analyses it covers.</p>
          </div>
          {picked.size === 0 || chosen.length === 0
            ? <Button disabled><Download aria-hidden className="size-4" />Download PDF</Button>
            : <a href={pdf} download className={buttonClass("primary")}><Download aria-hidden className="size-4" />Download PDF</a>}
        </div>
        <div className="space-y-2.5 px-5 py-4 text-sm">
          {checks.length > 1 && (
            <>
              <label className="flex items-center gap-2.5 font-medium">
                <input type="checkbox" checked={all} ref={(el) => { if (el) el.indeterminate = picked.size > 0 && !all; }} onChange={() => setPicked(all ? new Set() : new Set(checks.map((c) => c.id)))} className="size-4 accent-navy" />
                All analyses ({checks.length})
              </label>
              <div className="ml-6.5 space-y-2 border-l border-rule pl-4">
                {checks.map((c) => (
                  <label key={c.id} className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
                    <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} className="size-4 accent-navy" />
                    {c.label}
                    <span className="text-faint">· {keptIn(c.findings)} kept</span>
                    <a href={href.analysis(c.id)} className="text-faint hover:text-ink hover:underline">Open</a>
                  </label>
                ))}
              </div>
            </>
          )}
          {checks.length === 1 && <p className="text-muted">Covers the one finished analysis: {checks[0].label}.</p>}
          {checks.length === 0 && <p className="text-muted">No analysis of this case has finished yet.</p>}
          <label className="flex items-center gap-2.5 pt-1">
            <input type="checkbox" checked={withContext} onChange={(e) => setWithContext(e.target.checked)} className="size-4 accent-navy" />
            Also include findings marked Needs context ({context})
          </label>
        </div>
      </section>

      <article className="mx-auto max-w-[52rem] rounded-lg border border-line bg-sheet px-10 py-12 print:max-w-none print:border-0 print:p-0">
        <header className="border-b-2 border-navy pb-6">
          <div className="flex items-center gap-2 text-navy">
            <Mark className="size-6 text-navy [&_path:last-child]:fill-slate" />
            <span className="font-serif text-lg font-semibold">Veridict</span>
          </div>
          <h1 className="mt-6 font-serif text-[30px] leading-9 font-semibold">{detail.case.name}</h1>
          <p className="mt-1 font-serif text-lg text-muted">Potential contradictions kept for follow-up</p>
          <dl className="mt-5 grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-4">
            <Meta label="Prepared">{formatDate(new Date().toISOString())}</Meta>
            <Meta label="Witnesses">{witnessSummary(detail.witnesses.map((w) => w.name))}</Meta>
            <Meta label="Kept">{kept}</Meta>
            <Meta label="Needs context">{withContext ? context : `${context} (not included)`}</Meta>
          </dl>
        </header>

        <p className="mt-6 text-sm leading-6 text-muted">Each finding below is a lead for review, not a conclusion that the witness testified falsely. Testimony is quoted verbatim from the stored transcript at the cited page and line. The explanations were written by Veridict's analysis, an AI system, and are labelled as such. Decisions and notes are the reviewer's.</p>

        {chosen.length === 0 ? (
          <p className="mt-10 rounded-md border border-dashed border-control px-6 py-10 text-center text-sm text-muted print:hidden">{picked.size === 0 && checks.length > 0 ? "Choose at least one analysis above." : <>No findings are marked Keep in {picked.size === 1 ? "this analysis" : "these analyses"} yet. Open an analysis and choose <strong>Keep</strong> on the findings to include them here.</>}</p>
        ) : loading ? (
          <div className="mt-8"><Loading inline label="Preparing the report" /></div>
        ) : (
          <ol className="mt-4">{ready.map((e, i) => <Item key={e.summary.id} n={i + 1} e={e} />)}</ol>
        )}

        <footer className="mt-12 border-t border-line pt-4 text-xs text-faint">
          Prepared with Veridict on {formatDate(new Date().toISOString())}. Verify every citation against the certified transcript before relying on it.
        </footer>
      </article>
    </>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-faint">{label}</dt>
      <dd className="font-medium tabular-nums">{children}</dd>
    </div>
  );
}

function Item({ n, e }: { n: number; e: Entry }) {
  const f = e.detail;
  const decision = decisionOf(f.reviewState);
  const side = (label: string, s: FindingDetail["a"]) => (
    <div className="min-w-0 break-inside-avoid">
      <p className="text-xs text-faint">{label} · {formatDate(s.deposition.takenOn)} · <span className="font-mono">{displayRef(s.range) ?? "no reference"}</span>{s.deposition.physicalLines && ` · ${PHYSICAL_LINE}`}</p>
      <div className="transcript mt-1.5 rounded-md border border-line py-2 text-[13px] leading-[22px]">
        <TranscriptRows lines={s.lines.filter((l) => l.highlighted).length ? s.lines.filter((l) => l.highlighted) : s.lines} />
      </div>
    </div>
  );
  return (
    <li className="border-b border-rule py-8 last:border-b-0">
      <div className="flex items-baseline gap-3 break-after-avoid">
        <span className="font-serif text-lg text-faint tabular-nums">{n}.</span>
        <div className="min-w-0 flex-1">
          <h2 className="font-serif text-xl leading-7 font-semibold">{f.direct?.sharedSubject ?? findingHeadline(f)}</h2>
          <p className="mt-1 text-sm text-muted">{findingHeadline(f)} · {f.a.deposition.witness} · <span className={cx(decision === "confirmed" ? "text-ok" : "text-context", "font-medium")}>{REVIEW_LABEL[decision]}</span>{f.reviewedAt ? `, ${formatDate(f.reviewedAt)}` : ""}</p>
        </div>
      </div>
      <p className="mt-3 font-mono text-[13px] leading-5 break-words">{pinpointCitation(f.a, f.b)}</p>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 print:grid-cols-2">
        {/* A whole-case finding keeps its sides in retrieval order: the earlier session first. */}
        {side("Earlier session", (f.b.deposition.takenOn ?? "") < (f.a.deposition.takenOn ?? "") ? f.b : f.a)}
        {side("Later session", (f.b.deposition.takenOn ?? "") < (f.a.deposition.takenOn ?? "") ? f.a : f.b)}
      </div>
      <div className="mt-4 space-y-3 text-sm leading-6">
        <div>
          <p className="text-xs font-semibold text-faint">Why the statements may conflict (Veridict's analysis)</p>
          <p>{f.assessment.explanation}</p>
        </div>
        {f.assessment.alternativeExplanation && (
          <div>
            <p className="text-xs font-semibold text-faint">The innocent explanation (Veridict's analysis)</p>
            <p>{f.assessment.alternativeExplanation}</p>
          </div>
        )}
        {f.reviewNote && (
          <div className="break-inside-avoid rounded-md bg-well px-4 py-3">
            <p className="text-xs font-semibold text-faint">Reviewer's note</p>
            <p className="whitespace-pre-wrap">{f.reviewNote}</p>
          </div>
        )}
      </div>
    </li>
  );
}
