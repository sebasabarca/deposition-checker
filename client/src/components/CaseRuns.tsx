// Whole-case analysis on the case page: every witness and session of the case at once, through the case-run
// API (docs/case-run-api.md). A live run first prepares the comparison and its cost estimate, sending nothing to
// a model; it spends only after a person confirms a spending limit here. A test run uses the free deterministic
// stand-in for the model and is labelled as such everywhere its results appear.

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { api } from "../lib/api";
import { budgetProblem, canStartRun, COVERAGE, defaultLimit, EXECUTION, isTestRun, MAX_CASE_RUN_BUDGET_USD, modeEstimate, MOVING_RUN, RESUMABLE_RUN, RUN_STATUS } from "../lib/caseRuns";
import { formatDate, formatUsd } from "../lib/labels";
import { href, usePoll } from "../lib/router";
import { useUser } from "../lib/session";
import type { CaseRun, CaseRunExecution } from "../types";
import { NO_ACCESS } from "./CheckAgain";
import { Alert, Badge, Button, buttonClass, Card, CardHeader, cx, Field, inputClass } from "./ui";

export function useCaseRuns(caseId: number) {
  const [runs, setRuns] = useState<CaseRun[] | null>(null);
  const [stretchAvailable, setStretchAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.caseRuns(caseId).then((r) => { setRuns(r.caseRuns); setStretchAvailable(!!r.stretchAvailable); setError(null); }, (e: Error) => setError(e.message));
  }, [caseId]);
  useEffect(load, [load]);
  usePoll(!!runs?.[0] && MOVING_RUN.includes(runs[0].status), 3000, load);
  return { runs, stretchAvailable, error, reload: load };
}

export const WHOLE_CASE_PANEL = "whole-case-analysis";

