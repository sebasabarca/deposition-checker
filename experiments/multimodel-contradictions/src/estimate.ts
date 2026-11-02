// Token, fit and cost estimates from local character counts. Pure: no tokenizer call, no upload.
export type Rates = { input: number; cacheRead: number; cacheWrite: number; output: number };
export type ArmConfig = { label: string; provider: string; model?: string; kind: string; contextTokens?: number; contextVerified?: boolean; maxOutputTokens?: number | null; rates?: Rates; effort?: string; thinking?: boolean; systemExtra?: string; batchMaxTokens?: number };
export type Estimate = { calls: number; inputTokens: number; largestInputTokens: number; expectedUsd: number; worstCaseUsd: number; worstCallUsd: number; fits: boolean; fitNote: string };

export const costUsd = (r: Rates, u: { input: number; output: number; cacheRead?: number; cacheWrite?: number }) => (u.input * r.input + u.output * r.output + (u.cacheRead ?? 0) * r.cacheRead + (u.cacheWrite ?? 0) * r.cacheWrite) / 1e6;

export function estimate(arm: ArmConfig, promptChars: readonly number[], { charsPerToken, expectedOutput, maxOutput }: { charsPerToken: number; expectedOutput: number; maxOutput: number }): Estimate {
  if (!arm.rates) throw new Error(`${arm.label} makes no calls.`);
  const tokens = promptChars.map((c) => Math.ceil(c / charsPerToken));
  const rates = arm.rates;
  const largest = Math.max(0, ...tokens);
  const sum = tokens.reduce((a, b) => a + b, 0);
  const worstCall = costUsd(rates, { input: largest * (rates.cacheWrite > rates.input ? rates.cacheWrite / rates.input : 1), output: maxOutput });
  const worst = tokens.reduce((n, t) => n + costUsd(rates, { input: t * (rates.input > 0 && rates.cacheWrite > rates.input ? rates.cacheWrite / rates.input : 1), output: maxOutput }), 0);
  const context = arm.contextTokens ?? 0;
  const fits = largest + maxOutput <= context && (arm.maxOutputTokens == null || maxOutput <= arm.maxOutputTokens);
  const fitNote = `${largest} input + ${maxOutput} output of ${context}${arm.contextVerified ? "" : " (unverified limit)"}`;
  return { calls: tokens.length, inputTokens: sum, largestInputTokens: largest, expectedUsd: sum === 0 ? 0 : tokens.reduce((n, t) => n + costUsd(rates, { input: t, output: expectedOutput }), 0), worstCaseUsd: worst, worstCallUsd: worstCall, fits, fitNote };
}
