// The guided analysis on the case page: the whole case, or depositions the person selects, through the case-run
// API (docs/case-run-api.md). A live run first prepares the comparison and its cost estimate, sending nothing to
// a model; it spends only after a person confirms a spending limit here. A test run uses the free deterministic
// stand-in for the model and is labelled as such everywhere its results appear.

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowRight, ArrowUpRight, Check, CircleAlert, CircleCheck, FileUp, Info, LoaderCircle, RotateCcw } from "lucide-react";
import { api } from "../lib/api";
import { ACTIVE_RUN, timeLeft, budgetProblem, COVERAGE, defaultLimit, EXECUTION, isTestRun, MAX_CASE_RUN_BUDGET_USD, modeEstimate, reuseAdjusted, MOVING_RUN, RESUMABLE_RUN, RUN_STATUS, isAnalysis, isEstimate, isUnusedEstimate, runScopeKey, scopeKey, scopeProblem, workflowStep, type AnalysisScope, type WorkflowChoice, type WorkflowStep } from "../lib/caseRuns";
import { browserStore, depositionFingerprint, estimateCacheKey, loadEstimate, saveEstimate, type SavedEstimate } from "../lib/estimateCache";
import { formatDate, formatUsd, NO_ACCESS } from "../lib/labels";
import { href, usePoll } from "../lib/router";
import { useUser } from "../lib/session";
import type { CaseRun, CaseRunEstimate, CaseRunExecution, RunningAnalysis } from "../types";
import { useNow } from "../lib/useNow";
import { Alert, Badge, Button, buttonClass, Card, CardHeader, cx, Field, inputClass, Loading, type Tone } from "./ui";

export function useCaseRuns(caseId: number) {
  const [runs, setRuns] = useState<CaseRun[] | null>(null);
  const [stretchAvailable, setStretchAvailable] = useState(false);
  const [paidAvailable, setPaidAvailable] = useState(true); // the server's own report: it has an Anthropic API key (Fast and Economy)
  const [error, setError] = useState<string | null>(null);
  // An analysis running in another case of the workspace: this one can prepare an estimate but not start until it ends.
  const [runningElsewhere, setRunningElsewhere] = useState<RunningAnalysis | null>(null);
  const load = useCallback(() => {
    api.caseRuns(caseId).then((r) => { setRuns(r.caseRuns); setStretchAvailable(!!r.stretchAvailable); setPaidAvailable(r.paidAvailable !== false); setRunningElsewhere(r.runningElsewhere ?? null); setError(null); }, (e: Error) => setError(e.message));
  }, [caseId]);
  useEffect(load, [load]);
  usePoll(!!runs?.some((r) => MOVING_RUN.includes(r.status)), 3000, load); // any run: a resumed one needn't be the newest
  usePoll(!!runningElsewhere, 10_000, load); // so Start comes back once the other analysis ends
  return { runs, stretchAvailable, paidAvailable, runningElsewhere, error, reload: load };
}
export type CaseRunsState = ReturnType<typeof useCaseRuns>;

// Why a run can't start (or resume) now because another analysis in the workspace is running, or null.
const elsewhereText = (r: RunningAnalysis | null) => (r ? `An analysis is running in “${r.caseName}”. Veridict runs one analysis at a time, so this one can start when it finishes.` : null);

export const WHOLE_CASE_PANEL = "whole-case-analysis";

// The deposition picker and the step summaries read the case's sessions.
export type WorkflowSession = { id: number; witness: string; takenOn: string | null; label: string; status: string; fileSha256?: string };

// After the last change of choice, how long to wait before preparing an estimate: long enough for a few clicks in
// a row, short enough to feel immediate. Preparing reads the case's evidence on the worker (no model call), so
// each superseded estimate is cancelled before the next one starts.
const ESTIMATE_DELAY_MS = 900;

