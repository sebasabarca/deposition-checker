// Public entry point of the retrieve module: hybrid retrieval. Path A from statement cards and topics,
// Path B from full text, and the union with its allocation.

export { findPathB, MATCHES_PER_QUERY, type PathBResult } from "./pathB";
export { COURTROOM_WORDS, MIN_CONTENT_TERMS, proceduralReason, type ProceduralReason } from "./procedural";
export { queryTerms, RARE_TERMS_PER_QUERY, type PathBQueryMode } from "./query";
export { rankPairs, type LogicalExchange, type Match, type PartInfo, type RankedPair } from "./rank";
export { idf, MIN_SHARED_TERMS, pairScore, type PairScore, type TermFrequency } from "./score";
export { CARD_SIGNALS, cardSignal, findTopicPairs, OBJECT_OVERLAP, objectsOverlap, pairCards, pairExclusion, PATH_A_RANKING_VERSION, tierOf, type CardSignal, type PairableCard, type TopicPair } from "./topicPairs";
export { HYBRID_PER_EXCHANGE_CAP, hybridRetrievalVersion, PATH_A_SHARE, unionCandidates, type Evidence, type Pool, type PoolCandidate } from "./union";
export { countsToward, provenanceOf, type Provenance } from "./provenance";
