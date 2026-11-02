// Cross-case views (dashboard, analyses, findings, search). The API serves these per case, so they
// are assembled here. shortcut: one request per case and analysis, replace with a summary endpoint
// when a workspace holds more than a few dozen analyses.

import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { isActive } from "./insights";
import { usePoll } from "./router";
import type { AnalysisView, CaseDetail, CaseSummary, FindingSummary } from "../types";

export type Workspace = { cases: CaseSummary[]; details: CaseDetail[]; analyses: AnalysisView[] };
export type WorkspaceFinding = FindingSummary & { analysis: AnalysisView; caseName: string };

export function useWorkspace() {
  const [data, setData] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const { cases } = await api.cases();
      const details = await Promise.all(cases.map((c) => api.case(c.id)));
      const ids = details.flatMap((d) => d.analyses.map((a) => a.id));
      const analyses = (await Promise.all(ids.map((id) => api.analysis(id)))).map((r) => r.analysis);
      setData({ cases, details, analyses: analyses.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) });
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => void load(), [load]);
  usePoll(!!data && data.analyses.some((a) => isActive(a.status)), 3000, load);
  return { data, error };
}

export function useWorkspaceFindings(w: Workspace | null) {
  const [findings, setFindings] = useState<WorkspaceFinding[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!w) return;
    const withFindings = w.analyses.filter((a) => a.findings.total > 0);
    Promise.all(
      withFindings.map(async (a) => {
        const { groups } = await api.findings(a.id);
        const caseName = w.details.find((d) => d.case.id === a.caseId)?.case.name ?? "Unknown case";
        return groups.flatMap((g) => g.findings.map((f) => ({ ...f, analysis: a, caseName })));
      }),
    )
      .then((all) => setFindings(all.flat()))
      .catch((e: Error) => setError(e.message));
  }, [w]);
  return { findings, error };
}
