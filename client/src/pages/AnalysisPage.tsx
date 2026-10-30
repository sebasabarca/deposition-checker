import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Card, Empty, Loading, cx } from "../components/ui";
import { FindingView } from "../components/FindingView";
import { api } from "../lib/api";
import { ANALYSIS_STATUS, CLASSIFICATION, formatDate, formatUsd, PRIORITY, scoreLabel } from "../lib/labels";
import { href, usePoll } from "../lib/router";
import type { AnalysisView, FindingGroup, FindingGroups, FindingSummary } from "../types";

const ACTIVE = ["queued", "parsing", "retrieving", "adjudicating"];

export function AnalysisPage({ id, findingId }: { id: number; findingId: number | null }) {
  const [analysis, setAnalysis] = useState<AnalysisView | null>(null);
  const [groups, setGroups] = useState<FindingGroups | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.analysis(id).then((r) => setAnalysis(r.analysis)).catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  const active = !!analysis && ACTIVE.includes(analysis.status);
  usePoll(active, 2000, load);
  // Findings are fetched again whenever their count changes, so new ones appear while it runs.
  const total = analysis?.findings.total;
  useEffect(() => {
    if (total === undefined) return;
    api.findings(id).then(setGroups).catch((e: Error) => setError(e.message));
  }, [id, total]);

  // Open the first finding of the first non-empty section when none is chosen.
  const first = groups?.groups.find((g) => g.findings.length > 0)?.findings[0];
  const selected = findingId ?? first?.id ?? null;
  // On narrow screens the finding is shown below the list: bring it into view when one is chosen.
  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (findingId !== null && window.matchMedia("(max-width: 1279px)").matches) detailRef.current?.scrollIntoView({ block: "start" });
  }, [findingId]);

  if (error) return <Alert title="This analysis couldn't be loaded">{error}</Alert>;
  if (!analysis) return <Loading />;
  const [a, b] = analysis.depositions;

  return (
    <div className="space-y-5">
      <div>
        <a href={href.case(analysis.caseId)} className="text-sm text-slate-600 hover:text-slate-900">← Case</a>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{a.witness}</h1>
          <Badge tone={ANALYSIS_STATUS[analysis.status].tone}>{ANALYSIS_STATUS[analysis.status].label}</Badge>
          {analysis.mode === "demo" && <Badge tone="accent" title="No model was called for this analysis">Demo: no model calls</Badge>}
        </div>
        <p className="text-sm text-slate-600">
          Session A: {formatDate(a.takenOn)}
          {a.originalFilename ? ` (${a.originalFilename})` : ""} · Session B: {formatDate(b.takenOn)}
          {b.originalFilename ? ` (${b.originalFilename})` : ""}
        </p>
      </div>

      <Progress analysis={analysis} onResume={(budget) => api.resume(analysis.id, budget).then(load).catch((e: Error) => setError(e.message))} onCancel={() => api.cancel(analysis.id).then(load).catch((e: Error) => setError(e.message))} />

      {groups && analysis.findings.total === 0 && !active && (
        <Empty title="No findings to review">
          {analysis.mode === "demo"
            ? "This demo analysis had no stored assessments for the candidate pairs it found. Run a live analysis, with a budget, to assess them."
            : "No candidate pair produced a finding."}
        </Empty>
      )}

      {groups && analysis.findings.total > 0 && (
        <div className="grid gap-5 xl:grid-cols-[22rem_1fr]">
          <FindingList groups={groups} analysisId={analysis.id} selected={selected} />
          <div ref={detailRef} className="min-w-0 scroll-mt-4">{selected !== null ? <FindingView key={selected} id={selected} /> : <Empty title="Choose a finding" />}</div>
        </div>
      )}
      {!groups && analysis.findings.total > 0 && <Loading label="Loading findings…" />}
    </div>
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
  const steps = [
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
    { key: "completed", title: "Findings ready", detail: `${analysis.findings.total} findings: ${analysis.findings.groups.contradictions} potential contradictions, ${analysis.findings.groups.compatible} likely compatible, ${analysis.findings.groups.insufficient} insufficient evidence, ${analysis.findings.groups.review} for your review.` },
  ];
  return (
    <Card>
      <ol className="grid gap-px overflow-hidden rounded-lg bg-slate-100 sm:grid-cols-4">
        {steps.map((s, i) => {
          const done = reached(s.key) && (analysis.status === "completed" || order.indexOf(s.key) < order.indexOf(analysis.status));
          const current = analysis.status === s.key;
          return (
            <li key={s.key} className="bg-white px-4 py-3">
              <p className={cx("text-xs font-semibold uppercase tracking-wide", done ? "text-emerald-700" : current ? "text-sky-700" : "text-slate-400")}>
                Step {i + 1} · {done ? "Done" : current ? "In progress" : stopped && reached(s.key) ? "Stopped" : "Pending"}
              </p>
              <p className="mt-0.5 text-sm font-medium text-slate-900">{s.title}</p>
              <p className="mt-0.5 text-xs text-slate-600">{s.detail}</p>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-xs text-slate-600">
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
        <div className="space-y-3 border-t border-slate-100 p-4">
          <Alert tone={analysis.status === "failed" ? "bad" : "warn"} title={ANALYSIS_STATUS[analysis.status].label}>
            {analysis.error}
          </Alert>
          {stopped && (
            <div className="flex flex-wrap gap-2">
              {analysis.status === "blocked_budget" && <Button variant="secondary" onClick={() => onResume(analysis.cost.budgetUsd + 1)}>Raise budget by $1 and continue</Button>}
              <Button variant="secondary" onClick={() => onResume()}>
                {analysis.status === "failed" ? "Try again" : "Retry"}
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

const GROUP_HELP: Record<FindingGroup, string> = {
  contradictions: "Verified passages the assessment treats as conflicting. Each still needs your judgement.",
  compatible: "Passages that look related but can both be true. Shown so nothing is hidden.",
  insufficient: "The two passages alone don't allow a judgement.",
  review: "Couldn't be scored: an unverified quotation, a self-contradictory assessment, or missing context.",
};

function FindingList({ groups, analysisId, selected }: { groups: FindingGroups; analysisId: number; selected: number | null }) {
  return (
    <nav aria-label="Findings" className="space-y-4">
      {groups.groups.map((g) => (
        <Card key={g.group}>
          <div className="border-b border-slate-100 px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-900">{g.label}</h2>
              <Badge tone={g.group === "contradictions" ? "contradiction" : "neutral"}>{g.findings.length}</Badge>
            </div>
            <p className="mt-0.5 text-xs text-slate-500">{GROUP_HELP[g.group]}</p>
          </div>
          {g.findings.length === 0 ? (
            <p className="px-4 py-3 text-xs text-slate-400">None.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {g.findings.map((f) => (
                <FindingItem key={f.id} f={f} href={href.analysis(analysisId, f.id)} active={f.id === selected} />
              ))}
            </ul>
          )}
        </Card>
      ))}
    </nav>
  );
}

function FindingItem({ f, href: link, active }: { f: FindingSummary; href: string; active: boolean }) {
  return (
    <li>
      <a href={link} aria-current={active ? "true" : undefined} className={cx("block px-4 py-3 hover:bg-slate-50", active && "bg-indigo-50/60 ring-1 ring-inset ring-indigo-200")}>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium text-slate-900">{CLASSIFICATION[f.classification]}</span>
          {f.priority !== "low" && <Badge tone={f.priority === "high" ? "contradiction" : f.priority === "needs_context" ? "warn" : "neutral"}>{PRIORITY[f.priority]}</Badge>}
          {f.source !== "model" && <Badge tone="accent">{f.source === "fixture" ? "Example" : "Stored"}</Badge>}
        </div>
        <p className="mt-1 text-xs text-slate-600">
          A {f.a.ref ?? "?"} ↔ B {f.b.ref ?? "?"} · {scoreLabel(f)}
        </p>
        <p className="mt-1 line-clamp-2 text-xs text-slate-500">{f.explanation}</p>
      </a>
    </li>
  );
}
