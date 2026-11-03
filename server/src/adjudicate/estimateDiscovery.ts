// What a direct discovery check of two sessions is expected to cost, before anything is sent. The
// prompt is built exactly as the check would build it, then sized from measured rates. The budget,
// not this estimate, is what limits spending: the check reserves the worst case before each request.

import { callCost, maxBatchRequestCost } from "../costs";
import type { Database } from "../db/client";
import { DISCOVERY_MAX_OUTPUT_TOKENS, DISCOVERY_MODEL, fitsContext, inputTokensBound, loadSessions } from "./discover";
import { discoveryUserPrompt } from "./discoverPrompt";
import { CROSS_DISCOVERY_MODEL, CROSS_DISCOVERY_SYSTEM, CROSS_JSON_SCHEMA, crossPrompt, loadCrossSessions } from "./discoverCross";

// Measured November 2, 2026 on the three recorded Fable discovery calls: 2.66, 2.88 and 2.92 prompt
// characters per input token. The lowest is used, so the estimate leans high.
export const CHARS_PER_TOKEN = 2.66;
// The same calls produced 18,981, 24,000 (cut off) and 39,171 output tokens, thinking included.
export const TYPICAL_OUTPUT_TOKENS = 32_000;

export type DiscoveryEstimate = { inputTokens: number; typicalUsd: number; worstUsd: number; fits: boolean; model: string };

export function estimateFromPromptChars(chars: number, model = DISCOVERY_MODEL): DiscoveryEstimate {
  const inputTokens = Math.ceil(chars / CHARS_PER_TOKEN);
  const typical = callCost(model, { input: inputTokens, output: TYPICAL_OUTPUT_TOKENS, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 }, { batch: true });
  return {
    inputTokens,
    typicalUsd: typical?.costUsd ?? 0,
    // The reservation the check makes: every character counted as a token, output at its cap.
    worstUsd: maxBatchRequestCost(model, { inputTokens: chars, maxOutputTokens: DISCOVERY_MAX_OUTPUT_TOKENS }),
    fits: fitsContext(chars),
    model,
  };
}

export async function estimateDiscovery(db: Database, pair: { witnessId: number; depositionA: number; depositionB: number }) {
  const { witness, sessions } = await loadSessions(db, pair);
  return estimateFromPromptChars(inputTokensBound(discoveryUserPrompt(witness, sessions[0], sessions[1])));
}

// The sessions of two witnesses, as a cross-witness check would send them, at its main model's prices.
// Opus wrote 28,000 to 42,000 output tokens on real testimony in November 2026, inside the same typical
// figure, so it is kept.
export async function estimateCrossDiscovery(db: Database, sides: { witnessA: number; witnessB: number; a: readonly number[]; b: readonly number[] }) {
  const loaded = await loadCrossSessions(db, sides);
  return estimateFromPromptChars(inputTokensBound(crossPrompt(loaded), CROSS_DISCOVERY_SYSTEM, CROSS_JSON_SCHEMA), CROSS_DISCOVERY_MODEL);
}
