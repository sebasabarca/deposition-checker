// A report: one comparison of two depositions. While it runs, what is happening; if it stopped, why;
// when it's done, the findings.

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckAgain } from "../components/CheckAgain";
import { FindingRegister } from "../components/FindingRegister";
import { Crumbs } from "../components/Shell";
import { Alert, Badge, Button, buttonClass, Card, cx, Loading, PageHeader } from "../components/ui";
import { api } from "../lib/api";
import { isActive } from "../lib/insights";
import { ANALYSIS_STATUS, DISCOVERY_ATTEMPT, formatDate, formatUsd } from "../lib/labels";
import { href, usePoll } from "../lib/router";
import type { AnalysisView, DiscoveryView, FindingGroups, NotStoredFinding } from "../types";

const short = (iso: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "date not stated");

export function AnalysisPage({ id }: { id: number }) {
  const [analysis, setAnalysis] = useState<AnalysisView | null>(null);
  const [groups, setGroups] = useState<FindingGroups | null>(null);
  const [caseName, setCaseName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.analysis(id).then((r) => setAnalysis(r.analysis)).catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  const active = !!analysis && isActive(analysis.status);
  usePoll(active, 3000, load);
  const total = analysis?.findings.total;
  const caseId = analysis?.caseId;
  useEffect(() => {
    if (total === undefined) return;
    api.findings(id).then(setGroups).catch((e: Error) => setError(e.message));
  }, [id, total]);
  useEffect(() => {
    if (caseId === undefined) return;
    api.case(caseId).then((c) => setCaseName(c.case.name)).catch(() => undefined);
  }, [caseId]);
  const findings = useMemo(() => groups?.groups.flatMap((g) => g.findings) ?? [], [groups]);

  if (error) return <Alert title="This report couldn't be loaded">{error}</Alert>;
  if (!analysis) return <Loading />;
  const [a, b] = analysis.depositions;
  const done = analysis.status === "completed";

  return (
    <>
      <Crumbs items={[{ label: "Cases", to: href.cases() }, { label: caseName ?? "Case", to: href.case(analysis.caseId) }, { label: `${a.witness}, ${short(a.takenOn)} vs ${short(b.takenOn)}` }]} />
      <PageHeader
        title={`${a.witness}: ${formatDate(a.takenOn)} vs ${formatDate(b.takenOn)}`}
        description={done ? `Checked ${formatDate(analysis.createdAt)} · ${analysis.findings.total} ${analysis.findings.total === 1 ? "finding" : "findings"} · ${analysis.findings.decided} of ${analysis.findings.total} decided` : undefined}
        actions={done ? <CheckAgain caseId={analysis.caseId} a={a.id} b={b.id} /> : undefined}
      />
      {analysis.mode === "demo" && <Alert tone="info">This is an example report. No model was called for it.</Alert>}
      {!done && <Progress analysis={analysis} onResume={(budget) => api.resume(analysis.id, budget).then(load).catch((e: Error) => setError(e.message))} onCancel={() => api.cancel(analysis.id).then(load).catch((e: Error) => setError(e.message))} />}
      {analysis.discovery?.usedFallback && done && <Alert tone="warn" title="The primary model declined this check">A backup model, {analysis.discovery.resultModelName}, produced these findings.</Alert>}
      {done && <p className="text-body-sm text-on-surface-variant">Findings are leads for your review, not conclusions.</p>}
      {groups && (done || findings.length > 0) && <FindingRegister findings={findings} analysisId={id} />}
      {done && !groups && <Loading label="Loading findings…" />}
      {(groups?.notStored?.length ?? 0) > 0 && <NotStored items={groups!.notStored!} />}
      {analysis.discovery && analysis.discovery.attempts.length > 0 && <HowItRan discovery={analysis.discovery} cost={analysis.cost.actualUsd} />}
    </>
  );
}

const seconds = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

function HowItRan({ discovery, cost }: { discovery: DiscoveryView; cost: number }) {
  return (
    <details className="glass rounded-2xl p-space-md text-body-sm print:hidden">
      <summary className="cursor-pointer font-semibold">How this check ran</summary>
      <ul className="mt-2 space-y-1">
        {discovery.attempts.map((a) => (
          <li key={a.attempt} className="flex flex-wrap items-baseline justify-between gap-x-space-md">
            <span><span className="font-semibold">{a.modelName}</span>{a.role === "fallback" ? " (backup)" : ""}: {DISCOVERY_ATTEMPT[a.status] ?? a.status}{a.error ? `. ${a.error}` : ""}</span>
            <span className="text-label-sm text-on-surface-variant tabular-nums">{[a.costUsd !== null ? formatUsd(a.costUsd) : null, a.latencyMs !== null ? seconds(a.latencyMs) : null].filter(Boolean).join(" · ")}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-on-surface-variant">Total cost {formatUsd(cost)}.</p>
    </details>
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
            <li key={n.findingId} className="border-t border-white/60 p-space-md text-body-sm first:border-t-0">
              <p className="tabular-nums font-medium">A {n.citationA} · B {n.citationB}</p>
              <p className="mt-1">{n.explanation}</p>
              <p className="mt-1 text-label-sm text-on-surface-variant">Proposed by {n.modelName}. {n.reasons.join(" ")}</p>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

const STEPS = [
  { key: "parsing", title: "Read both depositions" },
  { key: "adjudicating", title: "Read both sessions in full" },
  { key: "completed", title: "Check every citation" },
];

function Progress({ analysis, onResume, onCancel }: { analysis: AnalysisView; onResume: (budget?: number) => void; onCancel: () => void }) {
  const running = isActive(analysis.status);
  const at = analysis.status === "queued" ? -1 : analysis.status === "parsing" ? 0 : running ? 1 : -1;
  return (
    <Card className="p-space-lg">
      {running ? (
        <>
          <ol className="grid gap-space-sm sm:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.key} className="rounded-xl bg-white/50 p-space-md">
                <p className={cx("text-label-sm font-semibold", i < at ? "text-success" : i === at ? "text-secondary" : "text-on-surface-variant")}>{i < at ? "Done" : i === at ? "In progress" : "Waiting"}</p>
                <p className="mt-0.5 font-semibold">{s.title}</p>
              </li>
            ))}
          </ol>
          <div className="mt-space-md flex flex-wrap items-center justify-between gap-3 text-body-sm text-on-surface-variant">
            <p>This usually takes about 10 minutes, and can take longer. You can close this page.</p>
            <Button variant="secondary" onClick={onCancel} disabled={analysis.cancelRequested}>{analysis.cancelRequested ? "Stopping…" : "Stop check"}</Button>
          </div>
        </>
      ) : (
        <div className="space-y-3">
          <Alert tone={analysis.status === "failed" ? "bad" : "warn"} title={ANALYSIS_STATUS[analysis.status].label}>{analysis.error ?? "This check stopped before it finished."}</Alert>
          <div className="flex flex-wrap items-center gap-2">
            {analysis.status === "blocked_budget" && <Button onClick={() => onResume(analysis.cost.budgetUsd + 1)}>Raise budget by $1 and continue</Button>}
            {analysis.status !== "blocked_budget" && analysis.resumable && <Button onClick={() => onResume()}>Continue</Button>}
            {!analysis.resumable && <a href={href.case(analysis.caseId)} className={buttonClass("primary")}>Start a new check</a>}
            <Badge>{formatUsd(analysis.cost.actualUsd)} spent</Badge>
          </div>
        </div>
      )}
    </Card>
  );
}
