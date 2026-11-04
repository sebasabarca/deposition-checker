// "Analyze case" in the case page's header, and the hand-authored example analysis of the sample case.
// The real whole-case analysis is the panel in components/CaseRuns.tsx; the button takes you there.

import { useEffect, useState } from "react";
import { WHOLE_CASE_PANEL } from "./CaseRuns";
import { ScanSearch } from "lucide-react";
import { Button, buttonClass, Card, CardHeader } from "./ui";
import { api } from "../lib/api";
import { href } from "../lib/router";
import type { CaseAnalysisView, CaseDetail } from "../types";

// Pairs of ready sessions, across the whole case, and how many a finished analysis already compared.
export function casePairs(detail: Pick<CaseDetail, "depositions" | "analyses" | "witnesses">) {
  const ready = detail.depositions.filter((d) => d.status === "ready");
  const witnesses = new Set(ready.map((d) => d.witnessId));
  const key = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const checked = new Set(detail.analyses.filter((a) => a.status === "completed").map((a) => key(a.depositionA, a.depositionB)));
  let total = 0, done = 0, crossWitness = 0;
  for (let i = 0; i < ready.length; i++) for (let j = i + 1; j < ready.length; j++) {
    total++;
    if (ready[i].witnessId !== ready[j].witnessId) crossWitness++;
    if (checked.has(key(ready[i].id, ready[j].id))) done++;
  }
  return { sessions: ready.length, witnesses: witnesses.size, total, crossWitness, done };
}

// The page header's way into the whole-case panel (components/CaseRuns.tsx): scrolls to it and moves focus there.
export function AnalyzeCase({ detail }: { detail: CaseDetail }) {
  const p = casePairs(detail);
  const go = () => {
    const panel = document.getElementById(WHOLE_CASE_PANEL);
    panel?.scrollIntoView({ behavior: "smooth", block: "start" });
    panel?.focus({ preventScroll: true });
  };
  return (
    <Button variant="secondary" onClick={go} disabled={p.sessions < 2} title={p.sessions < 2 ? "Needs at least two sessions that have been read" : undefined}>
      <ScanSearch aria-hidden className="size-4" />Analyze case
    </Button>
  );
}

// The case's stored whole-case analysis, if it has one (null when it doesn't; undefined while loading).
export function useCaseAnalysis(caseId: number) {
  const [analysis, setAnalysis] = useState<CaseAnalysisView | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    api.caseAnalysis(caseId).then((r) => live && setAnalysis(r.analysis), () => live && setAnalysis(null));
    return () => { live = false; };
  }, [caseId]);
  return analysis;
}

// The header action: open the stored case analysis when there is one; otherwise the preview of the
// planned whole-case run.
export function CaseAnalysisAction({ caseId, detail, analysis }: { caseId: number; detail: CaseDetail; analysis: CaseAnalysisView | null | undefined }) {
  if (analysis === undefined) return null;
  // No stored analysis: the button for reference; its dialog says the run isn't available yet.
  if (!analysis) return <AnalyzeCase detail={detail} />;
  return <a href={href.caseAnalysis(caseId)} className={buttonClass("secondary")}><ScanSearch aria-hidden className="size-4" />Case analysis</a>;
}

// A one-card summary of the stored case analysis on the case page.
export function CaseAnalysisSummary({ caseId, analysis }: { caseId: number; analysis: CaseAnalysisView | null | undefined }) {
  if (!analysis) return null;
  const c = analysis.coverage, by = c.findings_by_classification;
  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Case analysis"
        description={`Hand-authored example · ${c.pairs_complete} of ${c.unique_pairs_total} session pairs compared, within and across witnesses · no model run`}
        action={<a href={href.caseAnalysis(caseId)} className={buttonClass("primary")}>Open case analysis</a>}
      />
      <dl className="grid grid-cols-3 divide-x divide-rule text-sm">
        {(["incompatible", "uncertain", "compatible"] as const).map((k) => (
          <div key={k} className="px-5 py-3">
            <dt className="text-muted">{k[0].toUpperCase() + k.slice(1)}</dt>
            <dd className="text-xl font-semibold tabular-nums">{by[k] ?? 0}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
