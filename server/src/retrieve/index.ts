// Public entry point of the retrieve module. Path B (full text) so far; Path A (claims), merging,
// the per-exchange cap and stored candidates come later.

export { findPathB, MATCHES_PER_QUERY, type PathBResult } from "./pathB";
export { COURTROOM_WORDS, MIN_CONTENT_TERMS, proceduralReason, type ProceduralReason } from "./procedural";
export { queryTerms, RARE_TERMS_PER_QUERY, type PathBQueryMode } from "./query";
export { rankPairs, type LogicalExchange, type Match, type PartInfo, type RankedPair } from "./rank";
export { idf, MIN_SHARED_TERMS, pairScore, type PairScore, type TermFrequency } from "./score";
