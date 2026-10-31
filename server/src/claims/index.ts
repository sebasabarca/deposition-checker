// Public entry point of the claims module: Path A's input. Statement cards and the topic map with
// Haiku, checked against the stored source lines. Only this module and adjudicate/ call a model, and
// every call is recorded with recordCall.

export { addressedShare, CARDS_JSON_SCHEMA, ExtractedCard, isNegated, MIN_ADDRESSED_SHARE, mergeCoverage, readCards, screenNoAssertion, type CardReading, type CheckedCard, type Chunk, type ChunkExchange, type Coverage, type CoverageStatus, type ModelReply as CardModelReply } from "./cards";
export { CARD_EXTRACTOR_VERSION, CARD_MAX_OUTPUT_TOKENS, CARDS_MODEL, CARDS_PROMPT_VERSION, CARDS_SYSTEM_PROMPT, CHUNK_OVERLAP_PAGES, chunkByPages, estimateCards, PAGES_PER_CHUNK, PLANNING_CARD_OUTPUT_SHARE, type CardEstimate } from "./cardPrompt";
export { CARD_CONCURRENCY, cardSummary, extractCards, partLines, plannedChunks, screenStoredNoAssertions, type CardSummary, type ExtractOptions, type ExtractResult } from "./extract";
export { normalizeEntities, normalizeEntity } from "./entities";
export { anthropicCardModel, anthropicTopicModel, type ClaimModel, type ModelReply } from "./model";
export { cardLabel, formatTopicInput, MAX_CARDS_PER_CALL, readTopicMap, topicReport, TOPICS_JSON_SCHEMA, TOPICS_MODEL, TOPICS_PROMPT_VERSION, UNASSIGNED, type MappedTopic, type TopicMember, type TopicReading, type TopicReport } from "./topicMap";
export { buildTopicMap, latestMapVersion, mapMembers, type TopicMapResult } from "./topics";
export { formatBatch } from "./prompt";
export { readAnswer, readRecollection, type AnswerReading, type RecollectionReading } from "../verify";
export { contentWords, findHedge, groundEntities, locate, type PartLine } from "./verify";
export { PREDICATES, PREDICATE_NAMES, type Predicate } from "./vocabulary";
