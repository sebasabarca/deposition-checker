// A case's stored whole-case analysis, laid out like an analysis of two sessions: a register of findings
// by category with Previous/Next, then one finding at a time with its two passages side by side. The
// passages are the stored transcript lines the server resolved each citation to; one that didn't resolve
// is shown as unverified, never hidden. The analysis is a hand-authored example, and the page says so.

import { useEffect, useState } from "react";
import { ArrowRight, CircleAlert, CircleCheck, CircleHelp, Download, X } from "lucide-react";
import { TranscriptRows } from "../components/FindingView";
import { FindingSteps } from "../components/FindingRegister";
import { Alert, Badge, Breadcrumbs, buttonClass, Card, CardHeader, cx, fieldClass, HumanMark, Loading, PageHeader, Tabs, tdClass, thClass, VerifiedMark } from "../components/ui";
import { useCaseDecisions, type CaseDecision } from "../lib/caseDecisions";
import { REVIEW_LABEL } from "../lib/review";
import { api } from "../lib/api";
import { displayRef } from "../lib/insights";
import { formatDate, formatUsd } from "../lib/labels";
import { href } from "../lib/router";
import type { CaseAnalysisCitation, CaseAnalysisView, ReviewDecision } from "../types";

type Kind = CaseAnalysisView["findings"][number]["classification"];
const KINDS: Kind[] = ["incompatible", "uncertain", "compatible"];
const KIND: Record<Kind, { tab: string; headline: string; tone: "contradiction" | "warn" | "compatible"; why: string }> = {
  incompatible: { tab: "Incompatible", headline: "Incompatible statements", tone: "contradiction", why: "Why the statements may conflict" },
  uncertain: { tab: "Uncertain", headline: "Uncertain: needs context", tone: "warn", why: "Why this needs context" },
  compatible: { tab: "Compatible", headline: "Likely compatible", tone: "compatible", why: "Why they may be compatible" },
};
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 } as const;
const RELATIONSHIP = { within_witness: "Same witness", cross_witness: "Across witnesses" } as const;