export function CaseRunPanel({ caseId, readySessions, witnesses }: { caseId: number; readySessions: number; witnesses: number }) {
  const { runs, stretchAvailable, error, reload } = useCaseRuns(caseId);
  const [busy, setBusy] = useState(false);
  const [stretch, setStretch] = useState(false); // the experimental whole-stretch reading, offered only where the server allows it
  const contract = stretch && stretchAvailable ? ("stretch-v2" as const) : undefined;
  const [problem, setProblem] = useState<string | null>(null);
  const user = useUser();
  const latest = runs?.[0] ?? null;
  const act = (p: Promise<unknown>) => {
    setBusy(true);
    setProblem(null);
    p.then(reload, (e: Error) => setProblem(e.message)).finally(() => setBusy(false));
  };
  const blocked = canStartRun(latest, readySessions);
  const paidBlocked = !user?.emailVerified ? "Verify your email before preparing a paid analysis." : !user.analysisAccess ? NO_ACCESS : null;
  const showStart = !latest || !["queued", "retrieving", "awaiting_confirmation", "adjudicating"].includes(latest.status);

  return (
    <div id={WHOLE_CASE_PANEL} tabIndex={-1} className="scroll-mt-6 rounded-lg focus:outline-2 focus:outline-offset-2 focus:outline-slate/40">
    <Card className="overflow-hidden">
      <CardHeader
        title="Whole-case analysis"
        description={`Compares every session in this case with every other: the same witness across sessions, and ${witnesses > 1 ? "different witnesses against each other" : "other witnesses once you add them"}.`}
        action={latest && runs && runs.length > 1 ? <span className="text-sm text-muted tabular-nums">{runs.length} runs</span> : undefined}
      />
      <div className="space-y-4 px-5 py-4">
        {error && <Alert title="Whole-case analyses couldn't be loaded" action={<Button variant="secondary" onClick={reload}>Try again</Button>}>{error}</Alert>}
        {problem && <Alert title="That didn't work">{problem}</Alert>}
        {latest && <RunState run={latest} busy={busy} act={act} paidBlocked={paidBlocked} />}
        {runs && runs.length > 1 && <EarlierRuns runs={runs.slice(1)} />}
        {showStart && (
          <div className="space-y-3">
            {!latest && (
              <p className="max-w-3xl text-sm text-muted">
                Veridict first prepares the comparison: it finds the candidate pairs across all sessions and estimates what reading them would cost. Nothing is sent to a model and nothing is charged until you review the estimate and confirm a spending limit.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={busy || !!blocked || !!paidBlocked} onClick={() => act(api.startCaseRun(caseId, "live", "standard", contract))}>{latest ? "Prepare a new cost estimate" : "Analyze entire case"}</Button>
              <Button variant="secondary" disabled={busy || !!blocked} onClick={() => act(api.startCaseRun(caseId, "mock", "standard", contract))}>Run with the test model (free)</Button>
              <Button variant="secondary" disabled={busy || !!blocked} onClick={() => act(api.startCaseRun(caseId, "mock", "batch", contract))}>Test economy mode (free)</Button>
            </div>
            {stretchAvailable && (
              <label className="flex max-w-3xl items-start gap-2 text-sm">
                <input type="checkbox" checked={stretch} onChange={(ev) => setStretch(ev.target.checked)} className="mt-0.5 size-4 rounded accent-navy" />
                <span>
                  Use the experimental whole-stretch reading
                  <span className="mt-0.5 block text-xs text-muted">The model reads the full stretch of testimony around nearby pairs and reports only the conflicts it finds. Cheaper per pair, but its accuracy hasn't been validated: a pair with no conflict identified is read, not cleared.</span>
                </span>
              </label>
            )}
            <p className="max-w-3xl text-xs text-muted">
              {blocked ?? paidBlocked ?? "The test model is a deterministic stand-in that exercises the whole pipeline at no cost, in fast or economy mode. Its results are labelled as test results and say nothing about the testimony."}
              {!blocked && paidBlocked && " You can still run the test model."}
            </p>
          </div>
        )}
      </div>
    </Card>
    </div>
  );
}

function RunState({ run, busy, act, paidBlocked }: { run: CaseRun; busy: boolean; act: (p: Promise<unknown>) => void; paidBlocked: string | null }) {
  const s = RUN_STATUS[run.status];
  const test = isTestRun(run);
  const cancel = <Button variant="secondary" disabled={busy || run.cancelRequested} onClick={() => act(api.cancelCaseRun(run.id))}>{run.cancelRequested ? "Cancelling…" : "Cancel"}</Button>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={s.tone} dot>{s.label}</Badge>
        {test ? <Badge tone="accent">Test model: not a real analysis</Badge> : <Badge tone="neutral">Paid model: {run.model}</Badge>}
        {(run.confirmedAt !== null || test) && <Badge tone="neutral">{EXECUTION[run.execution].label}</Badge>}
        {run.contract === "stretch-v2" && <Badge tone="warn">Experimental: whole-stretch reading</Badge>}
        <span className="text-sm text-muted">Started {formatDate(run.createdAt)}</span>
      </div>

      {(run.status === "queued" || run.status === "retrieving") && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">Preparing: finding candidate pairs in every session. {test ? "The test model costs nothing." : "Nothing is sent to a model and nothing is charged at this stage."}</p>
          {cancel}
        </div>
      )}

      {run.status === "awaiting_confirmation" && run.estimate && <Confirm run={run} busy={busy} act={act} paidBlocked={paidBlocked} cancel={cancel} />}

      {run.stretch && run.status !== "queued" && run.status !== "retrieving" && run.status !== "awaiting_confirmation" && (
        <p className="max-w-3xl text-sm text-muted tabular-nums">
          Pairs read: {run.stretch.flagged} flagged with verified citations, {run.stretch.flagged_unverified} flagged but not verified, {run.stretch.unclear} unclear, {run.stretch.no_conflict_identified} with no conflict identified (read, not cleared).
        </p>
      )}

      {run.status === "adjudicating" && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Progress run={run} />
          <div className="flex flex-wrap gap-2">
            {/* Findings so far: an economy run's arrive batch by batch. */}
            {run.packets.adjudicated > 0 && <a href={href.caseRun(run.id)} className={buttonClass("secondary")}>Findings so far ({run.findings.reduce((n, f) => n + f.n, 0)})</a>}
            {cancel}
          </div>
        </div>
      )}

      {!["queued", "retrieving", "awaiting_confirmation", "adjudicating"].includes(run.status) && <Outcome run={run} busy={busy} act={act} paidBlocked={paidBlocked} />}
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
        Economy runs on the provider's schedule: each batch usually finishes within an hour and always within 24 hours. You can leave this page; the analysis continues on the server and findings appear as each batch finishes.{bt.oldestOpenSince ? ` Oldest open batch sent ${formatDate(bt.oldestOpenSince)}.` : ""}
      </p>
    )}
    </div>
  );
}

