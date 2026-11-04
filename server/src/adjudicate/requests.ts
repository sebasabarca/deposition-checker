// The record of each request to the adjudication model: what was sent, what it could cost, and what
// came back. It sits beside llm_calls, which holds the one charge for the request; a batch's charge
// is never repeated per candidate.

import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { failureIsUnbilled } from "../costs";
import type { Database } from "../db/client";
import { adjudicationRequests } from "../db/schema";

export type RequestContext = { candidateSet: string; analysisId: number | null; strategy: string; maxConcurrency: number; signal?: AbortSignal };
type Status = (typeof adjudicationRequests.$inferSelect)["status"];

export const DEFAULT_RETRY_AFTER_MS = 30_000;

const RESET_HEADERS = ["requests", "input-tokens", "output-tokens", "tokens"].map((k) => [`anthropic-ratelimit-${k}-remaining`, `anthropic-ratelimit-${k}-reset`] as const);

// How long the API asked us to wait: retry-after (seconds), else the latest RFC 3339 reset of a limit with
// nothing remaining, else null.
export function retryAfterMsOf(headers: { get(name: string): string | null } | undefined, now = Date.now()): number | null {
  const seconds = Number(headers?.get("retry-after"));
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const resets = RESET_HEADERS.filter(([remaining]) => headers?.get(remaining) === "0").map(([, reset]) => Date.parse(headers?.get(reset) ?? "") - now).filter((ms) => ms > 0);
  return resets.length ? Math.max(...resets) : null;
}

// What kind of failure this is, and how long the API asked us to wait. Pure, apart from `now`.
// A 429 for the organization's monthly spend cap is not a rate limit: retrying fails until the month ends.
export function classifyFailure(error: unknown, now = Date.now()): { kind: "rate_limited" | "overloaded" | "spend_limit" | "aborted" | "api_error" | "network"; status: Status; retryAfterMs: number | null; billable: boolean } {
  const billable = !failureIsUnbilled(error);
  if (error instanceof Anthropic.APIUserAbortError) return { kind: "aborted", status: "aborted", retryAfterMs: null, billable };
  if (error instanceof Anthropic.APIError && error.status === 429 && (error.error as { error?: { details?: { error_code?: string } } } | undefined)?.error?.details?.error_code === "enforced_spend_limit_reached") {
    return { kind: "spend_limit", status: "failed", retryAfterMs: null, billable };
  }
  if (error instanceof Anthropic.APIError && (error.status === 429 || error.status === 529)) {
    return { kind: error.status === 429 ? "rate_limited" : "overloaded", status: "rate_limited", retryAfterMs: retryAfterMsOf(error.headers, now) ?? DEFAULT_RETRY_AFTER_MS, billable };
  }
  if (error instanceof Anthropic.APIConnectionError) return { kind: "network", status: "failed", retryAfterMs: null, billable };
  return { kind: "api_error", status: "failed", retryAfterMs: null, billable };
}

export async function openRequest(
  db: Database,
  context: RequestContext,
  request: { candidateIds: number[]; model: string; promptVersion: string; estimatedInputTokens: number; maxOutputTokens: number; maxCostUsd: number; reservationId: number | null; splitReason?: string | null; status?: Status; errorKind?: string; error?: string },
): Promise<number> {
  const { signal: _signal, ...fields } = context;
  const [row] = await db
    .insert(adjudicationRequests)
    .values({ batchId: randomUUID(), ...fields, ...request, finishedAt: request.status && request.status !== "sent" ? new Date() : null })
    .returning({ id: adjudicationRequests.id });
  return row.id;
}

export async function closeRequest(db: Database, id: number, result: Partial<typeof adjudicationRequests.$inferInsert> & { status: Status }) {
  await db.update(adjudicationRequests).set({ ...result, finishedAt: new Date() }).where(eq(adjudicationRequests.id, id));
}
