// The models v2 calls, by pipeline stage (DESIGN.md, "Cost model": Haiku tags claims, Sonnet
// adjudicates). Only claims/ and adjudicate/ call a model, through these names, and every such call
// is recorded with recordCall(). A test checks that each of them has a price.

export const V2_MODELS = {
  claim_tagging: "claude-haiku-5-5",
  adjudication: "claude-sonnet-5-5",
} as const;

export type Stage = keyof typeof V2_MODELS;
