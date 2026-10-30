// How adjudication is executed. C is the default, approved October 30 from the live comparison
// (reports/benchmarks/adjudication-strategies/runs/strategies-1/). A stays as the sequential fallback.
// D, E, F and P are experimental: the live batch run lost recall, omitted verdicts and returned
// placeholder explanations, so they run only from scripts/adjudication-experiment.ts. P is a control:
// the batch prompt with one candidate per request, which separates "the prompt changed" from "several
// candidates shared a request".

export type Strategy = { id: StrategyId; label: string; candidatesPerRequest: number; maxConcurrency: number };

export const STRATEGIES = {
  A: { id: "A", label: "Sequential baseline", candidatesPerRequest: 1, maxConcurrency: 1 },
  B: { id: "B", label: "Five concurrent single-pair requests", candidatesPerRequest: 1, maxConcurrency: 5 },
  C: { id: "C", label: "Ten concurrent single-pair requests", candidatesPerRequest: 1, maxConcurrency: 10 },
  D: { id: "D", label: "Batches of 10, five concurrent", candidatesPerRequest: 10, maxConcurrency: 5 },
  E: { id: "E", label: "Batches of 20, five concurrent", candidatesPerRequest: 20, maxConcurrency: 5 },
  F: { id: "F", label: "Batches of 40, three concurrent", candidatesPerRequest: 40, maxConcurrency: 3 },
  P: { id: "P", label: "Control: batch prompt, one pair per request, five concurrent", candidatesPerRequest: 1, maxConcurrency: 5 },
} as const;
export type StrategyId = keyof typeof STRATEGIES;
export const STRATEGY_IDS = Object.keys(STRATEGIES) as StrategyId[];
export const DEFAULT_STRATEGY: StrategyId = "C"; // concurrent_single: independent single-pair requests
// What a normal analysis may use: always one independent pair per request.
export const PRODUCTION_STRATEGY_IDS = ["A", "B", "C"] as const satisfies readonly StrategyId[];
export const MAX_CONCURRENCY = 20;

// Whether a strategy sends the batch format and prompt, rather than one candidate and its own prompt.
export const usesBatchFormat = (id: StrategyId) => STRATEGIES[id].candidatesPerRequest > 1 || id === "P";
