// One analysis: a check of two sessions of one witness. While it runs, what is happening; if it
// stopped, why; when it's done, the findings bar and the open finding at full width below it.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";
import { CheckAgain } from "../components/CheckAgain";
import { FindingPanel } from "../components/FindingPanel";
import { EMPTY, FindingBar, GROUPS } from "../components/FindingRegister";
import { Alert, Badge, Button, buttonClass, Loading, PageHeader } from "../components/ui";
import { api } from "../lib/api";
import { isActive } from "../lib/insights";
import { ANALYSIS_STATUS, DISCOVERY_ATTEMPT, formatDate, formatUsd, GROUP_LABEL } from "../lib/labels";
import { href, usePoll } from "../lib/router";
import type { AnalysisView, CaseDetail, DiscoveryView, EvidenceCoverage, FindingGroup, FindingGroups, NotStoredFinding } from "../types";
import { CheckProgress } from "../components/CheckProgress";
import { ANALYSIS_TOUR, Tour } from "../components/Tour";

const GUIDE_KEY = "veridict.reviewGuideSeen";

export function AnalysisPage({ id, findingId }: { id: number; findingId: number | null }) {
  const [analysis, setAnalysis] = useState<AnalysisView | null>(null);
  const [groups, setGroups] = useState<FindingGroups | null>(null);
  const [caseDetail, setCaseDetail] = useState<CaseDetail | null>(null);
  const caseName = caseDetail?.case.name ?? null;
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
    api.case(caseId).then(setCaseDetail).catch(() => undefined);
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
  // The review guide starts by itself the first time a finished analysis with findings opens.
  // shortcut: remembered per browser, so it shows once more on a new device; store it on the account if that matters.
  const [guiding, setGuiding] = useState(false);
  const reviewable = analysis?.status === "completed" && findings.length > 0;
  useEffect(() => {
    if (!reviewable) return;
    let seen = true;
    try {
      seen = localStorage.getItem(GUIDE_KEY) !== null;
    } catch {
      // storage blocked: don't start a guide that can't be marked as seen
    }
    if (seen) return;
    const t = window.setTimeout(() => setGuiding(true), 700);
    return () => window.clearTimeout(t);
  }, [reviewable]);
  const endGuide = () => {
    setGuiding(false);
    try {
      localStorage.setItem(GUIDE_KEY, "1");
    } catch {
      // nothing to remember it in
    }
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
            {!done && <> · {active ? "check running" : ANALYSIS_STATUS[analysis.status].label}</>}
          </>
        }
        actions={done ? (
          <>
            <a href={api.reportPdf(analysis.caseId, [analysis.id])} download data-tour="finding-export" className={buttonClass("secondary")} title="The findings you kept in this analysis, with citations and your notes"><Download aria-hidden className="size-4" />Download report</a>
            <CheckAgain caseId={analysis.caseId} a={a.id} b={b.id} />
          </>
        ) : undefined}
      />
      {analysis.mode === "demo" && <Alert tone="info">This is an example analysis. No model was called for it.</Alert>}
      {active && <CheckProgress analysis={analysis} pages={pagesOf(caseDetail, analysis)} lines={null} onCancel={() => api.cancel(analysis.id).then(load).catch((e: Error) => setError(e.message))} />}
      {!done && !active && <Progress analysis={analysis} onResume={(budget) => api.resume(analysis.id, budget).then(load).catch((e: Error) => setError(e.message))} onCancel={() => api.cancel(analysis.id).then(load).catch((e: Error) => setError(e.message))} />}
      {done && analysis.evidence && <CoverageAlert evidence={analysis.evidence} depositions={analysis.depositions} />}
      {analysis.discovery?.usedFallback && done && <Alert tone="warn" title="The first reading couldn't finish this check">A second reading produced these findings. They were verified the same way.</Alert>}

      {groups && (done || findings.length > 0) && (
        <div>
          <FindingBar findings={findings} analysisId={id} selected={shownId} group={group} onGroup={chooseGroup} onHelp={() => setGuiding(true)} />
          {shownId !== null ? (
            <FindingPanel key={shownId} id={shownId} analysisId={id} next={next} onDecided={onDecided} />
          ) : (
            <p className="rounded-lg border border-dashed border-control px-6 py-16 text-center text-sm text-muted">{GROUP_LABEL[group]}: {EMPTY[group]}</p>
          )}
        </div>
      )}
      {done && !groups && <Loading label="Loading findings" />}
      {(groups?.notStored?.length ?? 0) > 0 && <NotStored items={groups!.notStored!} />}
      {done && analysis.evidence && <WhatItReceived evidence={analysis.evidence} depositions={analysis.depositions} />}
      {!active && analysis.discovery && analysis.discovery.attempts.length > 0 && <HowItRan discovery={analysis.discovery} cost={analysis.cost.actualUsd} />}
      {guiding && reviewable && <Tour steps={ANALYSIS_TOUR} onDone={endGuide} />}
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
            <span><span className="font-semibold">{a.modelName}</span>: {DISCOVERY_ATTEMPT[a.status] ?? a.status}{a.error ? `. ${a.error}` : ""}</span>
            <span className="text-xs text-faint tabular-nums">{[a.costUsd !== null ? formatUsd(a.costUsd) : null, a.latencyMs !== null ? seconds(a.latencyMs) : null].filter(Boolean).join(" · ")}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

type Sessions = AnalysisView["depositions"];
const sessionName = (depositions: Sessions, id: number) => {
  const d = depositions.find((x) => x.id === id);
  return d ? `Session of ${formatDate(d.takenOn)}` : `Deposition #${id}`;
};

// Shown above the findings whenever this check didn't receive all of the testimony, or the model said
// its review was partial: the findings can't speak for what wasn't there.
function CoverageAlert({ evidence, depositions }: { evidence: EvidenceCoverage; depositions: Sessions }) {
  const missing = evidence.sessions.map((s) => ({ s, notes: s.notes })).filter((x) => x.notes.length > 0);
  const partial = evidence.model?.completionStatus === "partial";
  if (missing.length === 0 && !partial) return null;
  return (
    <Alert tone="warn" title="This check didn't cover all of the testimony">
      <ul className="list-disc space-y-0.5 pl-5">
        {missing.flatMap(({ s, notes }) => notes.map((n) => <li key={`${s.depositionId}-${n}`}>{sessionName(depositions, s.depositionId)}: {n}</li>))}
        {partial && <li>The model reported that its review was partial. Its reasons are under “What this check received”.</li>}
      </ul>
      <p className="mt-1">No finding speaks for testimony the check didn't receive.</p>
    </Alert>
  );
}

function WhatItReceived({ evidence, depositions }: { evidence: EvidenceCoverage; depositions: Sessions }) {
  const limitations = evidence.model?.limitations ?? [];
  return (
    <details className="rounded-lg border border-line bg-sheet text-sm print:hidden">
      <summary className="cursor-pointer px-5 py-3.5 font-semibold">What this check received</summary>
      <div className="space-y-4 border-t border-rule px-5 py-4">
        <section>
          <h3 className="font-semibold">Checked by Veridict</h3>
          <ul className="mt-1 space-y-1.5">
            {evidence.sessions.map((s) => {
              const notes = s.notes;
              return (
                <li key={s.depositionId}>
                  <span className="font-medium">{sessionName(depositions, s.depositionId)}</span>: <span className="tabular-nums">{s.linesSent.toLocaleString()}</span> lines sent{s.pageCount !== null && <>, from a {s.pageCount}-page file</>}.{" "}
                  {notes.length > 0 ? notes.join(" ") : s.numbered ? "No pages missing." : "Its lines aren't numbered by the transcript, so missing passages can't be detected."}
                  {s.lineSkips.length > 0 && <span className="text-muted"> Line numbers skip in {s.lineSkips.length} {s.lineSkips.length === 1 ? "place" : "places"} within a page, usually blank lines.</span>}
                </li>
              );
            })}
          </ul>
        </section>
        <section>
          <h3 className="font-semibold">Reported by the model</h3>
          {evidence.model === null ? (
            <p className="mt-1 text-muted">The model gave no answer, so it reported nothing.</p>
          ) : (
            <>
              <p className="mt-1">{evidence.model.completionStatus === "complete" ? "It said it considered all the testimony it was given." : "It said its review was partial."}{limitations.length === 0 && " It reported no limitations."}</p>
              {limitations.length > 0 && <ul className="mt-1 list-disc space-y-1 pl-5">{limitations.map((l) => <li key={l}>{l}</li>)}</ul>}
              <p className="mt-1.5 text-xs text-faint">The model's own account, not checked by Veridict.</p>
            </>
          )}
        </section>
      </div>
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

// Pages in the two sessions of a check, once both are known.
const pagesOf = (detail: CaseDetail | null, a: AnalysisView) => {
  const counts = a.depositions.map((d) => detail?.depositions.find((x) => x.id === d.id)?.pageCount ?? null);
  return counts.every((c) => c !== null) ? counts.reduce((n, c) => n! + c!, 0) : null;
};

function Progress({ analysis, onResume }: { analysis: AnalysisView; onResume: (budget?: number) => void; onCancel: () => void }) {
  if (!isActive(analysis.status)) {
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
  return null;
}
