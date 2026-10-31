// Human review decisions. PENDING BACKEND: the server stores `reviewState` but has no endpoint to
// change it, so this adapter keeps decisions in this browser only and the UI says so. When
// `PATCH /api/findings/:id/review` exists, replace load/save here; no screen needs to change.

import { useSyncExternalStore } from "react";

export const REVIEW_DECISIONS = ["confirmed", "dismissed", "needs_context"] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];
export type ReviewRecord = { decision: ReviewDecision; note: string; decidedAt: string };
export type ReviewStore = Record<number, ReviewRecord>;

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

export function saveReview(id: number, decision: ReviewDecision, note: string) {
  commit({ ...store, [id]: { decision, note, decidedAt: new Date().toISOString() } });
}

export function clearReview(id: number) {
  const { [id]: _removed, ...rest } = store;
  commit(rest);
}

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
export function reviewOf(id: number, serverState: string, reviews: ReviewStore): ReviewDecision | "unreviewed" {
  return reviews[id]?.decision ?? (REVIEW_DECISIONS.includes(serverState as ReviewDecision) ? (serverState as ReviewDecision) : "unreviewed");
}
