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

// What kind of failure this is, and how long the API asked us to wait. Pure.
export function classifyFailure(error: unknown): { kind: "rate_limited" | "overloaded" | "aborted" | "api_error" | "network"; status: Status; retryAfterMs: number | null; billable: boolean } {
  const billable = !failureIsUnbilled(error);
  if (error instanceof Anthropic.APIUserAbortError) return { kind: "aborted", status: "aborted", retryAfterMs: null, billable };
  if (error instanceof Anthropic.APIError && (error.status === 429 || error.status === 529)) {
    const seconds = Number(error.headers?.get?.("retry-after"));
    return { kind: error.status === 429 ? "rate_limited" : "overloaded", status: "rate_limited", retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_AFTER_MS, billable };
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
