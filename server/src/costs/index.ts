// Public entry point of the costs module: the price table, the cost of a call, and recording it.
// Only claims/ and adjudicate/ call a model, and every such call is recorded with recordCall().
// The estimator and the budget guard arrive with adjudication.

export { callCost, promptTokens, tokensFromUsage, type CallCost, type CallTokens } from "./cost";
export { V2_MODELS, type Stage } from "./models";
export { BATCH_MULTIPLIER, PRICE_VERSION, PRICES, type PriceTier, type Rates } from "./pricing";
export { jobCost, recordCall, type JobCost, type RecordedCall } from "./record";