// The mode, the estimate, the warning and the explicit authorization: the only way a live run starts spending.
function Confirm({ run, busy, act, paidBlocked, cancel }: { run: CaseRun; busy: boolean; act: (p: Promise<unknown>) => void; paidBlocked: string | null; cancel: ReactNode }) {
  const e = run.estimate!;
  const [execution, setExecution] = useState<CaseRunExecution>("standard");
  const chosen = modeEstimate(e, execution)!;
  const [limit, setLimit] = useState(defaultLimit(e.recommendedBudgetUsd));
  const [edited, setEdited] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [retention, setRetention] = useState(false);
  const economy = execution === "batch";
  const problem = budgetProblem(limit);
  const choose = (x: CaseRunExecution) => {
    setExecution(x);
    if (!edited) setLimit(defaultLimit(modeEstimate(e, x)!.recommendedUsd)); // a limit the person typed is kept
  };
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    if (!problem && agreed && (!economy || retention)) act(api.confirmCaseRun(run.id, Number(limit), execution, retention));
  };
  const cost = (x: { lowUsd: number; highUsd: number }) => (x.lowUsd === x.highUsd ? formatUsd(x.lowUsd) : `${formatUsd(x.lowUsd)}–${formatUsd(x.highUsd)}`);
  return (
    <form onSubmit={submit} className="space-y-4">
      <fieldset>
        <legend className="text-sm font-semibold">Choose analysis mode</legend>
        <p className="mt-0.5 text-xs text-muted">Both modes read the same prepared evidence with the same model, checks and scoring. They differ in speed and price.</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {(["standard", "batch"] as const).map((x) => {
            const m = modeEstimate(e, x);
            const off = x === "batch" && !run.economyAvailable;
            return (
              <label key={x} className={cx("flex cursor-pointer gap-3 rounded-lg border border-line px-4 py-3 transition-colors hover:bg-hover has-checked:border-navy has-checked:bg-hover", (!m || off) && "cursor-not-allowed opacity-60 hover:bg-transparent")}>
                <input type="radio" name={`execution-${run.id}`} value={x} checked={execution === x} disabled={!m || off} onChange={() => choose(x)} className="mt-1 size-4 accent-navy" />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">{EXECUTION[x].label}</span>
                  <span className="mt-0.5 block text-sm text-muted">{EXECUTION[x].description}</span>
                  <span className="mt-1.5 block text-sm tabular-nums">{m ? <>Estimated <strong className="font-semibold">{cost(m)}</strong></> : "Prepare a new estimate to see this mode's cost."}</span>
                  {off && <span className="mt-1 block text-xs text-muted">Not enabled on this server yet. You can try it free with <strong className="font-semibold">Test economy mode</strong>.</span>}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <dl className="grid grid-cols-2 divide-rule rounded-lg border border-line sm:grid-cols-4 sm:divide-x">
        <div className="px-4 py-3"><dt className="text-xs text-faint">Estimated cost</dt><dd className="mt-0.5 text-lg font-semibold tabular-nums">{cost(chosen)}</dd></div>
        <div className="px-4 py-3"><dt className="text-xs text-faint">Recommended limit</dt><dd className="mt-0.5 text-lg font-semibold tabular-nums">{formatUsd(chosen.recommendedUsd)}</dd></div>
        <div className="px-4 py-3"><dt className="text-xs text-faint">Evidence packets</dt><dd className="mt-0.5 text-lg font-semibold tabular-nums">{e.packets.toLocaleString()}</dd></div>
        <div className="px-4 py-3"><dt className="text-xs text-faint">Candidate pairs to read</dt><dd className="mt-0.5 text-lg font-semibold tabular-nums">{e.listedPairs.toLocaleString()}</dd></div>
      </dl>
      <Alert tone="warn" title={economy ? "This analysis is paid, and can take up to 24 hours" : "This analysis is paid"}>
        <p>
          Reading every packet calls {run.model} and is charged to the Anthropic API account configured on this server. The estimate is a projection from the size of this case's evidence, not a quote: larger cases cost more. The run stops before any request the limit can't cover; whatever is left stays unread, never counted as reviewed, until you resume with a higher limit.
        </p>
        {economy && (
          <p className="mt-1">
            Economy sends the packets in batches that the provider processes on its own schedule, usually within an hour each and always within 24 hours. The range above runs from the price with the shared instructions cached to the price with no cache hits, which the provider doesn't guarantee. While a batch is processing, each of its requests holds its largest possible cost against your limit, so a limit close to the estimate means fewer packets at once and a longer run, never a higher charge.
          </p>
        )}
        {run.candidates.deferred + run.candidates.uncovered > 0 && <p className="mt-1">Retrieval set aside {(run.candidates.deferred + run.candidates.uncovered).toLocaleString()} pairs; they won't be read in this run.</p>}
      </Alert>
      {paidBlocked ? (
        <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted">{paidBlocked}</p>{cancel}</div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-[14rem_1fr] sm:items-end">
            <Field label="Spending limit (USD)" htmlFor={`limit-${run.id}`} hint={`Up to $${MAX_CASE_RUN_BUDGET_USD}.`}>
              <input id={`limit-${run.id}`} inputMode="decimal" className={inputClass} value={limit} onChange={(ev) => { setLimit(ev.target.value); setEdited(true); }} aria-invalid={!!problem} aria-describedby={problem ? `limit-problem-${run.id}` : undefined} />
            </Field>
            <div className="space-y-2">
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={agreed} onChange={(ev) => setAgreed(ev.target.checked)} className="mt-0.5 size-4 rounded accent-navy" />
                <span>I authorize Veridict to spend up to <strong className="font-semibold tabular-nums">{problem ? "the limit above" : formatUsd(Number(limit))}</strong> on this analysis.</span>
              </label>
              {economy && (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" checked={retention} onChange={(ev) => setRetention(ev.target.checked)} className="mt-0.5 size-4 rounded accent-navy" />
                  <span>I understand that for economy processing Anthropic stores this testimony and the results for up to 29 days, and that batch processing isn't covered by zero data retention.</span>
                </label>
              )}
            </div>
          </div>
          {problem && <p id={`limit-problem-${run.id}`} role="alert" className="text-sm text-conflict">{problem}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || !!problem || !agreed || (economy && !retention)}>{busy ? "Starting…" : economy ? "Start economy analysis" : "Start fast analysis"}</Button>
            {cancel}
          </div>
        </>
      )}
    </form>
  );
}

function Outcome({ run, busy, act, paidBlocked }: { run: CaseRun; busy: boolean; act: (p: Promise<unknown>) => void; paidBlocked: string | null }) {
  const c = COVERAGE[run.coverageState];
  const found = run.findings.reduce((n, f) => n + f.n, 0);
  const b = run.cost.budget;
  const [limit, setLimit] = useState(b ? Math.max(b.limitUsd * 2, b.limitUsd + 1).toFixed(2) : "");
  const resumable = RESUMABLE_RUN.includes(run.status) && run.status !== "blocked_credentials";
  const needsLimit = run.status === "blocked_budget";
  const problem = needsLimit ? budgetProblem(limit, b?.limitUsd ?? 0) : null;
  const liveBlocked = !isTestRun(run) && paidBlocked;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={c.tone} dot>{c.label}</Badge>
        <span className="text-sm text-muted">{c.help}</span>
      </div>
      {run.status === "blocked_credentials" && <p className="text-sm text-muted">This server isn't set up to call the model (it needs an API key and ALLOW_PAID_CALLS=true). Nothing was sent and nothing was charged.</p>}
      {run.error && run.status !== "blocked_credentials" && <p className="text-sm text-muted">{run.error}</p>}
      <Progress run={run} />
      {run.incompleteReasons.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">What wasn't read, and why ({run.incompleteReasons.length})</summary>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-muted">{run.incompleteReasons.map((r) => <li key={r}>{r}</li>)}</ul>
        </details>
      )}
      <div className="flex flex-wrap items-end gap-2">
        {(found > 0 || run.packets.adjudicated > 0) && <a href={href.caseRun(run.id)} className={buttonClass("primary")}>View findings ({found})<ArrowRight aria-hidden className="size-4" /></a>}
        {resumable && !liveBlocked && (
          <>
            {needsLimit && (
              <Field label="New spending limit (USD)" htmlFor={`resume-${run.id}`}>
                <input id={`resume-${run.id}`} inputMode="decimal" className={cx(inputClass, "w-40")} value={limit} onChange={(e) => setLimit(e.target.value)} />
              </Field>
            )}
            <Button variant="secondary" disabled={busy || !!problem} onClick={() => act(api.resumeCaseRun(run.id, needsLimit ? Number(limit) : undefined))}>{needsLimit ? "Raise the limit and resume" : "Resume"}</Button>
          </>
        )}
      </div>
      {problem && <p role="alert" className="text-sm text-conflict">{problem}</p>}
      {run.packets.uncertain > 0 && <p className="text-xs text-muted">{run.packets.uncertain} packets stopped after a request the provider may have received; resuming doesn't send them again, so they can't be charged twice.</p>}
      {run.batches && run.batches.awaitingImport > 0 && run.batches.resultsExpireAt && <p className="text-xs text-muted">Finished batch results not yet saved are kept by the provider until {formatDate(run.batches.resultsExpireAt)}; resuming saves them.</p>}
    </div>
  );
}

// Every earlier run stays reachable, with its findings, after a newer one starts.
function EarlierRuns({ runs }: { runs: CaseRun[] }) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer font-medium">Earlier runs ({runs.length})</summary>
      <ul className="mt-2 divide-y divide-rule rounded-lg border border-line">
        {runs.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
            <span className="flex flex-wrap items-center gap-2">
              <Badge tone={RUN_STATUS[r.status].tone} dot>{RUN_STATUS[r.status].label}</Badge>
              {isTestRun(r) && <Badge tone="accent">Test model</Badge>}
              {r.confirmedAt !== null || isTestRun(r) ? <Badge tone="neutral">{EXECUTION[r.execution].short}</Badge> : null}
              <span className="text-muted">{formatDate(r.createdAt)} · {r.findings.reduce((n, f) => n + f.n, 0)} findings · {COVERAGE[r.coverageState].label}</span>
            </span>
            <a href={href.caseRun(r.id)} className="font-medium text-info hover:underline">View findings</a>
          </li>
        ))}
      </ul>
    </details>
  );
}
