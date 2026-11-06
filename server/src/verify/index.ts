// Public entry point of the verify module: deterministic checks of model output against the stored
// source lines (DESIGN.md, "Evidence verification"). Pure functions only.
//
// quotes.ts is v1's quote matching, moved here unchanged: its exports (normalize, quoteMatchScore,
// verifyQuote, STOPWORDS) keep their names and behaviour, so `import … from "./verify"` still works.

export { normalize, quoteMatchScore, STOPWORDS, verifyQuote } from "./quotes";
export { readAnswer, readRecollection, type AnswerReading, type RecollectionReading } from "./answers";
export { contentWords, findHedge, locate, spoken } from "./text";
export { APPROXIMATE, checkSide, checkSources, isBareAnswer, locatePhrase, matchScore, type Located, VERIFIED, type EvidenceExchange, type EvidenceLine, type EvidenceStatus, type Location, type SideSource, type SourceCheck } from "./source";
export { attributeSide, checkAttribution, codeLevelOf, codeReadingOf, LEVELS, type AttributionCheck, type Level, type SideAttribution } from "./attribution";
export { hasCoverageGaps, sessionCoverage, type Gap, type SessionCoverage } from "./coverage";
