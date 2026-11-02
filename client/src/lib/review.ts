// Human review decisions. PENDING BACKEND: the server stores `reviewState` but has no endpoint to
// change it, so this adapter keeps decisions in this browser only and the UI says so. When
// `PATCH /api/findings/:id/review` exists, replace load/save here; no screen needs to change.

import { useSyncExternalStore } from "react";

export const REVIEW_DECISIONS = ["confirmed", "dismissed", "needs_context"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];
export type ReviewRecord = { decision: ReviewDecision; note: string; decidedAt: string };
export type ReviewStore = Record<string, ReviewRecord>; // by finding ID, and by evidence key (`e:<key>`) for a direct finding

export const REVIEW_LABEL: Record<ReviewDecision | "unreviewed", string> = {
  unreviewed: "Not reviewed",
  confirmed: "Confirmed by reviewer",
  dismissed: "Dismissed by reviewer",
  needs_context: "Reviewer needs more context",
};

const KEY = "deposition-checker.review.v1";

export function parseStore(raw: string | null): ReviewStore {
  try {
    const data = JSON.parse(raw ?? "{}") as ReviewStore;
    return Object.fromEntries(Object.entries(data).filter(([, r]) => REVIEW_DECISIONS.includes(r?.decision))) as ReviewStore;
  } catch {
    return {}; // Stored data is only a convenience copy: unreadable means nothing decided yet.
  }
}

function readStorage() {
  try {
    return parseStore(localStorage.getItem(KEY));
  } catch {
    return {};
  }
}

let store: ReviewStore = readStorage();
const listeners = new Set<() => void>();

function commit(next: ReviewStore) {
  store = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private windows can refuse storage: the decision still holds for this session.
  }
  listeners.forEach((l) => l());
}

// A direct finding's evidence key is the same in a later analysis of the same passages, so a decision
// made once still shows there.
const evidence = (key?: string | null) => (key ? `e:${key}` : null);

export function saveReview(id: number, decision: ReviewDecision, note: string, evidenceKey?: string | null) {
  const record = { decision, note, decidedAt: new Date().toISOString() };
  const shared = evidence(evidenceKey);
  commit({ ...store, [id]: record, ...(shared ? { [shared]: record } : {}) });
}

export function clearReview(id: number, evidenceKey?: string | null) {
  const { [id]: _removed, [evidence(evidenceKey) ?? ""]: _shared, ...rest } = store;
  commit(rest);
}

export const savedReview = (id: number, reviews: ReviewStore, evidenceKey?: string | null): ReviewRecord | undefined => reviews[id] ?? reviews[evidence(evidenceKey) ?? ""];

export function useReviews(): ReviewStore {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => store,
  );
}

// What a finding's review status is: the local decision, else what the server stored.
export function reviewOf(id: number, serverState: string, reviews: ReviewStore, evidenceKey?: string | null): ReviewDecision | "unreviewed" {
  return savedReview(id, reviews, evidenceKey)?.decision ?? (REVIEW_DECISIONS.includes(serverState as ReviewDecision) ? (serverState as ReviewDecision) : "unreviewed");
}
