// The v2 API, as the server serves it under /api (Vite proxies it in development). Every error
// carries the server's own message, so the UI can show it as it is.

import type { AnalysisView, CaseDetail, CaseSummary, DepositionLines, DepositionView, FindingDetail, FindingGroups, ReviewDecision } from "../types";
import type { Workspace } from "./workspace";

export type CheckEstimate = { inputTokens: number; typicalUsd: number; worstUsd: number; fits: boolean; model: string; budgetUsd: number };

export const SIGNED_OUT = "veridict:signed-out";
export type User = { id: number; email: string; name: string; org: string };

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
  // A lapsed session anywhere sends the app back to sign-in.
  if (res.status === 401 && !url.startsWith("/auth/")) window.dispatchEvent(new Event(SIGNED_OUT));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? `The request failed (${res.status}).`, res.status);
  return data as T;
}

export const api = {
  me: () => request<{ user: User }>("GET", "/auth/me"),
  authConfig: () => request<{ signupOpen: boolean; firstUser: boolean }>("GET", "/auth/config"),
  signIn: (email: string, password: string) => request<{ user: User }>("POST", "/auth/signin", { email, password }),
  signUp: (body: { name: string; email: string; password: string; firm: string }) => request<{ user: User }>("POST", "/auth/signup", body),
  signOut: () => request<{ ok: true }>("POST", "/auth/signout"),
  cases: () => request<{ cases: CaseSummary[] }>("GET", "/cases"),
  workspace: () => request<Workspace>("GET", "/workspace"),
  createCase: (name: string, witness?: string) => request<CaseDetail>("POST", "/cases", { name, ...(witness ? { witness } : {}) }),
  case: (id: number) => request<CaseDetail>("GET", `/cases/${id}`),
  addWitness: (caseId: number, name: string) => request<{ witness: { id: number; name: string } }>("POST", `/cases/${caseId}/witnesses`, { name }),
  upload: (caseId: number, file: File, witness: string, takenOn?: string) => {
    const q = new URLSearchParams({ witness, filename: file.name, ...(takenOn ? { takenOn } : {}) });
    const text = file.type.startsWith("text/") || /\.txt$/i.test(file.name);
    return request<{ created: boolean; deposition: { id: number; status: string } }>("POST", `/cases/${caseId}/depositions?${q}`, undefined, { data: file, contentType: text ? "text/plain; charset=utf-8" : "application/pdf" });
  },
  deposition: (id: number) => request<{ deposition: DepositionView }>("GET", `/depositions/${id}`),
  lines: (id: number, at: { page?: number | null; q?: string }) => {
    const q = new URLSearchParams({ ...(at.page ? { page: String(at.page) } : {}), ...(at.q ? { q: at.q } : {}) });
    return request<DepositionLines>("GET", `/depositions/${id}/lines?${q}`);
  },
  depositionPdf: (id: number, pdfPage: number) => `/api/depositions/${id}/pdf#page=${pdfPage}`,
  depositionOriginal: (id: number) => `/api/depositions/${id}/pdf`,
  deleteDeposition: (id: number) => request<{ deleted: { depositions: number; analyses: number } }>("DELETE", `/depositions/${id}`),
  deleteCase: (id: number) => request<{ deleted: { depositions: number; analyses: number } }>("DELETE", `/cases/${id}`),
  retryDeposition: (id: number) => request<unknown>("POST", `/depositions/${id}/retry`),
  estimate: (caseId: number, a: number, b: number) => request<{ estimate: CheckEstimate }>("GET", `/cases/${caseId}/estimate?a=${a}&b=${b}`),
  startAnalysis: (caseId: number, body: { depositionA: number; depositionB: number; mode: "demo" | "live"; budgetUsd?: number; maxCandidates?: number; strategy?: string }) =>
    request<{ created: boolean; analysis: AnalysisView }>("POST", `/cases/${caseId}/analyses`, body),
  analysis: (id: number) => request<{ analysis: AnalysisView }>("GET", `/analyses/${id}`),
  resume: (id: number, budgetUsd?: number) => request<{ analysis: AnalysisView }>("POST", `/analyses/${id}/resume`, budgetUsd === undefined ? {} : { budgetUsd }),
  cancel: (id: number) => request<{ analysis: AnalysisView }>("POST", `/analyses/${id}/cancel`, {}),
  findings: (analysisId: number) => request<FindingGroups>("GET", `/analyses/${analysisId}/findings`),
  finding: (id: number) => request<{ finding: FindingDetail }>("GET", `/findings/${id}`),
  review: (id: number, decision: ReviewDecision | null, note?: string) => request<{ review: { reviewState: string; reviewNote: string | null; reviewedAt: string | null } }>("PATCH", `/findings/${id}/review`, { decision, note }),
};