// The whole analysis of a case, in one place: one step open at a time, finished steps summarized in a line.
// depositions: step 1's content (the case page's sessions by witness, with dates and moves); onAdd opens the upload.
// state: the case's runs (useCaseRuns), loaded by the case page, which also needs them.
export function CaseRunPanel({ caseId, sessions, depositions, onAdd, state }: { caseId: number; sessions: WorkflowSession[]; depositions: ReactNode; onAdd: () => void; state: CaseRunsState }) {
  const { runs, stretchAvailable, paidAvailable, runningElsewhere, error, reload } = state;
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<AnalysisScope>("case");
  const [selected, setSelected] = useState<number[]>([]);
  const [stretch, setStretch] = useState(false); // Contextual Analysis (stretch-v2, experimental), offered only where the server allows it
  const [choice, setChoice] = useState<WorkflowChoice>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const user = useUser();
  const latest = runs?.[0] ?? null;
  const estimate = latest && isEstimate(latest) ? latest : null;
  // The run at work: the newest one, or an earlier one that was resumed.
  const running = runs?.find((r) => ACTIVE_RUN.includes(r.status) && !isEstimate(r)) ?? null;
  const analysis = runs?.find(isAnalysis) ?? null;
  const ready = sessions.filter((s) => s.status === "ready").length;
  // The latest analysis, finished or not, is where the page opens: its result and the way to its review.
  // An estimate waiting doesn't hide it: the steps prepare one automatically, and "Start a new analysis" opens it.
  const results = !!analysis;
  const step = workflowStep({ running: !!running, estimate: !!estimate, results }, choice, ready);
  const act = (p: Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    p.then(reload, (e: Error) => setProblem(e.message)).finally(() => setBusy(false));
  };
  const invalid = scopeProblem(scope, selected, sessions);
  const paidBlocked = !user?.emailVerified ? "Verify your email before preparing an analysis." : !user.analysisAccess ? NO_ACCESS : null;
  const elsewhere = elsewhereText(runningElsewhere);
  const contract = stretch && stretchAvailable ? ("stretch-v2" as const) : undefined;
  const desired = invalid || paidBlocked ? null : scopeKey(scope === "selected" ? selected : null, contract);
  const prepare = () => act(api.startCaseRun(caseId, "live", "standard", contract, scope === "selected" ? [...selected] : undefined));
  const witnesses = new Set(sessions.map((s) => s.witness)).size;
  // Estimates already prepared for a choice, saved in this browser (lib/estimateCache.ts): shown at once when the
  // person comes back to that choice, with no new preparation. Reviewing still needs the server's own estimate.
  const fingerprint = depositionFingerprint(sessions);
  const savedKey = desired !== null && user ? estimateCacheKey(user.id, caseId, desired, fingerprint) : null;
  const saved = savedKey ? loadEstimate(browserStore(), savedKey, Date.now()) : null;
  const hasSaved = !!saved;
  const [reviewWanted, setReviewWanted] = useState(false); // "Review and start" pressed while only a saved estimate was shown
  useEffect(() => setReviewWanted(false), [desired]);
  useEffect(() => {
    if (user && estimate?.status === "awaiting_confirmation" && estimate.estimate) saveEstimate(browserStore(), estimateCacheKey(user.id, caseId, runScopeKey(estimate), fingerprint), estimate.estimate, Date.now());
  }, [user, estimate, caseId, fingerprint]);

  // Back on the page with an estimate pending: show the choice it was prepared for.
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current || !runs) return;
    initialized.current = true;
    if (estimate?.scope?.kind === "depositions") { setScope("selected"); setSelected(estimate.scope.depositionIds); }
    if (estimate?.contract === "stretch-v2") setStretch(true);
  }, [runs, estimate]);

  // The automatic estimate, on step 2: when the choice is valid and has settled, prepare its estimate; when the choice
  // changes, cancel the estimate prepared for the old one first. An estimate the person cancelled, or one that
  // failed, is not restarted on its own.
  const replaced = useRef(new Set<number>());
  const sending = useRef(false);
  const stopped = !estimate && latest && isUnusedEstimate(latest) && !replaced.current.has(latest.id) && desired !== null && runScopeKey(latest) === desired ? latest : null;
  useEffect(() => {
    if (step !== 2 || desired === null || !runs || running || (stopped && !reviewWanted)) return;
    if (estimate && runScopeKey(estimate) === desired) {
      if (reviewWanted && estimate.status === "awaiting_confirmation") { setReviewWanted(false); setChoice("review"); }
      return;
    }
    if (hasSaved && !reviewWanted) return; // a saved estimate is shown: nothing to prepare until the person reviews
    if (estimate && estimate.cancelRequested && estimate.status !== "awaiting_confirmation") return; // still stopping; the poll comes back
    const t = setTimeout(() => {
      if (sending.current) return;
      sending.current = true;
      setProblem(null);
      if (estimate) replaced.current.add(estimate.id);
      (estimate ? api.cancelCaseRun(estimate.id) : api.startCaseRun(caseId, "live", "standard", contract, scope === "selected" ? [...selected] : undefined))
        .catch((e: Error) => setProblem(e.message))
        .finally(() => { sending.current = false; reload(); });
    }, estimate || reviewWanted ? 0 : ESTIMATE_DELAY_MS);
    return () => clearTimeout(t);
  }, [step, desired, runs, estimate, running, stopped, hasSaved, reviewWanted, caseId, contract, scope, selected, reload]);

  // A new start (Continue, Change, Start a new analysis) is a fresh request: a cancelled estimate no longer holds it back.
  const go = (c: WorkflowChoice) => { if (latest) replaced.current.add(latest.id); setChoice(c); };
  const shown = running ?? analysis;
  const steps: { title: string; summary: ReactNode; change?: () => void; content: ReactNode }[] = [
    {
      title: "Add depositions",
      summary: `${sessions.length} ${sessions.length === 1 ? "deposition" : "depositions"} from ${witnesses} ${witnesses === 1 ? "witness" : "witnesses"}, ${ready} ready`,
      change: running ? undefined : () => setChoice("depositions"),
      content: (
        <div className="space-y-4">
          <p className="max-w-3xl text-sm text-muted">Add every deposition of the case, as PDF or text, and check each session's witness and date. Testimony is compared across sessions, so at least two sessions must finish reading.</p>
          {depositions}
          <div className="flex flex-wrap items-center gap-2">
            {ready >= 2 && <Button onClick={() => go("scope")}>Continue<ArrowRight aria-hidden className="size-4" /></Button>}
            <Button variant={ready >= 2 ? "secondary" : "primary"} onClick={onAdd}><FileUp aria-hidden className="size-4" />Add deposition</Button>
            {ready < 2 && <span className="text-sm text-muted">{sessions.length - ready > 0 ? "Waiting for depositions to finish reading." : `Add ${2 - ready} more to continue.`}</span>}
          </div>
        </div>
      ),
    },
    {
      title: "Choose what to analyze",
      summary: running ? scopeText(running, sessions) : estimate ? scopeText(estimate, sessions) : scope === "case" ? "The whole case" : `${selected.length} selected depositions`,
      change: running ? undefined : () => go("scope"),
      content: (
        <div className="space-y-4">
          <fieldset>
            <legend className="sr-only">What to analyze</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              <ScopeOption name={`scope-${caseId}`} checked={scope === "case"} onChange={() => setScope("case")} title="The whole case" badge={RECOMMENDED}>
                Every session of every witness, compared within each witness and across witnesses. Start here.
              </ScopeOption>
              <ScopeOption name={`scope-${caseId}`} checked={scope === "selected"} onChange={() => setScope("selected")} title="Selected depositions">
                Only the depositions you choose, read with Veridict's model, checks and scoring.
              </ScopeOption>
            </div>
          </fieldset>
          {scope === "selected" && <SessionPicker sessions={sessions} selected={selected} onSelect={setSelected} />}
          {/* The analysis method: packet-v1 (Focused) by default; stretch-v2 (Contextual) only where ALLOW_STRETCH_V2 is set. */}
          {stretchAvailable ? (
            <fieldset aria-describedby={`method-help-${caseId}`}>
              <legend className="text-sm font-semibold">How would you like to analyze the testimony?</legend>
              <p id={`method-help-${caseId}`} className="mt-0.5 max-w-3xl text-sm text-muted">Choose how Veridict examines potential contradictions. Both methods verify supporting citations and may miss inconsistencies.</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <ScopeOption
                  name={`method-${caseId}`} checked={!stretch} onChange={() => setStretch(false)} title="Focused Analysis" badge={RECOMMENDED}
                  note="More thoroughly tested in Veridict and performed better at identifying known contradictions in our initial evaluation, but may still miss conflicts or flag statements incorrectly."
                >
                  Examines potentially conflicting statements in small, focused groups, with supporting testimony for each comparison.
                </ScopeOption>
                <ScopeOption
                  name={`method-${caseId}`} checked={stretch} onChange={() => setStretch(true)} title="Contextual Analysis"
                  note="Approximately 3× cheaper per comparison in our initial tests, but identified fewer known contradictions and produced more false positives. Best used for experimentation, not as a replacement for Focused Analysis."
                >
                  Examines longer, connected sections of testimony together to evaluate multiple potential conflicts in one AI request.
                </ScopeOption>
              </div>
              <p className="mt-2 max-w-3xl text-xs text-muted">{DISCLAIMER}</p>
            </fieldset>
          ) : (
            <p className="max-w-3xl text-xs text-muted">{DISCLAIMER}</p>
          )}
          <EstimateStrip
            invalid={invalid} paidBlocked={paidBlocked} estimate={estimate} stopped={stopped} saved={saved} reviewWanted={reviewWanted} paidAvailable={paidAvailable}
            current={!!estimate && desired !== null && runScopeKey(estimate) === desired}
            busy={busy}
            onReview={() => (estimate && desired !== null && runScopeKey(estimate) === desired && estimate.status === "awaiting_confirmation" ? setChoice("review") : setReviewWanted(true))}
            onRetry={prepare}
          />
          {/* Results that finished on this visit can be returned to; earlier ones are under Previous analyses. */}
          {results ? <Button variant="secondary" disabled={busy} onClick={() => setChoice(null)}>Back to the latest results</Button> : <Button variant="secondary" disabled={busy} onClick={() => setChoice("depositions")}>Back</Button>}
        </div>
      ),
    },
    {
      title: "Review the cost and start",
      summary: running && !isTestRun(running) && running.cost.budget ? `Spending limit ${formatUsd(running.cost.budget.limitUsd)}, ${EXECUTION[running.execution].label.toLowerCase()}` : shown && !running && step === 4 && shown.cost.budget ? `Spending limit ${formatUsd(shown.cost.budget.limitUsd)}, ${EXECUTION[shown.execution].label.toLowerCase()}` : null,
      content: estimate && (
        <div className="space-y-3">
          <RunState run={estimate} busy={busy} act={act} paidBlocked={paidBlocked} elsewhere={elsewhere} onBack={() => setChoice("scope")} />
        </div>
      ),
    },
    {
      title: "Analysis and results",
      summary: null,
      content: shown && (
        <div className="space-y-3">
          {shown.name && <p className="text-base font-semibold">{shown.name}</p>}
          <p className="text-sm"><span className="text-muted">Analyzed:</span> <span className="font-semibold">{scopeText(shown, sessions)}</span></p>
          <RunState run={shown} busy={busy} act={act} paidBlocked={paidBlocked} elsewhere={elsewhere} />
          {!running && <Button variant="secondary" onClick={() => { go("scope"); setScope("case"); }}>Start a new analysis</Button>}
        </div>
      ),
    },
  ];
  // Every analysis that ran (or is running), not estimates: the list under the steps.
  const previous = (runs ?? []).filter((r) => r !== estimate && !isUnusedEstimate(r) && (isAnalysis(r) || ACTIVE_RUN.includes(r.status)) && r.status !== "awaiting_confirmation");

  return (
    <div id={WHOLE_CASE_PANEL} tabIndex={-1} className="scroll-mt-6 rounded-lg focus:outline-2 focus:outline-offset-2 focus:outline-slate/40">
    <Card className="overflow-hidden">
      <CardHeader
        title="Analyze this case"
        description="Follow the steps in order. The cost is estimated as soon as you choose what to analyze; nothing is sent to Veridict's model and nothing is charged until you review the estimate and authorize a spending limit."
      />
      {runningElsewhere && !running && (
        <div className="px-5 pt-4">
          <Alert tone="info" title="Another analysis is running" action={<a href={runningElsewhere.caseRunId ? href.caseRun(runningElsewhere.caseRunId) : href.case(runningElsewhere.caseId)} className={buttonClass("secondary")}>Open it</a>}>
            {elsewhere} You can still choose what to analyze and see the estimate.
          </Alert>
        </div>
      )}
      {(error || problem) && (
        <div className="space-y-2 px-5 pt-4">
          {error && <Alert title="Analyses couldn't be loaded" action={<Button variant="secondary" onClick={reload}>Try again</Button>}>{error}</Alert>}
          {problem && <Alert title="That didn't work">{problem}</Alert>}
        </div>
      )}
      {!runs && !error ? <div className="px-5 py-4"><Loading inline label="Loading this case's analyses" /></div> : (
      <ol aria-label="Analysis steps" className="divide-y divide-rule">
        {steps.map((s, i) => {
          const n = (i + 1) as WorkflowStep;
          const state = n < step ? "done" : n === step ? "current" : "next";
          return (
            <li key={s.title} aria-current={state === "current" ? "step" : undefined} className={cx("flex gap-3 px-5 py-4", state === "current" && "bg-sheet")}>
              <span className={cx("mt-0.5 grid size-6 flex-none place-items-center rounded-full text-xs font-semibold tabular-nums", state === "current" ? "bg-navy text-white" : state === "done" ? "bg-ok-bg text-ok" : "bg-well text-faint")}>
                {state === "done" ? <Check aria-hidden className="size-3.5" /> : n}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <h3 className={cx("font-semibold", state === "next" && "font-medium text-faint", state === "done" && "font-medium")}>{s.title}</h3>
                  {state === "done" && s.change && <button type="button" onClick={s.change} className="text-sm font-medium text-info hover:underline">Change</button>}
                </div>
                {state === "done" && s.summary && <p className="mt-0.5 text-sm text-muted">{s.summary}</p>}
                {state === "current" && <div className="mt-3">{s.content}</div>}
              </div>
            </li>
          );
        })}
      </ol>
      )}
    </Card>
    {previous.length > 0 && <PreviousAnalyses runs={previous} sessions={sessions} resume={(r) => <ResumeControl run={r} busy={busy} act={act} paidBlocked={paidBlocked} elsewhere={elsewhere} compact />} />}
    </div>
  );
}

