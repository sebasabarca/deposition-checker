// One analysis: a check of two sessions of one witness. While it runs, what is happening; if it
// stopped, why; when it's done, the findings bar and the open finding at full width below it.

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckAgain } from "../components/CheckAgain";
import { FindingPanel } from "../components/FindingPanel";
import { EMPTY, FindingBar, GROUPS } from "../components/FindingRegister";
import { Alert, Badge, Button, buttonClass, cx, Loading, PageHeader } from "../components/ui";
import { api } from "../lib/api";
import { isActive } from "../lib/insights";
import { ANALYSIS_STATUS, DISCOVERY_ATTEMPT, formatDate, formatUsd, GROUP_LABEL } from "../lib/labels";
import { href, usePoll } from "../lib/router";
import type { AnalysisView, DiscoveryView, FindingGroup, FindingGroups, NotStoredFinding } from "../types";

export function AnalysisPage({ id, findingId }: { id: number; findingId: number | null }) {
  const [analysis, setAnalysis] = useState<AnalysisView | null>(null);
  const [groups, setGroups] = useState<FindingGroups | null>(null);
  const [caseName, setCaseName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosenGroup, setChosenGroup] = useState<FindingGroup | null>(null);
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

  // The open finding decides the tab; with none open, the chosen tab, else the first non-empty one.
  const open = findings.find((f) => f.id === findingId);
  const group = open?.group ?? chosenGroup ?? GROUPS.find((g) => findings.some((f) => f.group === g)) ?? "contradictions";
  const inGroup = findings.filter((f) => f.group === group);
  const shownId = open?.id ?? (findingId === null ? (inGroup[0]?.id ?? null) : findingId);
  const next = inGroup[inGroup.findIndex((f) => f.id === shownId) + 1]?.id;
  const chooseGroup = (g: FindingGroup) => {
    setChosenGroup(g);
    const first = findings.find((f) => f.group === g);
    window.location.hash = href.analysis(id, first?.id);
  };
  const onDecided = useCallback((fid: number, state: string) => {
    setGroups((g) => g && { ...g, groups: g.groups.map((x) => ({ ...x, findings: x.findings.map((f) => (f.id === fid ? { ...f, reviewState: state } : f)) })) });
  }, []);

  if (error) return <Alert title="This analysis couldn't be loaded">{error}</Alert>;
  if (!analysis) return <Loading />;
  const [a, b] = analysis.depositions;
  const done = analysis.status === "completed";
  const decided = findings.filter((f) => f.reviewState !== "unreviewed").length;

  return (
    <>
      <PageHeader
        title={<>{a.witness}<span className="font-normal text-muted">: {formatDate(a.takenOn)} and {formatDate(b.takenOn)}</span></>}
        description={
          <>
            {caseName && <a href={href.case(analysis.caseId)} className="font-medium text-ink hover:underline">{caseName}</a>}
            {done && <> · checked {formatDate(analysis.finishedAt ?? analysis.createdAt)} · {findings.length} {findings.length === 1 ? "finding" : "findings"} · {decided} decided</>}
            {!done && <> · {ANALYSIS_STATUS[analysis.status].label}</>}
          </>
        }
        actions={done ? <CheckAgain caseId={analysis.caseId} a={a.id} b={b.id} /> : undefined}
      />
      {analysis.mode === "demo" && <Alert tone="info">This is an example analysis. No model was called for it.</Alert>}
      {!done && <Progress analysis={analysis} onResume={(budget) => api.resume(analysis.id, budget).then(load).catch((e: Error) => setError(e.message))} onCancel={() => api.cancel(analysis.id).then(load).catch((e: Error) => setError(e.message))} />}
      {analysis.discovery?.usedFallback && done && <Alert tone="warn" title="The primary model declined this check">A backup model, {analysis.discovery.resultModelName}, produced these findings.</Alert>}

      {groups && (done || findings.length > 0) && (
        <div>
          <FindingBar findings={findings} analysisId={id} selected={shownId} group={group} onGroup={chooseGroup} />
          {shownId !== null ? (
            <FindingPanel key={shownId} id={shownId} analysisId={id} next={next} onDecided={onDecided} />
          ) : (
            <p className="rounded-lg border border-dashed border-control px-6 py-16 text-center text-sm text-muted">{GROUP_LABEL[group]}: {EMPTY[group]}</p>
          )}
        </div>
      )}
      {done && !groups && <Loading label="Loading findings" />}
      {(groups?.notStored?.length ?? 0) > 0 && <NotStored items={groups!.notStored!} />}
      {analysis.discovery && analysis.discovery.attempts.length > 0 && <HowItRan discovery={analysis.discovery} cost={analysis.cost.actualUsd} />}
    </>
  );
}

