// Public entry point of the claims module: statement cards, the topic map and Stage 2 facts, checked against the
// stored source lines. Only this module and adjudicate/ call a model, and
// every call is recorded with recordCall.

export { addressedShare, CARDS_JSON_SCHEMA, ExtractedCard, isNegated, MIN_ADDRESSED_SHARE, mergeCoverage, readCards, screenNoAssertion, type CardReading, type CheckedCard, type Chunk, type ChunkExchange, type Coverage, type CoverageStatus, type ModelReply as CardModelReply } from "./cards";
export { CARD_EXTRACTOR_VERSION, CARD_MAX_OUTPUT_TOKENS, CARDS_MODEL, CARDS_PROMPT_VERSION, CARDS_SYSTEM_PROMPT, CHUNK_OVERLAP_PAGES, chunkByPages, estimateCards, PAGES_PER_CHUNK, PLANNING_CARD_OUTPUT_SHARE, type CardEstimate } from "./cardPrompt";
export { normalizeEntities, normalizeEntity } from "./entities";
export { anthropicCardModel, anthropicFactModel, anthropicTopicModel, type ClaimModel, type ModelReply } from "./model";
export { cardLabel, formatTopicInput, MAX_CARDS_PER_CALL, readTopicMap, topicReport, TOPICS_JSON_SCHEMA, TOPICS_MODEL, TOPICS_PROMPT_VERSION, UNASSIGNED, type MappedTopic, type TopicMember, type TopicReading, type TopicReport } from "./topicMap";
export { formatBatch } from "./prompt";
export { readAnswer, readRecollection, type AnswerReading, type RecollectionReading } from "../verify";
export { contentWords, findHedge, groundEntities, locate, type PartLine } from "./verify";
export { PREDICATES, PREDICATE_NAMES, type Predicate } from "./vocabulary";
