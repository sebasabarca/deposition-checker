// How adjudication is executed: always one independent pair per request. C is the default, approved
// October 30 from a live comparison. A stays as the sequential fallback.

export type Strategy = { id: StrategyId; label: string; candidatesPerRequest: number; maxConcurrency: number };

export const STRATEGIES = {
  A: { id: "A", label: "Sequential baseline", candidatesPerRequest: 1, maxConcurrency: 1 },
  B: { id: "B", label: "Five concurrent single-pair requests", candidatesPerRequest: 1, maxConcurrency: 5 },
  C: { id: "C", label: "Ten concurrent single-pair requests", candidatesPerRequest: 1, maxConcurrency: 10 },
} as const;
export type StrategyId = keyof typeof STRATEGIES;
export const STRATEGY_IDS = Object.keys(STRATEGIES) as StrategyId[];
export const DEFAULT_STRATEGY: StrategyId = "C"; // concurrent_single: independent single-pair requests
export const PRODUCTION_STRATEGY_IDS = ["A", "B", "C"] as const satisfies readonly StrategyId[];
export const MAX_CONCURRENCY = 20;
