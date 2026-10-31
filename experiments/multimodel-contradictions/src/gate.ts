// Nothing leaves this machine unless all of these agree. Pure.
export type Approval = {
  approvedBy: string;
  approvedOn: string;
  allowExternalCalls: boolean;
  syntheticOnly: boolean; // true: no real testimony may be sent
  realTranscriptAuthorized: boolean; // the person confirmed these transcripts may go to this provider
  experiments: string[]; // discovery, pairs, probe
  arms: Record<string, { maxCalls: number; maxUsd: number }>;
};
// calls and worstCaseUsd include everything the arm has already used: caps cover a phase, not a run.
export type Plan = { arm: string; experiment: string; kind: "real" | "synthetic"; calls: number; worstCaseUsd: number; fits: boolean };
export type Spent = { calls: number; costUsd: number; uncertainUsd: number };

// What an arm has used across its runs. A failed call may have been billed, so it counts at its worst case.
export const ledgerOf = (runs: readonly (Spent & { arm: string })[], arm: string): Spent => runs.filter((r) => r.arm === arm).reduce((n, r) => ({ calls: n.calls + r.calls, costUsd: n.costUsd + r.costUsd, uncertainUsd: n.uncertainUsd + r.uncertainUsd }), { calls: 0, costUsd: 0, uncertainUsd: 0 });


export function gateFailure(plan: Plan, approval: Approval | null, env: { EXPERIMENT_ALLOW_EXTERNAL?: string }, execute: boolean): string | null {
  if (!execute) return "dry run: pass --execute to call a provider";
  if (env.EXPERIMENT_ALLOW_EXTERNAL !== "true") return "EXPERIMENT_ALLOW_EXTERNAL=true is not set";
  if (!approval?.allowExternalCalls) return "config/approval.local.json doesn't allow external calls";
  if (!approval.experiments.includes(plan.experiment)) return `experiment ${plan.experiment} isn't approved`;
  const limits = approval.arms[plan.arm];
  if (!limits) return `arm ${plan.arm} isn't approved`;
  if (plan.kind === "real" && (approval.syntheticOnly || !approval.realTranscriptAuthorized)) return "real testimony isn't authorized for external processing";
  if (!plan.fits) return "the input doesn't fit this arm's verified limits; nothing is truncated";
  if (plan.calls > limits.maxCalls) return `${plan.calls} calls exceed the approved ${limits.maxCalls}`;
  if (plan.worstCaseUsd > limits.maxUsd) return `worst case $${plan.worstCaseUsd.toFixed(4)} exceeds the approved $${limits.maxUsd}`;
  return null;
}

// Stops before a call whose worst case could cross the cap. Paid spend only rises through this check.
export const canAfford = (spentUsd: number, worstCallUsd: number, capUsd: number) => spentUsd + worstCallUsd <= capUsd;
