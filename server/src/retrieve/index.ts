// Public entry point of the retrieve module: Path A (claims), Path B (full text), and the pure merge.
// Stored candidates arrive with analysis jobs.

export { findPathB, MATCHES_PER_QUERY, type PathBResult } from "./pathB";
export { COURTROOM_WORDS, MIN_CONTENT_TERMS, proceduralReason, type ProceduralReason } from "./procedural";
export { queryTerms, RARE_TERMS_PER_QUERY, type PathBQueryMode } from "./query";
export { rankPairs, type LogicalExchange, type Match, type PartInfo, type RankedPair } from "./rank";
export { idf, MIN_SHARED_TERMS, pairScore, type PairScore, type TermFrequency } from "./score";
export { claimSignal, findPathA, OBJECT_OVERLAP, objectsOverlap, SIGNALS, type ClaimPair, type Signal, type SignalClaim } from "./pathA";
export { mergeCandidates, PAIR_BUDGET, PER_EXCHANGE_CAP, RRF_K, selectCandidates, type Candidate, type Deferred, type Evidence, type Path } from "./merge";
