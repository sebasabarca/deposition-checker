// A case's report: the findings the reviewer kept, as a document to print or save as PDF. Each one
// carries its citation, the cited testimony verbatim, Veridict's analysis (labelled), and the
// reviewer's note. A finding checked more than once appears once, from its latest analysis.

import { useEffect, useMemo, useState } from "react";
import { Printer } from "lucide-react";
import { TranscriptRows } from "../components/FindingView";
import { Mark } from "../components/Shell";
import { Alert, Button, cx, Loading } from "../components/ui";
import { api } from "../lib/api";
import { displayRef, pinpointCitation } from "../lib/insights";
import { findingHeadline, formatDate } from "../lib/labels";
import { decisionOf, REVIEW_LABEL } from "../lib/review";
import { href } from "../lib/router";
import type { CaseDetail, FindingDetail, FindingSummary } from "../types";

type Entry = { summary: FindingSummary; detail: FindingDetail };

export function ReportPage({ id }: { id: number }) {
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [summaries, setSummaries] = useState<FindingSummary[] | null>(null);
  const [entries, setEntries] = useState<Map<number, FindingDetail>>(new Map());
  const [withContext, setWithContext] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.case(id).then(async (d) => {
      setDetail(d);
      const done = d.analyses.filter((a) => a.status === "completed").sort((a, b) => b.id - a.id);
      const all = (await Promise.all(done.map((a) => api.findings(a.id)))).flatMap((g) => g.groups.flatMap((x) => x.findings));
      // Newest analysis first, so the first copy of a re-checked finding is its latest.
      const seen = new Set<string>();
      setSummaries(all.filter((f) => {
        const key = f.direct?.evidenceKey ?? `id:${f.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }));
    }).catch((e: Error) => setError(e.message));
  }, [id]);

  const chosen = useMemo(() => (summaries ?? []).filter((f) => decisionOf(f.reviewState) === "confirmed" || (withContext && decisionOf(f.reviewState) === "needs_context")), [summaries, withContext]);
  useEffect(() => {
    const missing = chosen.filter((f) => !entries.has(f.id));
    if (missing.length === 0) return;
    Promise.all(missing.map((f) => api.finding(f.id).then((r) => r.finding)))
      .then((found) => setEntries((m) => new Map([...m, ...found.map((f) => [f.id, f] as const)])))
      .catch((e: Error) => setError(e.message));
  }, [chosen, entries]);

  if (error) return <Alert title="This report couldn't be prepared">{error}</Alert>;
  if (!detail || !summaries) return <Loading />;
  const ready: Entry[] = chosen.flatMap((s) => (entries.has(s.id) ? [{ summary: s, detail: entries.get(s.id)! }] : []));
  const loading = ready.length < chosen.length;
  const kept = summaries.filter((f) => decisionOf(f.reviewState) === "confirmed").length;
  const context = summaries.filter((f) => decisionOf(f.reviewState) === "needs_context").length;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <a href={href.case(id)} className="text-sm text-muted hover:text-ink">{detail.case.name}</a>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={withContext} onChange={(e) => setWithContext(e.target.checked)} className="size-4 accent-navy" />
            Include findings marked Needs context ({context})
          </label>
          <Button onClick={() => window.print()} disabled={loading || ready.length === 0}><Printer aria-hidden className="size-4" />Print or save as PDF</Button>
        </div>
      </div>

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
            <Meta label="Witnesses">{detail.witnesses.map((w) => w.name).join(", ") || "–"}</Meta>
            <Meta label="Kept">{kept}</Meta>
            <Meta label="Needs context">{withContext ? context : `${context} (not included)`}</Meta>
          </dl>
        </header>

        <p className="mt-6 text-sm leading-6 text-muted">Each finding below is a lead for review, not a conclusion that the witness testified falsely. Testimony is quoted verbatim from the stored transcript at the cited page and line. The explanations were written by Veridict's analysis, an AI system, and are labelled as such. Decisions and notes are the reviewer's.</p>

        {chosen.length === 0 ? (
          <p className="mt-10 rounded-md border border-dashed border-control px-6 py-10 text-center text-sm text-muted print:hidden">No findings are marked Keep yet. Open an analysis and choose <strong>Keep</strong> on the findings to include them here.</p>
        ) : loading ? (
          <div className="mt-8"><Loading rows={3} label="Preparing the report" /></div>
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
      <p className="text-xs text-faint">{label} · {formatDate(s.deposition.takenOn)} · <span className="font-mono">{displayRef(s.range) ?? "no reference"}</span></p>
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
        {side("Earlier session", f.a)}
        {side("Later session", f.b)}
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
