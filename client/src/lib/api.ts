// The v2 API, as the server serves it under /api (Vite proxies it in development). Every error
// carries the server's own message, so the UI can show it as it is.

import type { AnalysisView, CaseDetail, CaseSummary, FindingDetail, FindingGroups } from "../types";

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, url: string, body?: unknown, raw?: { data: Blob; contentType: string }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${url}`, {
      method,
      headers: raw ? { "content-type": raw.contentType } : body === undefined ? {} : { "content-type": "application/json" },
      body: raw ? raw.data : body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("The server can't be reached. Is it running?", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `The request failed (${res.status}).`, res.status);
  return data as T;
}

export const api = {
  cases: () => request<{ cases: CaseSummary[] }>("GET", "/cases"),
  createCase: (name: string, witness?: string) => request<CaseDetail>("POST", "/cases", { name, ...(witness ? { witness } : {}) }),
  case: (id: number) => request<CaseDetail>("GET", `/cases/${id}`),
  addWitness: (caseId: number, name: string) => request<{ witness: { id: number; name: string } }>("POST", `/cases/${caseId}/witnesses`, { name }),
  upload: (caseId: number, file: File, witness: string, takenOn?: string) => {
    const q = new URLSearchParams({ witness, filename: file.name, ...(takenOn ? { takenOn } : {}) });
    return request<{ created: boolean; deposition: { id: number; status: string } }>("POST", `/cases/${caseId}/depositions?${q}`, undefined, { data: file, contentType: "application/pdf" });
  },
  retryDeposition: (id: number) => request<unknown>("POST", `/depositions/${id}/retry`),
  startAnalysis: (caseId: number, body: { depositionA: number; depositionB: number; mode: "demo" | "live"; budgetUsd?: number; maxCandidates?: number; strategy?: string }) =>
    request<{ created: boolean; analysis: AnalysisView }>("POST", `/cases/${caseId}/analyses`, body),
  analysis: (id: number) => request<{ analysis: AnalysisView }>("GET", `/analyses/${id}`),
  resume: (id: number, budgetUsd?: number) => request<{ analysis: AnalysisView }>("POST", `/analyses/${id}/resume`, budgetUsd === undefined ? {} : { budgetUsd }),
  cancel: (id: number) => request<{ analysis: AnalysisView }>("POST", `/analyses/${id}/cancel`, {}),
  findings: (analysisId: number) => request<FindingGroups>("GET", `/analyses/${analysisId}/findings`),
  finding: (id: number) => request<{ finding: FindingDetail }>("GET", `/findings/${id}`),
};
