// The overview of one analysis: what ran, how much of it was assessed, and every finding. Opening a
// finding goes to the workbench.

import { useCallback, useEffect, useMemo, useState } from "react";
import { CircleDollarSign, GitCompareArrows, Hourglass, Plus, ScanSearch, ShieldCheck } from "lucide-react";
import { FindingRegister } from "../components/FindingRegister";
import { Alert, Badge, Button, buttonClass, Card, cx, Empty, Loading, Metric, ModelMark, PageHeader } from "../components/ui";
import { api } from "../lib/api";
import { ACTIVE_STATUSES, candidateCoverage, isActive } from "../lib/insights";
import { ANALYSIS_STATUS, DISCOVERY_ATTEMPT, formatDate, formatUsd } from "../lib/labels";
import { href, usePoll } from "../lib/router";
import type { AnalysisView, DiscoveryView, FindingGroups, NotStoredFinding } from "../types";

const ACTIVE: string[] = ACTIVE_STATUSES;

export function AnalysisPage({ id }: { id: number }) {
  const [analysis, setAnalysis] = useState<AnalysisView | null>(null);
  const [groups, setGroups] = useState<FindingGroups | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.analysis(id).then((r) => setAnalysis(r.analysis)).catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  const active = !!analysis && isActive(analysis.status);
  usePoll(active, 2000, load);
  // Findings are fetched again whenever their count changes, so new ones appear while it runs.
  const total = analysis?.findings.total;
  useEffect(() => {
    if (total === undefined) return;
    api.findings(id).then(setGroups).catch((e: Error) => setError(e.message));
  }, [id, total]);
  const findings = useMemo(() => groups?.groups.flatMap((g) => g.findings).map((f) => ({ ...f, analysisId: id })) ?? [], [groups, id]);

  if (error) return <Alert title="This analysis couldn't be loaded">{error}</Alert>;
  if (!analysis) return <Loading />;
  const [a, b] = analysis.depositions;
  const coverage = candidateCoverage(analysis.progress);
  const direct = analysis.discovery;
  const s = direct && analysis.status === "adjudicating" ? { label: "Reading both sessions", tone: "active" as const } : ANALYSIS_STATUS[analysis.status];

  return (
    <>
      <PageHeader
        above={
          <div className="flex flex-wrap items-center gap-space-xs text-label-md text-on-surface-variant">
            <a href={href.analyses()} className="hover:text-secondary">Analyses</a>
            <span aria-hidden className="text-outline-variant">/</span>
            <a href={href.case(analysis.caseId)} className="hover:text-secondary">Case</a>
            <span aria-hidden className="text-outline-variant">•</span>
            <span>Witness: {a.witness}</span>
          </div>
        }
        title="Cross-session analysis"
        description={`Session A: ${formatDate(a.takenOn)}${a.originalFilename ? ` (${a.originalFilename})` : ""} · Session B: ${formatDate(b.takenOn)}${b.originalFilename ? ` (${b.originalFilename})` : ""}`}
        actions={
          <>
            <Badge tone={s.tone} dot>{s.label}</Badge>
            {analysis.mode === "demo" && <Badge tone="accent" title="No model was called for this analysis">Demo: no model calls</Badge>}
            <a href={href.case(analysis.caseId)} className={buttonClass("primary")}><Plus aria-hidden className="size-4" />New analysis</a>
          </>
        }
      />

      <Card className="flex items-start gap-space-md p-space-md">
        <span className="flex size-9 flex-none items-center justify-center rounded-lg bg-surface-container-high text-secondary"><ShieldCheck aria-hidden className="size-5" /></span>
        <div>
          <p className="font-semibold">How to read these results</p>
          <p className="text-body-sm text-on-surface-variant">Quotations are stored transcript lines. Code checks each citation{direct ? "" : " and calculates each score"}. The category and explanation are <ModelMark>model interpretation</ModelMark> and need a person's review.</p>
        </div>
      </Card>

      {direct ? <DiscoveryPanel discovery={direct} /> : <div className="grid gap-space-md sm:grid-cols-2 xl:grid-cols-4">
        <Metric icon={GitCompareArrows} value={coverage.total.toLocaleString()} label="Candidate pairs" note="Found across both sessions" />
        <Metric icon={ScanSearch} value={coverage.assessed.toLocaleString()} label="Assessed" note={`${analysis.progress.replayed ?? 0} stored · ${analysis.progress.fixture ?? 0} examples · ${analysis.progress.adjudicated ?? 0} live`} />
        <Metric icon={Hourglass} value={(coverage.unassessed + coverage.deferred).toLocaleString()} label="Not assessed" note={`${coverage.unassessed.toLocaleString()} unassessed · ${coverage.deferred.toLocaleString()} deferred`} />
        <Metric icon={CircleDollarSign} value={analysis.mode === "demo" ? "$0.00" : formatUsd(analysis.cost.actualUsd)} label="Model cost" note={analysis.mode === "demo" ? "Demo: no model calls" : `${analysis.cost.calls} calls of a ${formatUsd(analysis.cost.budgetUsd)} budget`} />
      </div>}

      <Progress analysis={analysis} onResume={(budget) => api.resume(analysis.id, budget).then(load).catch((e: Error) => setError(e.message))} onCancel={() => api.cancel(analysis.id).then(load).catch((e: Error) => setError(e.message))} />

      {groups && analysis.findings.total === 0 && !active && (
        <Empty title="No findings to review">
          {analysis.mode === "demo"
            ? "This demo analysis had no stored assessments for the candidate pairs it found. Run a live analysis, with a budget, to assess them."
            : direct ? "The model reported nothing to review. That is its reading of these two sessions, not proof that they agree." : "No candidate pair produced a finding."}
        </Empty>
      )}
      {groups && analysis.findings.total > 0 && (
        <section className="space-y-space-md">
          <h2 className="text-headline-lg">Findings</h2>
          <FindingRegister findings={findings} emptyTitle="No findings to review" />
        </section>
      )}
      {!groups && analysis.findings.total > 0 && <Loading label="Loading findings…" />}
      {(groups?.notStored?.length ?? 0) > 0 && <NotStored items={groups!.notStored!} />}
    </>
  );
}