export function CaseAnalysisPage({ id }: { id: number }) {
  const [name, setName] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<CaseAnalysisView | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>("incompatible");
  const [at, setAt] = useState(0);
  const { decisions, decide } = useCaseDecisions(id);
  const [downloading, setDownloading] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  useEffect(() => {
    api.case(id).then((d) => setName(d.case.name)).catch(() => undefined);
    api.caseAnalysis(id).then((r) => setAnalysis(r.analysis)).catch((e: Error) => setError(e.message));
  }, [id]);

  if (error) return <Alert title="The case analysis couldn't be loaded">{error}</Alert>;
  if (analysis === undefined) return <Loading />;
  const crumbs = [{ label: "Cases", href: href.cases() }, ...(name ? [{ label: name, href: href.case(id) }] : [])];
  if (analysis === null) return (<><PageHeader above={<Breadcrumbs items={crumbs} />} title="Whole case" /><Alert tone="info">This case has no whole-case analysis.</Alert></>);

  const c = analysis.coverage;
  const list = analysis.findings.filter((f) => f.classification === kind).sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.id.localeCompare(b.id));
  const i = Math.min(at, list.length - 1);
  const f = list[i];
  const pick = (k: Kind) => { setKind(k); setAt(0); };
  const decided = analysis.findings.filter((x) => decisions[x.id]).length;
  // The PDF the server builds from the stored lines, saved as a file (as the analysis report is).
  const download = async () => {
    setDownloading(true);
    setReportError(null);
    try {
      const blob = await api.caseAnalysisReport(id, Object.entries(decisions).map(([fid, d]) => ({ id: fid, ...d })));
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement("a"), { href: url, download: `Veridict report - ${name ?? "case"} - whole case.pdf` });
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setReportError((e as Error).message);
    } finally {
      setDownloading(false);
    }
  };
  return (
    <>
      <PageHeader
        above={<Breadcrumbs items={crumbs} />}
        title={<>Whole case<span className="font-normal text-muted">: {c.sessions_total} sessions, {c.witnesses_total} witnesses</span></>}
        description={`${c.pairs_complete} of ${c.unique_pairs_total} session pairs compared · ${c.findings_total} findings · ${decided} decided · ${formatUsd(analysis.execution.cost_usd)}`}
        actions={<button type="button" disabled={downloading} onClick={() => void download()} className={buttonClass("secondary")} title="The findings you kept in this analysis, with citations, the stored testimony and your notes, as a PDF"><Download aria-hidden className="size-4" />{downloading ? "Preparing…" : "Download report"}</button>}
      />
      <Alert tone="info">This is an example analysis, compared by hand. Veridict's model wasn't used for it.</Alert>
      {reportError && <Alert title="The report couldn't be downloaded">{reportError}</Alert>}
      {analysis.unverified > 0 && (
        <Alert tone="warn" title={`${analysis.unverified} ${analysis.unverified === 1 ? "citation" : "citations"} not found in the stored transcript`}>Marked below. Read those passages yourself before relying on them.</Alert>
      )}

      {/* The register, as on an analysis of two sessions. */}
      <div className="sticky top-12 z-20 -mx-4 bg-canvas px-4 pt-1 pb-3 sm:-mx-8 sm:px-8 lg:top-0">
        <div className="rounded-lg border border-line bg-sheet px-4">
          <Tabs label="Finding categories" value={kind} onChange={pick} items={KINDS.map((k) => ({ id: k, label: KIND[k].tab, count: analysis.findings.filter((x) => x.classification === k).length }))} />
          {f && (
            <FindingSteps
              label={`${KIND[kind].tab}: findings`}
              heading={`Finding ${i + 1} of ${list.length}`}
              summary={f.summary}
              chips={list.map((x, n) => ({ key: x.id, current: n === i, decision: decisions[x.id]?.decision ?? "unreviewed", title: x.summary, onClick: () => setAt(n) }))}
              previous={i > 0 ? { onClick: () => setAt(i - 1) } : undefined}
              next={i < list.length - 1 ? { onClick: () => setAt(i + 1) } : undefined}
            />
          )}
        </div>
      </div>

      {f && (
        <article aria-labelledby="finding-title" className="space-y-3">
          <section className="flex flex-col gap-3 rounded-lg border border-line bg-sheet p-5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={KIND[f.classification].tone} dot>{KIND[f.classification].headline}</Badge>
              <Badge tone="neutral">{f.priority[0].toUpperCase() + f.priority.slice(1)} priority</Badge>
              <Badge tone="neutral">{RELATIONSHIP[f.relationship]}</Badge>
              {f.citations.every((x) => x.status === "verified") ? <VerifiedMark>Citations verified</VerifiedMark> : <Badge tone="bad" icon={CircleAlert}>Citation not verified</Badge>}
            </div>
            <h2 id="finding-title" className="font-serif text-xl font-semibold">{f.topic[0].toUpperCase() + f.topic.slice(1)}</h2>
          </section>
          <Alert tone="info">Demo: a prepared example assessment for synthetic testimony. Not produced by Veridict's model.</Alert>
          <div className="grid gap-3 lg:grid-cols-2">
            {/* The earlier session on the left; ties (same day) keep the given order. */}
            {[...f.citations].sort((x, y) => x.date.localeCompare(y.date)).map((cit, n) => <CitedPassage key={cit.sessionId} c={cit} label={n === 0 ? "Earlier session" : "Later session"} />)}
          </div>
          <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <section className="flex flex-col gap-3 rounded-lg border border-line bg-sheet p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-md font-semibold">{KIND[f.classification].why}</h3>
                <HumanMark>Prepared example, not Veridict's model's output</HumanMark>
              </div>
              <p className="font-serif text-[17px] leading-7">{f.summary}</p>
            </section>
            <DecisionCard key={f.id} saved={decisions[f.id]} onSave={(d, note) => decide(f.id, d, note)} onNext={i < list.length - 1 ? () => setAt(i + 1) : undefined} />
          </div>
        </article>
      )}

      <Card className="overflow-hidden">
        <CardHeader title="Sessions compared" count={analysis.pairs.length} description={c.coverage_claim} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead><tr><th className={thClass}>Sessions</th><th className={thClass}>Comparison</th><th className={thClass}>Status</th><th className={cx(thClass, "text-right")}>Findings</th></tr></thead>
            <tbody>
              {analysis.pairs.map((p) => (
                <tr key={p.pair_id} className="border-t border-rule">
                  <td className={tdClass}>{p.sessions.map((s) => `${s.witness}, ${formatDate(s.date)}`).join("  ·  ")}</td>
                  <td className={tdClass}>{RELATIONSHIP[p.relationship]}</td>
                  <td className={tdClass}><Badge tone={p.status === "complete" ? "good" : "warn"} dot>{p.status === "complete" ? "Compared" : p.status === "deferred" ? "Deferred" : "Not compared"}</Badge></td>
                  <td className={cx(tdClass, "text-right tabular-nums")}>{p.finding_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <p className="text-xs text-muted">{analysis.edits}</p>
    </>
  );
}

const OPTIONS: { d: ReviewDecision; label: string; icon: typeof X; on: string }[] = [
  { d: "confirmed", label: "Keep", icon: CircleCheck, on: "bg-ok text-white ring-ok" },
  { d: "needs_context", label: "Needs context", icon: CircleHelp, on: "bg-context text-white ring-context" },
  { d: "dismissed", label: "Dismiss", icon: X, on: "bg-muted text-white ring-muted" },
];

// The reviewer's decision and note, as on an analysis of two sessions (kept in this browser).
function DecisionCard({ saved, onSave, onNext }: { saved: CaseDecision | undefined; onSave: (d: ReviewDecision | null, note: string) => void; onNext?: () => void }) {
  const [note, setNote] = useState(saved?.note ?? "");
  const state = saved?.decision ?? "unreviewed";
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-line bg-sheet p-5">
      <h2 className="text-md font-semibold">Your decision</h2>
      <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="Decision">
        {OPTIONS.map((o) => (
          <button key={o.d} type="button" aria-pressed={state === o.d} onClick={() => onSave(o.d, note)} className={cx("flex h-14 flex-col items-center justify-center gap-1 rounded-md text-xs font-semibold ring-1 ring-inset transition-colors", state === o.d ? o.on : "bg-sheet text-ink ring-control hover:bg-hover")}>
            <o.icon aria-hidden className="size-4" strokeWidth={2} />
            {o.label}
          </button>
        ))}
      </div>
      <label className="block">
        <span className="text-xs font-semibold text-faint">Note for the file</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => state !== "unreviewed" && note !== (saved?.note ?? "") && onSave(state, note)} rows={3} maxLength={5000} placeholder="Why you decided this, or what to ask the witness" className={cx(fieldClass, "mt-1 block h-auto w-full py-2")} />
      </label>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-rule pt-3 text-sm">
        <span className="text-muted" aria-live="polite">
          {state === "unreviewed" ? "Not decided yet." : <>{REVIEW_LABEL[state]}{saved ? ` · ${formatDate(saved.at.slice(0, 10))}` : ""} · <button type="button" onClick={() => onSave(null, note)} className="font-medium text-info hover:underline">Undo</button></>}
        </span>
        {onNext && <button type="button" onClick={onNext} className="inline-flex items-center gap-1 font-semibold text-ink hover:underline">Next<ArrowRight aria-hidden className="size-4" /></button>}
      </div>
    </section>
  );
}

function CitedPassage({ c, label }: { c: CaseAnalysisCitation; label: string }) {
  const cited = c.lines.filter((l) => l.highlighted);
  const page = cited[0] ? Number(cited[0].ref.split(":")[0]) : null;
  const mark = cited.length ? `${cited[0].ref}-${cited.at(-1)!.ref}` : undefined;
  return (
    <section className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-sheet">
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5 border-b border-rule px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs text-faint">{label} · {formatDate(c.date)}</p>
          <h3 className="mt-0.5 font-mono text-md font-bold tracking-tight">{displayRef(c.range) ?? "No page:line reference"}</h3>
        </div>
        {c.status === "verified" ? <VerifiedMark /> : <Badge tone="bad" icon={CircleAlert}>Citation not verified</Badge>}
      </header>
      <div className="flex-1 py-2 font-mono text-[13px] leading-6">
        {c.status === "verified"
          ? <TranscriptRows lines={c.lines.map((l) => ({ ...l, ocrConfidence: null }))} muted />
          : <p className="px-4 py-3 font-sans text-sm text-conflict">{c.reason}. No testimony is shown for it.</p>}
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-rule px-4 py-2 text-xs text-faint">
        <span className="truncate">{c.witness}</span>
        {c.depositionId !== null && page !== null && <a href={href.deposition(c.depositionId, { page, mark })} className="flex-none font-medium text-info hover:underline">Read in full</a>}
      </footer>
    </section>
  );
}
