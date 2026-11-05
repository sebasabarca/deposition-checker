// Estimates already prepared, saved in this browser per account, so going back to a choice shows its cost at once
// instead of asking the server to read the case again. A saved estimate is a preview only: reviewing and starting
// always uses a fresh estimate prepared on the server, which is what a spending limit is authorized against.
//
// The key holds the case, the choice (scopeKey) and a fingerprint of the case's depositions (which ones are ready,
// and each file's SHA-256), so adding, removing or replacing a deposition makes earlier estimates unreachable.
// Entries expire after a day and at most MAX_ENTRIES are kept. Storage failures (a private window, a full or blocked
// store) leave the page working without saved estimates.

import type { CaseRunEstimate } from "../types";

export const ESTIMATE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 60;
const STORE = "veridict:estimates:v1";

export type SavedEstimate = { estimate: CaseRunEstimate; savedAt: number };
type Store = Pick<Storage, "getItem" | "setItem">;

export const depositionFingerprint = (depositions: readonly { id: number; status: string; fileSha256?: string }[]) =>
  depositions.filter((d) => d.status === "ready").map((d) => `${d.id}:${d.fileSha256 ?? ""}`).sort().join(",");

export const estimateCacheKey = (userId: number, caseId: number, scopeKey: string, fingerprint: string) => `${userId}|${caseId}|${scopeKey}|${fingerprint}`;

const read = (store: Store | null): Record<string, SavedEstimate> => {
  try {
    const raw = store?.getItem(STORE);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, SavedEstimate>) : {};
  } catch {
    return {};
  }
};

export function loadEstimate(store: Store | null, key: string, now: number): SavedEstimate | null {
  const hit = read(store)[key];
  return hit && typeof hit.savedAt === "number" && hit.estimate && now - hit.savedAt < ESTIMATE_TTL_MS ? hit : null;
}

export function saveEstimate(store: Store | null, key: string, estimate: CaseRunEstimate, now: number) {
  const all = read(store);
  if (all[key] && JSON.stringify(all[key].estimate) === JSON.stringify(estimate)) return; // unchanged: no write
  all[key] = { estimate, savedAt: now };
  const kept = Object.entries(all).filter(([, v]) => now - v.savedAt < ESTIMATE_TTL_MS).sort((a, b) => b[1].savedAt - a[1].savedAt).slice(0, MAX_ENTRIES);
  try { store?.setItem(STORE, JSON.stringify(Object.fromEntries(kept))); } catch { /* storage unavailable: kept for this visit only */ }
}

export const browserStore = (): Store | null => { try { return window.localStorage; } catch { return null; } };
