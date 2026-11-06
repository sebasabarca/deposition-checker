// Cross-case views (overview, depositions, findings, analyses), from one GET /workspace response.

import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { usePoll } from "./router";
import type { CaseDetail, CaseRun, CaseSummary, WorkspaceFinding } from "../types";
import { MOVING_RUN } from "./caseRuns";

// caseRuns: the whole-case analyses running now (not estimates). findings: each case's latest analysis's findings.
export type Workspace = { cases: CaseSummary[]; details: CaseDetail[]; caseRuns: CaseRun[]; findings: WorkspaceFinding[] };

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
  usePoll(!!data && (data.caseRuns.some((r) => MOVING_RUN.includes(r.status)) || data.details.some((d) => d.depositions.some((x) => x.status === "processing"))), 3000, load);
  return { data, error };
}
