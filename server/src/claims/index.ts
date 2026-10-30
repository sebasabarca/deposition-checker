// Public entry point of the claims module: Path A's input. Claim extraction with Haiku, checked
// against the stored source lines. Only this module and adjudicate/ call a model, and every call is
// recorded with recordCall.

export { CARDS_JSON_SCHEMA, ExtractedCard, mergeCoverage, readCards, type CardReading, type CheckedCard, type Chunk, type ChunkExchange, type Coverage, type CoverageStatus, type ModelReply as CardModelReply } from "./cards";
export { readAnswer, readRecollection, type AnswerReading, type RecollectionReading } from "../verify";
export { normalizeEntities, normalizeEntity } from "./entities";
export { anthropicClaimModel, type ClaimModel, type ModelReply } from "./model";
export { BATCH_SIZE, CLAIMS_MODEL, estimateCost, EXTRACTOR_VERSION, formatBatch, PLANNING_OUTPUT_SHARE, PROMPT_VERSION, SYSTEM_PROMPT, type Estimate } from "./prompt";
export { EXTRACTION_JSON_SCHEMA, ExtractionOutput, type ExtractedClaim } from "./schema";
export { batchesOf, partLines, partsToTag, reverifyClaims, tagClaims, type TagPart, type TagResult } from "./tag";
export { checkClaim, contentWords, contextReason, findHedge, groundEntities, locate, type ClaimCheck, type Part, type PartLine } from "./verify";
export { PREDICATES, PREDICATE_NAMES, type Predicate } from "./vocabulary";
