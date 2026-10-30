// A deterministic stand-in for the adjudication model, for tests and the strategy mock runs. It never
// touches the network. Its latency and token figures are assumptions fitted to the 115 calls of
// analysis 9 (3.3 s, 368 output tokens): what it measures is the pipeline, never model performance.

import Anthropic from "@anthropic-ai/sdk";
import type { Adjudicator, AdjudicatorReply, BatchAdjudicator, CallOptions } from "../adjudicate";

export const MOCK_MODEL = "claude-sonnet-5-5";
export const ASSUMED_FIRST_TOKEN_MS = 400;
export const ASSUMED_OUTPUT_TOKENS_PER_SECOND = 127;
export const ASSUMED_OUTPUT_TOKENS = 368;

export type MockBehaviour = {
  timeScale?: number; // 0.02 runs 50 times faster than the assumed real speed; 0 is immediate
  fail?: (call: number) => Error | null; // thrown for this call
  edit?: (reply: { verdicts: Record<string, unknown>[] }, call: number) => { verdicts: unknown[] } | string; // change a batch response
  stopReason?: (call: number) => string;
};

const usage = (chars: number, verdicts: number) =>
  ({ input_tokens: Math.round(chars * 0.43), output_tokens: ASSUMED_OUTPUT_TOKENS * verdicts, cache_creation_input_tokens: 0, cache_read_input_tokens: 3500, cache_creation: null }) as unknown as Anthropic.Usage;

// A valid "compatible" verdict for one candidate's evidence text, quoting its exchange verbatim.
function verdictFor(evidence: string): Record<string, unknown> {
  const sides = [...evidence.matchAll(/Exchange \[(E\d+)\][^\n]*:\n([\s\S]*?)(?=\n(?:Context|\[pages|<\/session))/g)];
  const phrase = (i: number) => sides[i][2].split("\n").filter(Boolean).pop()!.replace(/^\s*\d+:\d+\s+/, "").replace(/^(Q\.|A\.)\s*/, "").trim();
  return {
    classification: "false_positive", evidenceAId: sides[0][1], evidenceBId: sides[1][1], keyPhraseA: phrase(0), keyPhraseB: phrase(1),
    attributionA: "asserted", attributionB: "asserted", stanceA: "affirms", stanceB: "affirms", sameEvent: "no", scopeAligned: "no", conflictBasis: "none",
    aboutTimingOfSameEvent: false, inferenceSteps: [], unestablishedAssumptions: [], falsePositiveReason: "different_event", explanation: "Mock verdict: a fixed compatible assessment for pipeline tests.", alternativeExplanation: null, needsMoreContext: false,
    alternativeSupport: null, conflictSource: "none", contextUsed: [],
  };
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new Anthropic.APIUserAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

const assumedMs = (verdicts: number) => ASSUMED_FIRST_TOKEN_MS + (ASSUMED_OUTPUT_TOKENS * verdicts * 1000) / ASSUMED_OUTPUT_TOKENS_PER_SECOND;

export type MockStats = { calls: number; inFlight: number; peak: number };

export function mockSingle(behaviour: MockBehaviour = {}): Adjudicator & MockStats {
  const { timeScale = 0, fail, stopReason } = behaviour;
  const mock = {
    model: MOCK_MODEL, effort: "medium" as const, promptVersion: "adjudicate-v3" as const, calls: 0, inFlight: 0, peak: 0,
    async adjudicate(packetText: string, options?: CallOptions): Promise<AdjudicatorReply> {
      const call = ++mock.calls;
      mock.peak = Math.max(mock.peak, ++mock.inFlight);
      try {
        await wait(assumedMs(1) * timeScale, options?.signal);
        const failure = fail?.(call);
        if (failure) throw failure;
        return { model: MOCK_MODEL, stopReason: stopReason?.(call) ?? "end_turn", usage: usage(packetText.length, 1), text: JSON.stringify(verdictFor(packetText)), latencyMs: Math.round(assumedMs(1)), requestId: `mock-${call}` };
      } finally {
        mock.inFlight--;
      }
    },
  };
  return mock;
}

export function mockBatch(behaviour: MockBehaviour = {}): BatchAdjudicator & MockStats {
  const { timeScale = 0, fail, edit, stopReason } = behaviour;
  const mock = {
    model: MOCK_MODEL, effort: "medium" as const, promptChars: 12_000, calls: 0, inFlight: 0, peak: 0,
    async adjudicate(batchText: string, _maxOutputTokens: number, options?: CallOptions): Promise<AdjudicatorReply> {
      const call = ++mock.calls;
      mock.peak = Math.max(mock.peak, ++mock.inFlight);
      try {
        const candidates = [...batchText.matchAll(/<candidate id="(C\d+)"[^>]*>\n([\s\S]*?)<\/candidate>/g)];
        await wait(assumedMs(candidates.length) * timeScale, options?.signal);
        const failure = fail?.(call);
        if (failure) throw failure;
        const reply = { verdicts: candidates.map((c) => ({ candidateId: c[1], ...verdictFor(c[2]) })) };
        const edited = edit ? edit(reply, call) : reply;
        return { model: MOCK_MODEL, stopReason: stopReason?.(call) ?? "end_turn", usage: usage(batchText.length, candidates.length), text: typeof edited === "string" ? edited : JSON.stringify(edited), latencyMs: Math.round(assumedMs(candidates.length)), requestId: `mock-${call}` };
      } finally {
        mock.inFlight--;
      }
    },
  };
  return mock;
}
