// Public entry point of the adjudicate module: evidence packets, the Sonnet call, verdict validation,
// and code's checks and score for each verdict. Only this module and claims/ call a model, and every
// call is reserved against a budget and recorded with recordCall.

export { assess, disagrees, type Assessed, type Checks, type TaggedClaim } from "./assess";
export { findCandidate, persistPool } from "./candidates";
export { anthropicAdjudicator, type Adjudicator, type AdjudicatorReply, type CallOptions } from "./model";
export { executeAdjudication, STOP_CHECK_MS, type ExecutionCounts, type ExecutionInput, type ExecutionResult } from "./execute";
export { runPool, type PoolControl, type PoolResult, type PoolStep } from "./pool";
export { classifyFailure, DEFAULT_RETRY_AFTER_MS } from "./requests";
export { DEFAULT_STRATEGY, MAX_CONCURRENCY, PRODUCTION_STRATEGY_IDS, STRATEGIES, STRATEGY_IDS, type Strategy, type StrategyId } from "./strategies";
export { CONTEXT_LINES, evidenceOf, exchangeIdOf, formatPacket, loadPacket, packetRecord, untilGap, type Packet, type PacketExchange, type PacketLine } from "./packet";
export { checkConsistency, CONSISTENCY_ISSUES, resolvesToContext, type ConsistencyIssue } from "./consistency";
export { ADJUDICATION_MODEL, DEFAULT_EFFORT, DEFAULT_PROMPT_VERSION, EFFORTS, MAX_OUTPUT_TOKENS, PROMPT_VERSION, PROMPT_VERSIONS, PROMPTS, SYSTEM_PROMPT, type Effort, type PromptVersion } from "./prompt";
export { replayCandidate, type ReplayOutcome } from "./replay";
export { adjudicateCandidate, maxPacketCost, readVerdict, storeVerdict, type AdjudicationResult, type VerdictOrigin, type VerdictStatus } from "./run";
export { ALTERNATIVE_SUPPORT, ATTRIBUTIONS, CLASSIFICATIONS, CONFLICT_SOURCES, CONTEXT_PURPOSES, Verdict, VERDICT_JSON_SCHEMA, VERDICT_V2_JSON_SCHEMA, VERDICT_V3_JSON_SCHEMA, VerdictV2, VerdictV3, type Attribution, type Classification, type Stance } from "./schema";
export { advanceDiscovery, anthropicDiscovery, directCanResume, MAX_POLL_FAILURES, classifyDiscovery, discoveryRunsOf, DISCOVERY_EFFORT, DISCOVERY_FALLBACK_MODEL, DISCOVERY_MAX_OUTPUT_TOKENS, DISCOVERY_MODEL, fitsContext, inputTokensBound, loadSessions, type DiscoveryProvider, type DiscoveryRequest, type DiscoveryResult, type DiscoveryStep } from "./discover";
export { DISCOVERY_PROMPT_VERSION, DISCOVERY_SYSTEM, discoveryUserPrompt } from "./discoverPrompt";
export { readDiscoveryOutput, type DiscoveryFinding, type DiscoveryOutput } from "./discoverSchema";