const seconds = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

function HowItRan({ discovery, cost }: { discovery: DiscoveryView; cost: number }) {
  return (
    <details className="rounded-lg border border-line bg-sheet text-sm print:hidden">
      <summary className="cursor-pointer px-5 py-3.5 font-semibold">How this check ran <span className="font-normal text-muted">· {formatUsd(cost)}</span></summary>
      <ul className="divide-y divide-rule border-t border-rule">
        {discovery.attempts.map((a) => (
          <li key={a.attempt} className="flex flex-wrap items-baseline justify-between gap-x-4 px-5 py-2.5">
            <span><span className="font-semibold">{a.modelName}</span>{a.role === "fallback" ? " (backup)" : ""}: {DISCOVERY_ATTEMPT[a.status] ?? a.status}{a.error ? `. ${a.error}` : ""}</span>
            <span className="text-xs text-faint tabular-nums">{[a.costUsd !== null ? formatUsd(a.costUsd) : null, a.latencyMs !== null ? seconds(a.latencyMs) : null].filter(Boolean).join(" · ")}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function NotStored({ items }: { items: NotStoredFinding[] }) {
  return (
    <section className="rounded-lg border border-dashed border-control bg-sheet">
      <div className="border-b border-rule px-5 py-3.5">
        <h2 className="text-md font-semibold">Proposals that couldn't be checked <span className="font-normal text-faint tabular-nums">{items.length}</span></h2>
        <p className="mt-0.5 text-sm text-muted">Their citations match no stored line, so there is no testimony to show. Listed so nothing is hidden; treat them as unverified.</p>
      </div>
      <ul className="divide-y divide-rule">
        {items.map((n) => (
          <li key={n.findingId} className="px-5 py-3 text-sm">
            <p className="font-mono text-[13px]">{n.citationA} · {n.citationB}</p>
            <p className="mt-1">{n.explanation}</p>
            <p className="mt-1 text-xs text-faint">Proposed by {n.modelName}. {n.reasons.join(" ")}</p>
          </li>
        ))}
      </ul>
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
  if (!running) {
    return (
      <Alert
        tone={analysis.status === "failed" ? "bad" : "warn"}
        title={ANALYSIS_STATUS[analysis.status].label}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{formatUsd(analysis.cost.actualUsd)} spent</Badge>
            {analysis.status === "blocked_budget" && <Button onClick={() => onResume(analysis.cost.budgetUsd + 1)}>Raise budget by $1 and continue</Button>}
            {analysis.status !== "blocked_budget" && analysis.resumable && <Button onClick={() => onResume()}>Continue</Button>}
            {!analysis.resumable && <a href={href.case(analysis.caseId)} className={buttonClass("primary")}>Start a new check</a>}
          </div>
        }
      >
        {analysis.error ?? "This check stopped before it finished."}
      </Alert>
    );
  }
  return (
    <section className="rounded-lg border border-line bg-sheet">
      <ol className="grid divide-rule sm:grid-cols-3 sm:divide-x">
        {STEPS.map((s, i) => (
          <li key={s.key} className="px-5 py-4">
            <p className={cx("flex items-center gap-2 text-xs font-semibold", i < at ? "text-ok" : i === at ? "text-info" : "text-faint")}>
              <span aria-hidden className={cx("size-2 rounded-full", i < at ? "bg-ok" : i === at ? "animate-pulse bg-slate" : "bg-control")} />
              {i < at ? "Done" : i === at ? "In progress" : "Waiting"}
            </p>
            <p className="mt-1 font-medium">{s.title}</p>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-rule px-5 py-3 text-sm text-muted">
        <p>This usually takes about 10 minutes, and can take longer. You can close this page.</p>
        <Button variant="secondary" onClick={onCancel} disabled={analysis.cancelRequested}>{analysis.cancelRequested ? "Stopping…" : "Stop check"}</Button>
      </div>
    </section>
  );
}
