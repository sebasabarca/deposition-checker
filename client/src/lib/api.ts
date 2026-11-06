// The v2 API, as the server serves it under /api (Vite proxies it in development). Every error
// carries the server's own message, so the UI can show it as it is.

import type { CaseDetail, CaseRun, RunningAnalysis, CaseRunContract, CaseRunExecution, CaseRunFinding, CaseSummary, DepositionLines, DepositionView, ReviewDecision } from "../types";
import type { Workspace } from "./workspace";


export const SIGNED_OUT = "veridict:signed-out";
// A deposition was uploaded to a case (detail: { caseId }), so an open case page reloads and shows it processing.
export const DEPOSITION_ADDED = "veridict:deposition-added";
export type User = { id: number; email: string; name: string; emailVerified: boolean; analysisAccess: boolean; onboarded: boolean };

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
  signIn: (email: string, password: string) => request<{ user: User }>("POST", "/auth/signin", { email, password }),
  signUp: (body: { name: string; email: string; password: string }) => request<{ ok: true; message: string }>("POST", "/auth/signup", body),
  verifyEmail: (token: string) => request<{ user: User }>("POST", "/auth/verify", { token }),
  resendVerification: () => request<{ ok: true; message: string }>("POST", "/auth/verify/resend"),
  forgotPassword: (email: string) => request<{ ok: true; message: string }>("POST", "/auth/forgot", { email }),
  resetPassword: (token: string, password: string) => request<{ user: User }>("POST", "/auth/reset", { token, password }),
  signOut: () => request<{ ok: true }>("POST", "/auth/signout"),
  localDemo: () => request<{ available: boolean }>("GET", "/auth/local-demo"),
  openLocalDemo: () => request<{ user: User }>("POST", "/auth/local-demo"),
  updateProfile: (name: string) => request<{ user: User }>("PATCH", "/auth/profile", { name }),
  changePassword: (current: string, password: string) => request<{ ok: true; message: string }>("POST", "/auth/password", { current, password }),
  changeEmail: (email: string, password: string) => request<{ ok: true; message: string }>("POST", "/auth/email", { email, password }),
  markOnboarded: () => request<{ ok: true }>("POST", "/auth/onboarded"),
  cases: () => request<{ cases: CaseSummary[] }>("GET", "/cases"),
  workspace: () => request<Workspace>("GET", "/workspace"),
  createCase: (name: string, witness?: string) => request<CaseDetail>("POST", "/cases", { name, ...(witness ? { witness } : {}) }),
  renameCase: (id: number, name: string) => request<CaseDetail>("PATCH", `/cases/${id}`, { name }),
  case: (id: number) => request<CaseDetail>("GET", `/cases/${id}`),
  // Whole-case runs (docs/case-run-api.md). A live run stops after preparation with its estimate; nothing is
  // sent to a model until confirmCaseRun with a budget. A mock run uses the free deterministic test model.
  caseRuns: (caseId: number) => request<{ caseRuns: CaseRun[]; stretchAvailable?: boolean; economyAvailable?: boolean; paidAvailable?: boolean; runningElsewhere?: RunningAnalysis | null }>("GET", `/cases/${caseId}/case-runs`),
  caseRun: (id: number) => request<{ caseRun: CaseRun }>("GET", `/case-runs/${id}`),
  // execution: a test run picks fast (standard) or economy (batch) here; a paid run picks it when confirmed.
  // depositionIds: analyze only these depositions (the same pipeline); absent = the whole case.
  startCaseRun: (caseId: number, mode: "live" | "mock", execution: CaseRunExecution = "standard", contract?: CaseRunContract, depositionIds?: number[]) => request<{ caseRun: CaseRun }>("POST", `/cases/${caseId}/case-runs`, { mode, ...(mode === "mock" ? { execution } : {}), ...(contract && contract !== "packet-v1" ? { contract } : {}), ...(depositionIds ? { depositionIds } : {}) }),
  // fresh: a fresh analysis, which reuses no earlier answer and is charged for every request.
  confirmCaseRun: (id: number, budgetUsd: number, execution: CaseRunExecution = "standard", retentionAcknowledged = false, name?: string, fresh = false) => request<{ caseRun: CaseRun }>("POST", `/case-runs/${id}/confirm`, { budgetUsd, ...(execution === "batch" ? { execution, retentionAcknowledged } : {}), ...(name ? { name } : {}), ...(fresh ? { fresh } : {}) }),
  resumeCaseRun: (id: number, budgetUsd?: number) => request<{ caseRun: CaseRun }>("POST", `/case-runs/${id}/resume`, budgetUsd === undefined ? {} : { budgetUsd }),
  cancelCaseRun: (id: number) => request<{ caseRun: CaseRun }>("POST", `/case-runs/${id}/cancel`),
  caseRunFindings: (id: number) => request<{ complete: boolean; incompleteReasons: string[]; findings: CaseRunFinding[] }>("GET", `/case-runs/${id}/findings`),
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
  // One whole-case run's kept findings (and, withContext, those marked Needs context) as a PDF download.
  caseRunReportUrl: (runId: number, withContext: boolean) => `/api/case-runs/${runId}/report.pdf${withContext ? "?context=1" : ""}`,
  setDepositionDate: (id: number, takenOn: string | null) => request<{ deposition: DepositionView }>("PATCH", `/depositions/${id}`, { takenOn }),
  moveDeposition: (id: number, caseId: number, witness: string) => request<{ deposition: DepositionView }>("POST", `/depositions/${id}/move`, { caseId, witness }),
  deleteDeposition: (id: number) => request<{ deleted: { depositions: number; analyses: number } }>("DELETE", `/depositions/${id}`),
  deleteCase: (id: number) => request<{ deleted: { depositions: number; analyses: number } }>("DELETE", `/cases/${id}`),
  retryDeposition: (id: number) => request<unknown>("POST", `/depositions/${id}/retry`),
  // epochs: the evidence versions the finding was opened at (CaseRunFinding.evidenceEpochs); a later correction refuses the save (409).
  review: (id: number, decision: ReviewDecision | null, note: string | undefined, epochs: Record<string, number>) => request<{ review: { reviewState: string; reviewNote: string | null; reviewedAt: string | null } }>("PATCH", `/findings/${id}/review`, { decision, note, epochs }),
};
