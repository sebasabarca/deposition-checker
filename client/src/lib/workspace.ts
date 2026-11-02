// Cross-case views (overview, depositions, findings, analyses), from one GET /workspace response.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { isActive } from "./insights";
import { usePoll } from "./router";
import type { AnalysisView, CaseDetail, CaseSummary, FindingSummary } from "../types";

export type Workspace = { cases: CaseSummary[]; details: CaseDetail[]; analyses: AnalysisView[]; findings: (FindingSummary & { analysisId: number; caseName: string })[] };
export type WorkspaceFinding = FindingSummary & { analysis: AnalysisView; caseName: string };

export function useWorkspace() {
  const [data, setData] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.workspace().then((w) => {
      setData(w);
      setError(null);
    }).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  usePoll(!!data && data.analyses.some((a) => isActive(a.status)), 3000, load);
  return { data, error };
}

// Each finding with its analysis attached, for the lists that show the witness and sessions.
export function useWorkspaceFindings(w: Workspace | null) {
  const findings = useMemo(() => {
    if (!w) return null;
    const byId = new Map(w.analyses.map((a) => [a.id, a]));
    return w.findings.flatMap((f) => (byId.has(f.analysisId) ? [{ ...f, analysis: byId.get(f.analysisId)! }] : []));
  }, [w]);
  return { findings, error: null as string | null };
}