const seconds = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

// Which model these results are from, and what happened to every paid attempt.
function DiscoveryPanel({ discovery }: { discovery: DiscoveryView }) {
  return (
    <Card className="p-space-md">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-headline-md">{discovery.resultModelName ? `Findings proposed by ${discovery.resultModelName}` : "Direct analysis of both full sessions"}</h2>
        <ModelMark />
      </div>
      {discovery.usedFallback && <div className="mt-space-sm"><Alert tone="warn" title="The primary model refused">These findings come from the fallback model, not the primary one.</Alert></div>}
      {discovery.attempts.length === 0 ? (
        <p className="mt-1 text-body-sm text-on-surface-variant">Nothing has been sent yet.</p>
      ) : (
        <ul className="mt-space-sm space-y-1 text-body-sm">
          {discovery.attempts.map((a) => (
            <li key={a.attempt} className="flex flex-wrap items-baseline justify-between gap-x-space-md gap-y-0.5">
              <span><span className="font-semibold">{a.modelName}</span>{a.role === "fallback" ? " (fallback)" : ""}: {DISCOVERY_ATTEMPT[a.status] ?? a.status}{a.error ? `. ${a.error}` : ""}</span>
              <span className="text-label-sm text-on-surface-variant tabular-nums">{[a.costUsd !== null ? formatUsd(a.costUsd) : null, a.latencyMs !== null ? seconds(a.latencyMs) : null].filter(Boolean).join(" · ")}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function NotStored({ items }: { items: NotStoredFinding[] }) {
  return (
    <section className="space-y-space-sm">
      <h2 className="text-headline-lg">Proposals that couldn't be checked</h2>
      <p className="text-body-sm text-on-surface-variant">Their citations don't match any stored line, so there is no testimony to show. They are listed so nothing is hidden. Treat them as unverified.</p>
      <Card>
        <ul>
          {items.map((n) => (
            <li key={n.findingId} className="border-t border-surface-container-low p-space-md text-body-sm first:border-t-0">
              <p className="font-mono text-label-md font-normal">A {n.citationA} · B {n.citationB}</p>
              <p className="mt-1">{n.explanation}</p>
              <p className="mt-1 text-label-sm text-on-surface-variant">Proposed by {n.modelName}. {n.reasons.join(" ")}</p>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

function Progress({ analysis, onResume, onCancel }: { analysis: AnalysisView; onResume: (budget?: number) => void; onCancel: () => void }) {
  const p = analysis.progress;
  const order = ["parsing", "retrieving", "adjudicating", "completed"];
  const reached = (stage: string) => {
    const at = analysis.status === "queued" ? -1 : order.indexOf(ACTIVE.includes(analysis.status) ? analysis.status : "completed");
    return at >= order.indexOf(stage);
  };
  const stopped = ["failed", "blocked_budget", "blocked_credentials", "cancelled", "interrupted"].includes(analysis.status);
  const assessed = (p.adjudicated ?? 0) + (p.replayed ?? 0) + (p.fixture ?? 0);
  const directSteps = analysis.discovery !== null;
  const steps = directSteps ? [
    { key: "parsing", title: "Read both depositions", detail: analysis.status === "queued" ? "Waiting to start." : "Both transcripts stored." },
    { key: "adjudicating", title: "Read both sessions whole", detail: "One model reads all the testimony and proposes possible inconsistencies. This usually takes minutes, and can take longer." },
    { key: "completed", title: "Check every citation", detail: analysis.status === "completed" ? `${analysis.findings.total} findings: ${analysis.findings.groups.contradictions} potential contradictions, ${analysis.findings.groups.needs_context} need context, ${analysis.findings.groups.unverified} unverified.` : "Not started." },
  ] : [
    { key: "parsing", title: "Read both depositions", detail: analysis.status === "queued" ? "Waiting to start." : analysis.depositions.every((d) => d.status === "ready") ? "Both transcripts are read." : "Waiting for the transcripts to be read." },
    { key: "retrieving", title: "Find candidate passages", detail: p.candidates ? `${p.candidates.selected} pairs selected for assessment${p.candidates.deferred ? `, ${p.candidates.deferred} lower-ranked pairs held back` : ""}.` : "Searching both sessions for related testimony." },
    {
      key: "adjudicating",
      title: "Assess each pair",
      detail: p.candidates
        ? analysis.mode === "demo"
          ? `${assessed} of ${p.candidates.selected} pairs have a stored assessment (${p.replayed ?? 0} from earlier model runs, ${p.fixture ?? 0} prepared examples); ${p.withoutVerdict ?? 0} have none.`
          : `${assessed} of ${p.candidates.selected} pairs assessed${p.failed ? `, ${p.failed} calls failed` : ""}.`
        : "Not started.",
    },
    { key: "completed", title: "Findings ready", detail: `${analysis.findings.total} findings: ${analysis.findings.groups.contradictions} potential contradictions, ${analysis.findings.groups.needs_context} need context, ${analysis.findings.groups.compatible} compatible, ${analysis.findings.groups.unverified} unverified.` },
  ];
  return (
    <Card>
      <h2 className="sr-only">Progress</h2>
      <ol className={cx("grid gap-space-md p-space-md sm:grid-cols-2", directSteps ? "xl:grid-cols-3" : "xl:grid-cols-4")}>
        {steps.map((s) => {
          const done = reached(s.key) && (analysis.status === "completed" || order.indexOf(s.key) < order.indexOf(analysis.status));
          const current = analysis.status === s.key;
          return (
            <li key={s.key} className="rounded-lg bg-surface-container-low px-space-md py-3">
              <p className={cx("text-label-sm font-semibold", done ? "text-success" : current ? "text-secondary" : "text-on-surface-variant")}>
                {done ? "Done" : current ? "In progress" : stopped && reached(s.key) ? "Stopped" : "Pending"}
              </p>
              <p className="mt-0.5 font-semibold">{s.title}</p>
              <p className="mt-0.5 text-label-sm text-on-surface-variant">{s.detail}</p>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center justify-between gap-3 px-space-md pb-space-md text-label-sm text-on-surface-variant">
        <span>
          {analysis.mode === "live"
            ? `Model calls: ${analysis.cost.calls} · cost ${formatUsd(analysis.cost.actualUsd)} of a ${formatUsd(analysis.cost.budgetUsd)} budget`
            : "Demo mode: no model calls, no cost."}
        </span>
        <span className="flex items-center gap-3">
          {analysis.mode === "live" && ACTIVE.includes(analysis.status) && (
            <Button variant="secondary" onClick={onCancel} disabled={analysis.cancelRequested}>
              {analysis.cancelRequested ? "Stopping…" : "Stop analysis"}
            </Button>
          )}
          Updated {new Date(analysis.updatedAt).toLocaleTimeString()}
        </span>
      </div>
      {analysis.error && (
        <div className="space-y-3 px-space-md pb-space-md">
          <Alert tone={analysis.status === "failed" ? "bad" : "warn"} title={ANALYSIS_STATUS[analysis.status].label}>
            {analysis.error}
          </Alert>
          {stopped && analysis.resumable && (
            <div className="flex flex-wrap gap-2">
              {analysis.status === "blocked_budget" && <Button variant="secondary" onClick={() => onResume(analysis.cost.budgetUsd + 1)}>Raise budget by $1 and continue</Button>}
              {analysis.resumable && <Button variant="secondary" onClick={() => onResume()}>
                {analysis.status === "failed" ? "Try again" : "Retry"}
              </Button>}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
