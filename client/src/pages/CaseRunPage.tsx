// One whole-case run: what it covered, and its findings by lane, each as the two passages of stored testimony
// at page:line side by side. Code's checks and the model's reading are labelled as what they are; a test-model
// run says so on every finding. Unread pairs are counted in the coverage, never listed as cleared.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import { OPTIONS } from "../components/FindingPanel";
import { StandingNotice } from "../components/FindingRegister";
import { TranscriptRows } from "../components/FindingView";
import { Alert, Badge, Breadcrumbs, Button, buttonClass, Card, cx, fieldClass, Loading, ModelMark, PageHeader, Tabs, TestimonyMark, VerifiedMark } from "../components/ui";
import { api } from "../lib/api";
import { COVERAGE, isTestRun, laneOf, LANES, MOVING_RUN, RUN_STATUS, type Lane } from "../lib/caseRuns";
import { displayRef } from "../lib/insights";
import { CLASSIFICATION, formatDate, formatUsd, PRIORITY } from "../lib/labels";
import { decisionOf, REVIEW_LABEL, reviewFailure, reviewLock, shownDecision, type ShownDecision } from "../lib/review";
import { href, usePoll } from "../lib/router";
import type { CaseRun, CaseRunFinding, CaseRunSide, ReviewDecision } from "../types";

const PAGE = 25;
// Which findings the list shows, by the person's decision. "todo" is every current finding not yet decided.
type Filter = "all" | "todo" | ReviewDecision;
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "todo", label: "To decide" },
  { id: "confirmed", label: "Kept" },
  { id: "needs_context", label: "Needs context" },
  { id: "dismissed", label: "Dismissed" },
];
const inFilter = (filter: Filter, d: ShownDecision) => filter === "all" || (filter === "todo" ? d === "unreviewed" : d === filter);