// The estimate for the current choice, prepared automatically: why it can't be prepared, that it is being prepared,
// or what it came to, with the way on to the review.
function EstimateStrip({ invalid, paidBlocked, estimate, stopped, saved, reviewWanted, paidAvailable, current, busy, onReview, onRetry }: { invalid: string | null; paidBlocked: string | null; estimate: CaseRun | null; stopped: CaseRun | null; saved: SavedEstimate | null; reviewWanted: boolean; paidAvailable: boolean; current: boolean; busy: boolean; onReview: () => void; onRetry: () => void }) {
  const box = (children: ReactNode) => <div aria-live="polite" className="rounded-lg bg-well px-4 py-3 text-sm">{children}</div>;
  if (invalid) return box(<p role="alert" className="text-conflict">{invalid}</p>);
  if (paidBlocked) return box(<p className="text-muted">{paidBlocked}</p>);
  const live = current && estimate?.status === "awaiting_confirmation" && estimate.estimate ? estimate.estimate : null;
  if (live) return figures(live, null);
  if (reviewWanted) return box(<p className="flex items-center gap-2 text-muted"><LoaderCircle aria-hidden className="size-4 animate-spin" />Preparing the review: a current estimate for this choice, prepared on the server. Nothing is sent to Veridict's model.</p>);
  if (saved) return figures(saved.estimate, saved.savedAt);
  if (stopped) return box(
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-muted">{stopped.status === "failed" ? `The estimate couldn't be prepared: ${stopped.error ?? "unknown error"}` : "You cancelled this estimate."}</p>
      <Button variant="secondary" disabled={busy} onClick={onRetry}>Prepare the estimate again</Button>
    </div>,
  );
  return box(
    <p className="flex items-center gap-2 text-muted"><LoaderCircle aria-hidden className="size-4 animate-spin" />{current ? "Estimating the cost: finding the candidate pairs in these depositions. Nothing is sent to Veridict's model." : "Updating the estimate for your choice…"}</p>,
  );

  // savedAt: a saved estimate from this browser (a preview; reviewing prepares a current one), or null for the server's.
  function figures(e: CaseRunEstimate, savedAt: number | null) {
    // With expected exact-request reuse (the review step can still choose a fresh analysis, charged in full).
    const fast = reuseAdjusted(e, "standard", false)!, economy = reuseAdjusted(e, "batch", false);
    const reusable = fast.reusable;
    const cost = (x: { lowUsd: number; highUsd: number }) => (x.lowUsd === x.highUsd ? formatUsd(x.lowUsd) : `${formatUsd(x.lowUsd)}–${formatUsd(x.highUsd)}`);
    return box(
      <div className="space-y-2">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <dl className="flex flex-wrap gap-x-8 gap-y-2">
            <div><dt className="text-xs text-faint">Estimated cost, fast</dt><dd className="text-lg font-semibold tabular-nums">{cost(fast)}</dd></div>
            {economy && <div><dt className="text-xs text-faint">Estimated cost, economy</dt><dd className="text-lg font-semibold tabular-nums">{cost(economy)}</dd></div>}
            <div><dt className="text-xs text-faint">Candidate pairs to read</dt><dd className="text-lg font-semibold tabular-nums">{e.listedPairs.toLocaleString()}</dd></div>
          </dl>
          <Button disabled={busy} onClick={onReview}>Review and start<ArrowRight aria-hidden className="size-4" /></Button>
        </div>
        {reusable > 0 && <p className="text-xs text-muted">{reusable.toLocaleString()} of {e.packets.toLocaleString()} packets repeat a request an earlier analysis of this case already sent, on the same evidence; their answers are expected to be reused, not charged. You can choose a fresh analysis when you review.</p>}
        {!paidAvailable && <p className="text-xs text-muted">{NO_KEY}</p>}
        {savedAt !== null && <p className="text-xs text-muted">Estimate saved at {new Date(savedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} for this choice. Reviewing prepares a current one first.</p>}
      </div>,
    );
  }
}

const NO_KEY = "Paid analysis is off on this server: it has no API key (see .env.example). You can still review the cost and the saved results.";
const RECOMMENDED = { label: "Recommended", tone: "good" as const };
const DISCLAIMER = "Veridict identifies potential inconsistencies for human review. Results are not definitive findings, and an analysis may not detect every contradiction.";

// One choice as a card: the whole card is the radio's label (click anywhere); radios sharing a name move with the
// arrow keys; the chosen card carries the navy border and ring, and a keyboard focus ring shows on the card.
// The radio is named by its title alone and described by the two descriptions, so a screen reader says the choice first.
function ScopeOption({ name, checked, onChange, title, badge, note, children }: { name: string; checked: boolean; onChange: () => void; title: string; badge?: { label: string; tone: Tone }; note?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <label className="flex cursor-pointer gap-3 rounded-lg border border-line px-4 py-3 transition-colors hover:bg-hover has-checked:border-navy has-checked:bg-hover has-checked:ring-1 has-checked:ring-navy has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-slate/50">
      <input type="radio" name={name} checked={checked} onChange={onChange} aria-labelledby={`${id}-title`} aria-describedby={note ? `${id}-text ${id}-note` : `${id}-text`} className="mt-1 size-4 flex-none accent-navy focus-visible:outline-none" />
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold"><span id={`${id}-title`}>{title}{badge && <span className="sr-only">, {badge.label.toLowerCase()}</span>}</span>{badge && <span aria-hidden className="inline-flex"><Badge tone={badge.tone}>{badge.label}</Badge></span>}</span>
        <span id={`${id}-text`} className="mt-1 block text-sm">{children}</span>
        {note && <span id={`${id}-note`} className="mt-1.5 block text-sm text-muted">{note}</span>}
      </span>
    </label>
  );
}

// The depositions to analyze, grouped by witness; the same selection as the witness tables below.
function SessionPicker({ sessions, selected, onSelect }: { sessions: WorkflowSession[]; selected: number[]; onSelect: (ids: number[]) => void }) {
  const witnesses = [...new Set(sessions.map((s) => s.witness))];
  const toggle = (id: number) => onSelect(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <fieldset className="rounded-lg bg-well px-4 py-3">
      <legend className="sr-only">Depositions to analyze</legend>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold tabular-nums">{selected.length} of {sessions.length} selected</p>
        <span className="flex gap-3 text-sm">
          <button type="button" className="font-medium text-info hover:underline" onClick={() => onSelect(sessions.filter((s) => s.status === "ready").map((s) => s.id))}>Select all ready</button>
          {selected.length > 0 && <button type="button" className="font-medium text-info hover:underline" onClick={() => onSelect([])}>Clear</button>}
        </span>
      </div>
      <div className="mt-2 grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {witnesses.map((w) => (
          <div key={w}>
            <p className="text-xs font-semibold text-muted">{w}</p>
            <ul className="mt-1 space-y-1">
              {sessions.filter((s) => s.witness === w).map((s) => (
                <li key={s.id}>
                  <label className={cx("flex items-center gap-2 text-sm", s.status !== "ready" && "text-faint")}>
                    <input type="checkbox" checked={selected.includes(s.id)} onChange={() => toggle(s.id)} disabled={s.status !== "ready" && !selected.includes(s.id)} className="size-4 rounded accent-navy" />
                    <span>{s.takenOn ? formatDate(s.takenOn) : "Date not set"}</span>
                    <span className="truncate text-muted">{s.label}</span>
                    {s.status !== "ready" && <span className="text-xs">(not ready)</span>}
                  </label>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </fieldset>
  );
}

// A suggested name, editable before starting: what it covers and the day.
export const defaultRunName = (run: CaseRun) => `${!run.scope || run.scope.kind === "case" ? "Whole case" : `${run.scope.depositionIds.length} depositions`}, ${formatDate(run.createdAt)}`;
// How a run is listed: its name, or for one started before names existed, its number.
export const runTitle = (run: CaseRun) => run.name ?? `Analysis #${run.id}`;

// What a run analyzes, in words: the whole case, or the depositions chosen for it.
function scopeText(run: CaseRun, sessions: WorkflowSession[]): string {
  if (!run.scope || run.scope.kind === "case") return "The whole case";
  const ids = run.scope.depositionIds;
  return `${ids.length} selected depositions: ${ids.map((id) => { const s = sessions.find((x) => x.id === id); return s ? `${s.witness}, ${s.takenOn ? formatDate(s.takenOn) : "date not set"}` : `deposition #${id}`; }).join("; ")}`;
}

// onBack: at the review step, Cancel goes back one step (the estimate is kept for that choice) instead of stopping a run.
// elsewhere: why nothing can start now (another analysis in the workspace is running), or null.
function RunState({ run, busy, act, paidBlocked, elsewhere, onBack }: { run: CaseRun; busy: boolean; act: (p: Promise<unknown>) => void; paidBlocked: string | null; elsewhere: string | null; onBack?: () => void }) {
  const s = RUN_STATUS[run.status];
  const test = isTestRun(run);
  const cancel = <Button variant="secondary" disabled={busy || run.cancelRequested} onClick={() => act(api.cancelCaseRun(run.id))}>{run.cancelRequested ? "Cancelling…" : "Cancel"}</Button>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={s.tone} dot>{s.label}</Badge>
        {test ? <Badge tone="accent">Test model: not a real analysis</Badge> : <Badge tone="neutral">Paid analysis: Veridict's model</Badge>}
        {(run.confirmedAt !== null || test) && <Badge tone="neutral">{EXECUTION[run.execution].label}</Badge>}
        {run.contract === "stretch-v2" && <Badge tone="warn">Contextual Analysis (experimental)</Badge>}
        <span className="text-sm text-muted">Started {formatDate(run.createdAt)}</span>
      </div>

      {(run.status === "queued" || run.status === "retrieving") && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">Preparing: finding candidate pairs in every session. {test ? "The test model costs nothing." : "Nothing is sent to Veridict's model and nothing is charged at this stage."}</p>
          {cancel}
        </div>
      )}

      {run.status === "awaiting_confirmation" && run.estimate && <Confirm run={run} busy={busy} act={act} paidBlocked={paidBlocked} elsewhere={elsewhere} cancel={onBack ? <Button variant="secondary" disabled={busy} onClick={onBack}>Cancel</Button> : cancel} />}

      {run.stretch && run.status !== "queued" && run.status !== "retrieving" && run.status !== "awaiting_confirmation" && (
        <p className="max-w-3xl text-sm text-muted tabular-nums">
          Pairs read: {run.stretch.flagged} flagged with verified citations, {run.stretch.flagged_unverified} flagged but not verified, {run.stretch.unclear} unclear, {run.stretch.no_conflict_identified} with no conflict identified (read, not cleared).
        </p>
      )}

      {run.status === "adjudicating" && <Working run={run} cancel={cancel} />}

      {!["queued", "retrieving", "awaiting_confirmation", "adjudicating"].includes(run.status) && <Outcome run={run} busy={busy} act={act} paidBlocked={paidBlocked} elsewhere={elsewhere} />}
    </div>
  );
}

// What the work is, in a lawyer's terms: the stages every packet goes through, not each request. Shown in turn.
const STAGES = [
  "Reading each witness's testimony, session by session",
  "Comparing answers across sessions and witnesses",
  "Checking every citation against the stored transcript",
  "Weighing the evidence behind each potential contradiction",
];

// A run at work: two transcript pages being compared, the share done, a rough time left, the findings so far,
// and that the person can leave. The counts and the spend are under Details.
function Working({ run, cancel }: { run: CaseRun; cancel: ReactNode }) {
  const now = useNow(true);
  const { adjudicated, total } = run.packets;
  const pct = total ? Math.min(100, Math.floor((adjudicated / total) * 100)) : 0;
  const found = run.findings.reduce((n, f) => n + f.n, 0);
  const stage = STAGES[Math.floor(now / 4500) % STAGES.length];
  const left = timeLeft(run, now);
  const economy = run.execution === "batch";
  const page = (scan: string) => (
    <span aria-hidden className="relative block h-16 w-12 overflow-hidden rounded-sm bg-sheet ring-1 ring-line">
      <span className={cx("absolute inset-x-1 top-1.5 h-2.5 rounded-[2px] bg-mark/80", scan)} />
      {[0, 1, 2, 3, 4, 5].map((i) => <span key={i} className="absolute left-2 h-[2px] rounded-full bg-control" style={{ top: 8 + i * 8, right: i % 3 === 2 ? 14 : 8 }} />)}
    </span>
  );
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-well">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-4 px-5 py-5">
        <div className="flex items-center gap-1.5" aria-hidden>
          {page("page-scan")}
          <span className="relative block h-2 w-8"><span className="page-link absolute top-0 left-0 size-2 rounded-full bg-slate" /></span>
          {page("page-scan-late")}
        </div>
        <div className="min-w-0 flex-1 basis-64">
          <p className="text-base font-semibold">Analyzing the testimony</p>
          <p key={stage} className="fade-in mt-0.5 text-sm text-muted" aria-live="off">{stage}</p>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-rule" role="progressbar" aria-label="Analysis progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <div className="h-full rounded-full bg-navy transition-[width] duration-700 ease-out" style={{ width: `${Math.max(pct, 2)}%` }} />
          </div>
          <p className="mt-1.5 flex flex-wrap gap-x-3 text-xs text-muted tabular-nums">
            <span className="font-semibold text-ink">{pct}% done</span>
            <span>{economy ? "Economy: each batch usually finishes within an hour" : left ?? "Estimating time left…"}</span>
            <span>{found === 0 ? "No potential contradictions yet" : `${found.toLocaleString()} potential ${found === 1 ? "contradiction" : "contradictions"} so far`}</span>
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-sheet px-5 py-3">
        <p className="max-w-2xl text-sm text-muted">You don't need to stay on this page. The analysis keeps running on the server; come back to this case any time to see the results.</p>
        <div className="flex flex-wrap gap-2">
          {found > 0 && <a href={href.caseRun(run.id)} className={buttonClass("secondary")}>See findings so far</a>}
          {cancel}
        </div>
      </div>
      <details className="border-t border-line bg-sheet px-5 py-2.5 text-sm">
        <summary className="cursor-pointer text-muted">Details</summary>
        <div className="mt-2 mb-1"><Progress run={run} /></div>
      </details>
    </div>
  );
}

function Progress({ run }: { run: CaseRun }) {
  const b = run.cost.budget;
  const bt = run.batches;
  return (
    <div className="space-y-2">
    <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
      <div><dt className="text-xs text-faint">Evidence packets read</dt><dd className="font-semibold tabular-nums">{run.packets.adjudicated} of {run.packets.total}</dd></div>
      <div><dt className="text-xs text-faint">Candidate pairs with a verdict</dt><dd className="font-semibold tabular-nums">{run.candidates.adjudicated} of {run.candidates.total}</dd></div>
      <div><dt className="text-xs text-faint">Spent</dt><dd className="font-semibold tabular-nums">{isTestRun(run) ? "$0 (test model)" : b ? `${formatUsd(b.spentUsd)} of ${formatUsd(b.limitUsd)}` : formatUsd(run.cost.costUsd)}</dd></div>
      {bt && <div><dt className="text-xs text-faint">Provider batches</dt><dd className="font-semibold tabular-nums">{bt.processing + bt.submitting} processing · {bt.imported} done</dd></div>}
      {bt && !isTestRun(run) && b && b.reservedUsd > 0 && <div><dt className="text-xs text-faint">Held for requests in progress</dt><dd className="font-semibold tabular-nums">{formatUsd(b.reservedUsd)}</dd></div>}
    </dl>
    {bt && run.status === "adjudicating" && (
      <p className="max-w-3xl text-xs text-muted">
        Economy runs on the provider's schedule: each batch usually finishes within an hour. You can leave this page; the analysis continues on the server and findings appear as each batch finishes.{bt.oldestOpenSince ? ` Oldest open batch sent ${formatDate(bt.oldestOpenSince)}.` : ""}
      </p>
    )}
    </div>
  );
}

// The mode, the estimate, the warning and the explicit authorization: the only way a live run starts spending.
function Confirm({ run, busy, act, paidBlocked, elsewhere, cancel }: { run: CaseRun; busy: boolean; act: (p: Promise<unknown>) => void; paidBlocked: string | null; elsewhere: string | null; cancel: ReactNode }) {
  const e = run.estimate!;
  const [execution, setExecution] = useState<CaseRunExecution>("standard");
  // Exact-request reuse: packets an earlier analysis of this case already sent word for word are expected to reuse
  // its answers. "Run fresh analysis" asks the model again for every packet instead, charged in full.
  const [fresh, setFresh] = useState(false);
  const canReuse = !!e.reuse?.checked && e.reuse.reusableRequests > 0;
  const chosen = reuseAdjusted(e, execution, fresh)!;
  const [limit, setLimit] = useState(defaultLimit(e.recommendedBudgetUsd));
  const [edited, setEdited] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [name, setName] = useState(defaultRunName(run));
  const economy = execution === "batch";
  const problem = budgetProblem(limit);
  const choose = (x: CaseRunExecution) => {
    setExecution(x);
    if (!edited) setLimit(defaultLimit(modeEstimate(e, x)!.recommendedUsd)); // a limit the person typed is kept
  };
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    // One checkbox: for economy the privacy notice sits under it and describes it, so authorizing acknowledges it too.
    if (!problem && agreed && !elsewhere) act(api.confirmCaseRun(run.id, Number(limit), execution, economy, name.trim() || undefined, canReuse && fresh));
  };
  // Two decimals in this step (the shared formatter shows four below $1); amounts under a cent read "under $0.01".
  const usd = (n: number) => (n > 0 && n < 0.005 ? "under $0.01" : `$${n.toFixed(2)}`);
  const cost = (x: { lowUsd: number; highUsd: number }) => (usd(x.lowUsd) === usd(x.highUsd) ? usd(x.lowUsd) : `${usd(x.lowUsd)}–${usd(x.highUsd)}`);
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Analysis name" htmlFor={`name-${run.id}`} hint="So you can tell your analyses apart later.">
        <input id={`name-${run.id}`} className={cx(inputClass, "sm:max-w-md")} value={name} maxLength={120} onChange={(ev) => setName(ev.target.value)} />
      </Field>
      <fieldset>
        <legend className="text-sm font-semibold">Choose your analysis speed</legend>
        <p className="mt-0.5 text-sm text-muted">Both options examine the same prepared evidence using the same analysis method. The difference is how quickly results are delivered and how much they cost.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {(["standard", "batch"] as const).map((x) => {
            const m = reuseAdjusted(e, x, fresh);
            // Why a mode can't run on this server, from the server's own capability report (never assumed).
            const off = run.paidAvailable === false ? "Needs the server's API key." : null;
            const id = `execution-${run.id}-${x}`;
            // One card per speed, the whole card the radio's label: title, description, then the cost on the bottom edge,
            // so both cards (equal height in the grid) line their costs up. Named by the title, described by the rest.
            return (
              <label key={x} className={cx("flex h-full cursor-pointer flex-col rounded-lg border border-line bg-sheet transition-colors hover:bg-hover has-checked:border-navy has-checked:bg-hover has-checked:ring-1 has-checked:ring-navy has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-slate/50", (!m || off) && "cursor-not-allowed opacity-60 hover:bg-sheet")}>
                <span className="flex gap-3 px-4 pt-4 pb-3">
                  <input type="radio" name={`execution-${run.id}`} value={x} checked={execution === x} disabled={!m || !!off} onChange={() => choose(x)} aria-labelledby={`${id}-title`} aria-describedby={`${id}-text ${id}-cost${off ? ` ${id}-off` : ""}`} className="mt-0.5 size-4 flex-none accent-navy focus-visible:outline-none" />
                  <span className="min-w-0">
                    <span id={`${id}-title`} className="block text-[15px] font-semibold">{EXECUTION[x].label}</span>
                    <span id={`${id}-text`} className="mt-1 block text-sm leading-6 text-muted">{EXECUTION[x].description}</span>
                    {off && <span id={`${id}-off`} className="mt-1 block text-xs text-muted">{off}</span>}
                  </span>
                </span>
                <span id={`${id}-cost`} className="mt-auto flex items-baseline justify-between gap-3 border-t border-rule px-4 py-3 pl-11">
                  <span className="text-xs text-faint">Estimated cost</span>
                  <span className="text-base font-semibold tabular-nums">{m ? cost(m) : "Prepare a new estimate"}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      {canReuse && (
        <div className="rounded-lg border border-line px-4 py-3">
          <p className="text-sm">
            {fresh
              ? "Fresh analysis: every packet is sent to Veridict's model and charged, as if this case had not been analyzed before."
              : `${e.reuse!.reusableRequests.toLocaleString()} of ${e.packets.toLocaleString()} packets repeat a request an earlier analysis of this case sent word for word, on the same evidence. Their earlier answers are expected to be reused and checked again, not charged: about ${usd(chosen.avoidedUsd)} less. A packet whose earlier answer can't be reused is sent and charged within your limit.`}
          </p>
          <label className="mt-2 flex items-start gap-3 text-sm">
            <input type="checkbox" checked={fresh} onChange={(ev) => setFresh(ev.target.checked)} className="mt-0.5 size-4 flex-none rounded accent-navy" />
            <span><span className="font-medium">Run fresh analysis</span> <span className="text-muted">Ask the model again for every packet instead of reusing earlier answers. Charged in full.</span></span>
          </label>
        </div>
      )}
      <dl className="grid grid-cols-2 divide-rule rounded-lg border border-line sm:grid-cols-4 sm:divide-x">
        <div className="px-4 py-3"><dt className="text-xs text-faint">{canReuse && !fresh ? "Estimated new cost" : "Estimated cost"}</dt><dd className="mt-0.5 text-lg font-semibold tabular-nums">{cost(chosen)}</dd></div>
        <div className="px-4 py-3"><dt className="text-xs text-faint">Recommended limit</dt><dd className="mt-0.5 text-lg font-semibold tabular-nums">{formatUsd(chosen.recommendedUsd)}</dd></div>
        <div className="px-4 py-3"><dt className="text-xs text-faint">Evidence packets</dt><dd className="mt-0.5 text-lg font-semibold tabular-nums">{e.packets.toLocaleString()}</dd></div>
        <div className="px-4 py-3"><dt className="text-xs text-faint">Candidate pairs to read</dt><dd className="mt-0.5 text-lg font-semibold tabular-nums">{e.listedPairs.toLocaleString()}</dd></div>
      </dl>
      <Alert tone="warn" title="This analysis is paid">
        <p>
          Reading every packet uses Veridict's model and is charged to the API account configured on this server. The estimate is a projection from the size of this case's evidence, not a quote: larger cases cost more. The run stops before any request the limit can't cover; whatever is left stays unread, never counted as reviewed, until you resume with a higher limit.
        </p>
        {economy && (
          <p className="mt-1">
            Economy sends the packets in batches that the provider processes on its own schedule, usually within an hour each. The range above runs from the price with the shared instructions cached to the price with no cache hits, which the provider doesn't guarantee. While a batch is processing, each of its requests holds its largest possible cost against your limit, so a limit close to the estimate means fewer packets at once and a longer run, never a higher charge.
          </p>
        )}
      </Alert>
      {paidBlocked ? (
        <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted">{paidBlocked}</p>{cancel}</div>
      ) : run.paidAvailable === false ? (
        <div className="space-y-3">
          <Alert title="Paid analysis isn't set up on this server">
            Add the API key to the server's .env file (see .env.example) and restart Veridict to run either mode. Nothing can be sent or charged until then.
          </Alert>
          <div className="flex flex-wrap gap-2">{cancel}</div>
        </div>
      ) : (
        <>
          {/* The limit and the authorization side by side, as two equal panels, top-aligned. */}
          <div className="grid gap-3 sm:grid-cols-2 sm:items-stretch">
            <div className="rounded-lg border border-line px-4 py-3">
              <Field label="Spending limit (USD)" htmlFor={`limit-${run.id}`} hint={`Recommended ${formatUsd(chosen.recommendedUsd)} for ${EXECUTION[execution].label.toLowerCase()}. Up to $${MAX_CASE_RUN_BUDGET_USD}.`}>
                <input id={`limit-${run.id}`} inputMode="decimal" className={inputClass} value={limit} onChange={(ev) => { setLimit(ev.target.value); setEdited(true); }} aria-invalid={!!problem} aria-describedby={problem ? `limit-problem-${run.id}` : undefined} />
              </Field>
            </div>
            <fieldset className="rounded-lg border border-line px-4 py-3">
              <legend className="sr-only">Authorization</legend>
              <p aria-hidden className="text-sm font-medium">Authorization</p>
              <div className="mt-2 space-y-3">
                <label className="flex items-start gap-3 text-sm">
                  <input type="checkbox" checked={agreed} onChange={(ev) => setAgreed(ev.target.checked)} aria-describedby={economy ? `privacy-${run.id}` : undefined} className="mt-0.5 size-4 flex-none rounded accent-navy" />
                  <span>I authorize Veridict to spend up to <strong className="font-semibold tabular-nums">{problem ? "the limit set here" : formatUsd(Number(limit))}</strong> on this analysis.</span>
                </label>
                {economy && (
                  <div id={`privacy-${run.id}`} className="flex items-start gap-3 text-sm">
                    <Info aria-hidden className="mt-0.5 size-4 flex-none text-muted" />
                    <p className="text-muted">
                      <span className="font-medium text-ink">Economy privacy notice:</span> Testimony excerpts sent for analysis and the responses may be retained by the AI provider for up to 29 days. This processing does not support zero data retention.{" "}
                      <a href={`${href.help()}`} target="_blank" rel="noreferrer" className="mt-1 flex w-fit items-center gap-0.5 font-medium text-ink underline decoration-dotted underline-offset-4 hover:decoration-solid">Learn about data handling<ArrowUpRight aria-hidden className="size-3.5" /><span className="sr-only"> (opens in a new tab)</span></a>
                    </p>
                  </div>
                )}
              </div>
            </fieldset>
          </div>
          {problem && <p id={`limit-problem-${run.id}`} role="alert" className="text-sm text-conflict">{problem}</p>}
          {elsewhere && <p className="text-sm text-muted">{elsewhere}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || !!problem || !agreed || !!elsewhere}>{busy ? "Starting…" : economy ? "Start economy analysis" : "Start fast analysis"}</Button>
            {cancel}
          </div>
        </>
      )}
    </form>
  );
}

// Whether a run stopped in a way the server resumes. The control is always shown then; when something prevents it
// right now (no API key on the server, no access, another analysis running) it is disabled with the reason.
export const canResume = (run: CaseRun) => RESUMABLE_RUN.includes(run.status);

// Resume a stopped, failed, cancelled or incomplete run: the packets not yet read (and those left unanswered) are
// queued again, nothing already read is sent again. A run stopped at its spending limit asks for a higher one first.
// Shown wherever the run is: the case's steps, its row under Previous analyses, and its own page.
export function ResumeControl({ run, busy, act, paidBlocked, elsewhere, compact }: { run: CaseRun; busy: boolean; act: (p: Promise<unknown>) => void; paidBlocked: string | null; elsewhere: string | null; compact?: boolean }) {
  const b = run.cost.budget;
  const [limit, setLimit] = useState(b ? Math.max(b.limitUsd * 2, b.limitUsd + 1).toFixed(2) : "");
  if (!canResume(run)) return null;
  const needsLimit = run.status === "blocked_budget";
  const problem = needsLimit ? budgetProblem(limit, b?.limitUsd ?? 0) : null;
  const blocked = (!isTestRun(run) && (paidBlocked || (run.paidAvailable === false ? "Paid analysis is off on this server: it has no API key (see .env.example)." : null))) || elsewhere;
  const label = needsLimit ? "Raise the limit and resume" : run.status === "failed" ? "Try again" : "Resume";
  return (
    <div className={cx("flex flex-wrap items-end gap-2", compact && "items-center")}>
      {needsLimit && !blocked && (
        <Field label="New spending limit (USD)" htmlFor={`resume-${run.id}`}>
          <input id={`resume-${run.id}`} inputMode="decimal" className={cx(inputClass, "w-40")} value={limit} onChange={(e) => setLimit(e.target.value)} aria-invalid={!!problem} />
        </Field>
      )}
      <Button variant="secondary" disabled={busy || !!problem || !!blocked} title={blocked || "Reads what this analysis hasn't read yet; nothing already read is sent again."} onClick={() => act(api.resumeCaseRun(run.id, needsLimit ? Number(limit) : undefined))}>
        <RotateCcw aria-hidden className="size-4" />{busy ? "Resuming…" : label}
      </Button>
      {!compact && blocked && <p className="basis-full text-sm text-muted">{blocked}</p>}
      {problem && <p role="alert" className="basis-full text-sm text-conflict">{problem}</p>}
    </div>
  );
}

// The moment an analysis ends: that it is done (or done with work left), what it found, and the way to its review.
function Finished({ run }: { run: CaseRun }) {
  const found = run.findings.reduce((n, f) => n + f.n, 0);
  const reviewed = Math.min(run.reviewed ?? 0, found);
  const complete = run.status === "completed";
  const when = run.finishedAt ? ` ${formatDate(run.finishedAt)}` : "";
  return (
    <div role="status" className={cx("flex flex-wrap items-center justify-between gap-x-6 gap-y-4 rounded-lg border px-5 py-4", complete ? "border-ok/25 bg-ok-bg" : "border-context/25 bg-context-bg")}>
      <div className="flex min-w-0 flex-1 basis-80 items-start gap-3">
        {complete ? <CircleCheck aria-hidden className="mt-0.5 size-6 flex-none text-ok" strokeWidth={2} /> : <CircleAlert aria-hidden className="mt-0.5 size-6 flex-none text-context" strokeWidth={2} />}
        <div className="min-w-0">
          <p className="text-md font-semibold text-ink">{complete ? "Analysis complete" : "Analysis finished, with work left"}</p>
          <p className="mt-0.5 text-sm text-ink/80">
            {complete ? `Finished${when}. ` : `Stopped${when} before every pair was read; resume it to read the rest. `}
            {found === 0 ? "It found nothing to review." : `${found.toLocaleString()} ${found === 1 ? "finding is" : "findings are"} ready for your review${reviewed > 0 ? `, ${reviewed.toLocaleString()} already decided` : ""}.`}
          </p>
        </div>
      </div>
      <a href={href.caseRun(run.id)} className={buttonClass("primary", "h-9 px-4")}>{found === 0 ? "Open the analysis" : "Review findings"}<ArrowRight aria-hidden className="size-4" /></a>
    </div>
  );
}

function Outcome({ run, busy, act, paidBlocked, elsewhere }: { run: CaseRun; busy: boolean; act: (p: Promise<unknown>) => void; paidBlocked: string | null; elsewhere: string | null }) {
  const c = COVERAGE[run.coverageState];
  const found = run.findings.reduce((n, f) => n + f.n, 0);
  const done = run.status === "completed" || run.status === "incomplete";
  return (
    <div className="space-y-3">
      {done && <Finished run={run} />}
      {!done && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={c.tone} dot>{c.label}</Badge>
          <span className="text-sm text-muted">{c.help}</span>
        </div>
      )}
      {run.status === "blocked_credentials" && <p className="text-sm text-muted">This server has no API key in its .env (see .env.example). Nothing was sent and nothing was charged.</p>}
      {run.error && run.status !== "blocked_credentials" && !done && <p className="text-sm text-muted">{run.error}</p>}
      {done ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted">Details</summary>
          <div className="mt-2 space-y-2">
            <div className="flex flex-wrap items-center gap-2"><Badge tone={c.tone} dot>{c.label}</Badge><span className="text-muted">{c.help}</span></div>
            <Progress run={run} />
          </div>
        </details>
      ) : <Progress run={run} />}
      {run.incompleteReasons.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">What wasn't read, and why ({run.incompleteReasons.length})</summary>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-muted">{run.incompleteReasons.map((r) => <li key={r}>{r}</li>)}</ul>
        </details>
      )}
      <div className="flex flex-wrap items-end gap-2">
        {!done && (found > 0 || run.packets.adjudicated > 0) && <a href={href.caseRun(run.id)} className={buttonClass("primary")}>View findings ({found})<ArrowRight aria-hidden className="size-4" /></a>}
        <ResumeControl run={run} busy={busy} act={act} paidBlocked={paidBlocked} elsewhere={elsewhere} />
      </div>
      {run.packets.uncertain > 0 && <p className="text-xs text-muted">{run.packets.uncertain} packets stopped after a request the provider may have received; resuming doesn't send them again, so they can't be charged twice.</p>}
      {run.batches && run.batches.awaitingImport > 0 && run.batches.resultsExpireAt && <p className="text-xs text-muted">Finished batch results not yet saved are kept by the provider until {formatDate(run.batches.resultsExpireAt)}; resuming saves them.</p>}
    </div>
  );
}

// Every analysis of the case, newest first, under the steps: its name, what it covered and how, where it stands,
// and how far its review has got, each a click from its findings. Shown whenever the case has one.
function PreviousAnalyses({ runs, sessions, resume }: { runs: CaseRun[]; sessions: WorkflowSession[]; resume: (run: CaseRun) => ReactNode }) {
  return (
    <Card className="mt-6 overflow-hidden">
      <CardHeader title="Previous analyses" count={runs.length} description="Every analysis of this case, newest first. Open one to review its findings or download its report." />
      <ul className="divide-y divide-rule">
        {runs.map((r) => {
          const found = r.findings.reduce((n, f) => n + f.n, 0);
          const reviewed = Math.min(r.reviewed ?? 0, found);
          const s = RUN_STATUS[r.status];
          return (
            <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 pr-5 transition-colors hover:bg-hover">
              <a href={href.caseRun(r.id)} className="group flex min-w-0 flex-1 basis-96 flex-wrap items-center gap-x-6 gap-y-2 py-3 pl-5">
                <span className="min-w-0 flex-1 basis-72">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold group-hover:underline">{runTitle(r)}</span>
                    {s.tone !== "good" && <Badge tone={s.tone} dot>{s.label}</Badge>}
                    {isTestRun(r) && <Badge tone="accent">Test model</Badge>}
                  </span>
                  <span className="mt-0.5 block text-sm text-muted">
                    {[formatDate(r.createdAt), scopeText(r, sessions), r.contract === "stretch-v2" ? "Contextual Analysis" : "Focused Analysis", EXECUTION[r.execution].label, ...(isTestRun(r) ? [] : [formatUsd(r.cost.costUsd)])].join(" · ")}
                  </span>
                </span>
                <span className="text-sm tabular-nums">
                  <span className="font-semibold">{found.toLocaleString()}</span> <span className="text-muted">{found === 1 ? "finding" : "findings"}</span>
                  {found > 0 && <span className="text-muted"> · {reviewed === found ? "all reviewed" : `${reviewed} reviewed`}</span>}
                </span>
                <ArrowRight aria-hidden className="size-4 text-faint group-hover:text-ink" />
              </a>
              {canResume(r) && <span className="py-2">{resume(r)}</span>}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