export function CaseRunPage({ id }: { id: number }) {
  const [run, setRun] = useState<CaseRun | null>(null);
  const [caseName, setCaseName] = useState<string | null>(null);
  const [findings, setFindings] = useState<CaseRunFinding[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lane, setLane] = useState<Lane>("contradictions");
  const [shown, setShown] = useState(PAGE);
  const [filter, setFilter] = useState<Filter>("all");
  const load = useCallback(() => {
    api.caseRun(id)
      .then(async ({ caseRun }) => {
        setRun(caseRun);
        setCaseName((await api.case(caseRun.caseId)).case.name);
        setFindings((await api.caseRunFindings(id)).findings);
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  usePoll(!!run && MOVING_RUN.includes(run.status), 5000, load);
  const byLane = useMemo(() => {
    const m = new Map<Lane, CaseRunFinding[]>(LANES.map((l) => [l.id, []]));
    for (const f of findings ?? []) m.get(laneOf(f))!.push(f);
    return m;
  }, [findings]);

  if (error) return <Alert title="This whole-case analysis couldn't be loaded">{error}</Alert>;
  if (!run || !findings) return <Loading />;
  const test = isTestRun(run);
  const reused = run.cost.reuse?.requests ?? run.requests.reused ?? 0;
  const s = RUN_STATUS[run.status];
  const c = COVERAGE[run.coverageState];
  const inLane = byLane.get(lane)!;
  const list = inLane.filter((f) => inFilter(filter, shownDecision(f)));
  const reviewable = inLane.filter((f) => shownDecision(f) !== "quarantined");
  const decided = reviewable.filter((f) => shownDecision(f) !== "unreviewed").length;
  // A decision saved on a row: kept in the list, so the counts update without reloading the run.
  const onDecided = (id: number, review: Pick<CaseRunFinding, "reviewState" | "reviewNote" | "reviewedAt">) => setFindings((fs) => fs && fs.map((f) => (f.id === id ? { ...f, ...review } : f)));

  return (
    <>
      <PageHeader
        above={<Breadcrumbs items={[{ label: "Cases", href: href.cases() }, { label: caseName ?? "Case", href: href.case(run.caseId) }]} />}
        title={run.name ?? "Whole-case analysis"}
        actions={<ReportDownload runId={run.id} findings={findings} />}
        description={`Started ${formatDate(run.createdAt)} · ${run.candidates.sameWitness.toLocaleString()} same-witness and ${run.candidates.crossWitness.toLocaleString()} cross-witness candidate pairs`}
      />

      {test && (
        <Alert tone="info" title="Test model results">
          This run used the deterministic test model, a stand-in that exercises the pipeline at no cost. Its classifications are not an analysis of the testimony: use them to see how findings are shown, not to rely on them. The passages themselves are the real stored transcript lines.
        </Alert>
      )}

      <Card>
        <dl className="grid grid-cols-2 sm:grid-cols-4 sm:divide-x sm:divide-rule">
          <div className="px-5 py-4"><dt className="text-xs text-faint">Status</dt><dd className="mt-1"><Badge tone={s.tone} dot>{s.label}</Badge></dd></div>
          <div className="px-5 py-4"><dt className="text-xs text-faint">Coverage</dt><dd className="mt-1"><Badge tone={c.tone} dot>{c.label}</Badge></dd></div>
          <div className="px-5 py-4"><dt className="text-xs text-faint">Candidate pairs with a verdict</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{run.candidates.adjudicated.toLocaleString()} <span className="text-sm font-normal text-faint">of {run.candidates.total.toLocaleString()}</span></dd></div>
          <div className="px-5 py-4">
            <dt className="text-xs text-faint">Cost</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums">{test ? "$0" : formatUsd(run.cost.costUsd)}{!test && run.cost.budget && <span className="text-sm font-normal text-faint"> of {formatUsd(run.cost.budget.limitUsd)}</span>}</dd>
            {!test && reused > 0 && (
              <dd className="mt-1 text-xs leading-snug text-muted">
                {reused.toLocaleString()} identical {reused === 1 ? "request" : "requests"} answered from an earlier run of this case, not charged again. About {formatUsd(run.cost.reuse?.avoidedUsdEstimate ?? 0)} saved (estimate).
              </dd>
            )}
            {!test && run.cost.reuse?.fresh && <dd className="mt-1 text-xs leading-snug text-muted">Fresh analysis: no earlier answers were reused; every request was sent and charged.</dd>}
          </div>
        </dl>
        <div className="border-t border-rule px-5 py-3 text-sm text-muted">
          {c.help}
          {run.incompleteReasons.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5">{run.incompleteReasons.map((r) => <li key={r}>{r}</li>)}</ul>
          )}
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="px-5 pt-2">
          <Tabs label="Findings by lane" value={lane} onChange={(l) => { setLane(l); setShown(PAGE); }} items={LANES.filter((l) => l.id !== "quarantined" || lane === l.id || byLane.get(l.id)!.length > 0).map((l) => ({ id: l.id, label: l.label, count: byLane.get(l.id)!.length }))} />
        </div>
        {reviewable.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-rule bg-well px-5 py-3">
            <div className="min-w-48 flex-1 basis-56">
              <p className="text-sm"><span className="font-semibold tabular-nums">{decided} of {reviewable.length}</span> <span className="text-muted">reviewed in this lane</span></p>
              <div className="mt-1.5 h-1 max-w-72 overflow-hidden rounded-full bg-rule"><div className="h-full rounded-full bg-ok transition-[width] duration-500" style={{ width: `${(decided / reviewable.length) * 100}%` }} /></div>
            </div>
            <div role="group" aria-label="Show findings" className="flex flex-wrap gap-1">
              {FILTERS.map((x) => {
                const n = inLane.filter((f) => inFilter(x.id, shownDecision(f))).length;
                return (
                  <button key={x.id} type="button" aria-pressed={filter === x.id} onClick={() => { setFilter(x.id); setShown(PAGE); }} className={cx("inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-xs font-semibold transition-colors", filter === x.id ? "bg-navy text-white" : "text-muted ring-1 ring-inset ring-line hover:bg-hover hover:text-ink")}>
                    {x.label}<span className={cx("tabular-nums", filter === x.id ? "text-navy-ink" : "text-faint")}>{n}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {list.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted">
            {findings.length === 0 ? (MOVING_RUN.includes(run.status) && run.status !== "reconciling" ? "No findings yet. This page updates as packets are read." : "This run has no findings.") : inLane.length === 0 ? "No findings in this lane." : filter === "todo" ? "Every finding in this lane has a decision." : `No findings marked ${FILTERS.find((x) => x.id === filter)!.label.toLowerCase()} in this lane.`}
          </p>
        ) : (
          <div className="divide-y divide-rule">
            {list.slice(0, shown).map((f) => <FindingRow key={f.id} f={f} test={test} onDecided={onDecided} />)}
          </div>
        )}
        {list.length > shown && (
          <div className="flex items-center justify-between gap-3 border-t border-rule px-5 py-3">
            <span className="text-sm text-muted tabular-nums">Showing {shown} of {list.length.toLocaleString()}</span>
            <Button variant="secondary" onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, list.length - shown)} more</Button>
          </div>
        )}
      </Card>
    </>
  );
}

// The report of this run: the findings kept (and, if chosen, those marked Needs context), from the decisions made
// on this page. Offered once there's something to put in it.
function ReportDownload({ runId, findings }: { runId: number; findings: CaseRunFinding[] }) {
  const [withContext, setWithContext] = useState(false);
  const kept = findings.filter((f) => shownDecision(f) === "confirmed").length;
  const context = findings.filter((f) => shownDecision(f) === "needs_context").length;
  const included = kept + (withContext ? context : 0);
  return (
    <div className="flex flex-col items-start gap-1.5 lg:items-end">
      {included > 0
        ? <a href={api.caseRunReportUrl(runId, withContext)} download className={buttonClass("primary")}><Download aria-hidden className="size-4" />Download report<span className="font-normal text-navy-ink tabular-nums">· {included} {included === 1 ? "finding" : "findings"}</span></a>
        : <Button disabled title="Mark findings Keep to include them in the report"><Download aria-hidden className="size-4" />Download report</Button>}
      {context > 0 && (
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={withContext} onChange={(e) => setWithContext(e.target.checked)} className="size-4 accent-navy" />
          Include Needs context ({context})
        </label>
      )}
      {included === 0 && <p className="text-xs text-faint">Mark findings Keep to include them.</p>}
    </div>
  );
}

// The decision's colour on the finding's left edge, so a reviewed list reads at a glance.
const EDGE: Record<ShownDecision, string> = { unreviewed: "border-l-transparent", confirmed: "border-l-ok", needs_context: "border-l-context", dismissed: "border-l-control", quarantined: "border-l-transparent" };

function FindingRow({ f, test, onDecided }: { f: CaseRunFinding; test: boolean; onDecided: (id: number, review: Pick<CaseRunFinding, "reviewState" | "reviewNote" | "reviewedAt">) => void }) {
  const explanation = (f.model.verdict as { explanation?: unknown } | null)?.explanation;
  const kind = CLASSIFICATION[f.type as keyof typeof CLASSIFICATION] ?? f.type;
  const setAside = f.standing?.state === "quarantined";
  return (
    <article className={cx("space-y-3 border-l-4 px-5 py-5", EDGE[shownDecision(f)])}>
      <header className="flex flex-wrap items-center gap-2">
        {setAside ? (
          <><h3 className="font-semibold">Needs revalidation</h3><Badge tone="neutral">Earlier verdict: {kind}</Badge></>
        ) : (
          <><h3 className="font-semibold">{kind}</h3><Badge tone="neutral">{PRIORITY[f.priority as keyof typeof PRIORITY] ?? f.priority}</Badge></>
        )}
        <Badge tone="neutral">{f.crossWitness ? "Across witnesses" : "Same witness"}</Badge>
        {f.score !== null && !setAside && <span className="text-sm text-muted tabular-nums">Evidence strength {f.score}/100</span>}
      </header>
      <StandingNotice standing={f.standing} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Side side={f.a} cited={f.verification.a.lineIds} status={f.verification.a.status} />
        <Side side={f.b} cited={f.verification.b.lineIds} status={f.verification.b.status} />
      </div>
      {typeof explanation === "string" && (
        <div className="rounded-lg bg-well px-4 py-3 text-sm">
          <p className="mb-1.5">{test ? <Badge tone="accent">Test model output, not an analysis</Badge> : <ModelMark>Veridict's model's reading</ModelMark>}</p>
          <p className="max-w-[75ch]">{explanation}</p>
          {f.safeguards.length > 0 && f.model.outcome && <p className="mt-2 max-w-[75ch] text-muted">Veridict's model called this {/^[aeiou]/.test(f.model.outcome) ? "an" : "a"} {f.model.outcome.replace(/_/g, " ")} contradiction. A code check moved it to Needs context: {f.safeguards.map((g) => `${g.side ? `side ${g.side.toUpperCase()}: ` : ""}${g.detail}`).join("; ")}.</p>}
        </div>
      )}
      <DecisionBar f={f} onDecided={onDecided} />
    </article>
  );
}

// The person's decision on one finding: Keep, Needs context or Dismiss, each saved at once, with an optional note
// for the file (saved with the decision, and again when edited). A set-aside finding can't be decided.
function DecisionBar({ f, onDecided }: { f: CaseRunFinding; onDecided: (id: number, review: Pick<CaseRunFinding, "reviewState" | "reviewNote" | "reviewedAt">) => void }) {
  const state = decisionOf(f.reviewState);
  const [note, setNote] = useState(f.reviewNote ?? "");
  const [noteOpen, setNoteOpen] = useState(!!f.reviewNote);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lock, setLock] = useState(reviewLock(f));
  const noteId = `note-${f.id}`;
  const save = async (decision: ReviewDecision | null) => {
    if (lock) return;
    setBusy(true);
    setError(null);
    try {
      const { review } = await api.review(f.id, decision, decision === null ? undefined : note, f.evidenceEpochs);
      onDecided(f.id, review as Pick<CaseRunFinding, "reviewState" | "reviewNote" | "reviewedAt">);
      if (decision === null) { setNote(""); setNoteOpen(false); }
    } catch (e) {
      const failure = reviewFailure(e);
      setError(failure.message);
      if (failure.locked) setLock("This finding can no longer be reviewed as it was. Reload the page to see where it stands.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 border-t border-rule pt-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div role="group" aria-label="Your decision" className="inline-flex overflow-hidden rounded-md ring-1 ring-control ring-inset">
          {OPTIONS.map((o, i) => (
            <button key={o.d} type="button" aria-pressed={!lock && state === o.d} aria-disabled={lock ? true : undefined} disabled={busy} onClick={() => void save(state === o.d ? null : o.d)} title={state === o.d ? "Click again to undo" : undefined}
              className={cx("inline-flex h-8 items-center gap-1.5 px-3 text-sm font-semibold transition-colors disabled:cursor-wait", i > 0 && "border-l border-control", lock ? "cursor-not-allowed bg-well text-faint" : state === o.d ? o.on : "bg-sheet text-ink hover:bg-hover")}>
              <o.icon aria-hidden className="size-4" strokeWidth={2} />{o.label}
            </button>
          ))}
        </div>
        {!noteOpen && !lock && <button type="button" onClick={() => setNoteOpen(true)} aria-controls={noteId} className="text-sm font-medium text-info hover:underline">Add a note</button>}
        <span className="text-sm text-muted" aria-live="polite">
          {lock ? lock : busy ? "Saving…" : state === "unreviewed" ? "Not decided" : `${REVIEW_LABEL[state]}${f.reviewedAt ? ` · ${formatDate(f.reviewedAt)}` : ""}`}
        </span>
      </div>
      {noteOpen && !lock && (
        <label className="block max-w-3xl">
          <span className="sr-only">Note for the file</span>
          <textarea id={noteId} value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => state !== "unreviewed" && note !== (f.reviewNote ?? "") && void save(state)} rows={2} maxLength={5000} autoFocus={!f.reviewNote}
            className={cx(fieldClass, "w-full py-2 text-sm leading-5")} placeholder="Note for the file: why you decided this, or what to ask the witness" />
          <span className="mt-0.5 block text-xs text-faint">{state === "unreviewed" ? "Saved with your decision." : "Saved when you click away."}</span>
        </label>
      )}
      {error && <Alert>{error}</Alert>}
    </div>
  );
}

function Side({ side, cited, status }: { side: CaseRunSide; cited: number[]; status: string | null }) {
  const lines = side.lines.map((l) => ({ id: l.id, ref: l.at, text: l.text, ocrConfidence: null, highlighted: cited.includes(l.id) }));
  const first = side.lines.find((l) => cited.includes(l.id)) ?? side.lines[0];
  const page = first ? Number(first.at.split(":")[0]) : null;
  return (
    <section className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-sheet">
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5 border-b border-rule px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs text-faint">{side.witness ?? "Witness"} · {formatDate(side.takenOn)}</p>
          <p className="mt-0.5 font-mono text-md font-bold tracking-tight">{displayRef(side.range) ?? "No page:line reference"}</p>
        </div>
        <span className="flex flex-wrap gap-1.5">
          <TestimonyMark />
          {status === "verified" ? <VerifiedMark /> : status ? <Badge tone="warn">Citation {status.replace(/_/g, " ")}</Badge> : null}
        </span>
      </header>
      <div className={cx("transcript flex-1 py-3")}>
        <TranscriptRows lines={lines} />
      </div>
      {page !== null && Number.isFinite(page) && (
        <footer className="border-t border-rule px-4 py-2 text-right text-xs">
          <a href={href.deposition(side.depositionId, { page, mark: cited.length ? `${side.lines.find((l) => cited.includes(l.id))!.at}-${[...side.lines].reverse().find((l) => cited.includes(l.id))!.at}` : undefined })} className="font-medium text-info hover:underline">Read in full</a>
        </footer>
      )}
    </section>
  );
}
