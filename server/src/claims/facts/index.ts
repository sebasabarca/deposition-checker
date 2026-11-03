// Public entry point of Stage 2: source-grounded fact and event extraction (DESIGN.md, "Stage 2").
// Stage 3 reads the verified index through verifiedFacts(); it never reads rejected or stale facts, or
// facts of excluded document copies.

export { attributeKey, ATTRIBUTION_STATUSES, contentTokens, factsJsonSchema, MAX_UNITS_PER_BATCH, unitKeyLabel, valueLeaks, EPISTEMIC_STATUSES, FACT_EXTRACTOR_VERSION, FACT_KINDS, FACT_SCHEMA_VERSION, FACTS_JSON_SCHEMA, FACTS_MODEL, FACTS_PROMPT_VERSION, GENERIC_DIMENSIONS, ModelFact, NO_FACT_REASONS, normalizeDimension, POLARITIES, SOURCE_VERIFICATIONS, valueWordsIn, valueWordsInDimension, yesNoNamesValue, type AttributionStatus, type EpistemicStatus, type FactKind, type Polarity, type Provenance, type ProvisionalEvent, type SemanticStatus, type SourceVerification, type ValueSupport } from "./contracts";
export { buildUnits, CONTEXT_SPANS, loadDocument, MAX_UNIT_CHARS, WINDOW_OVERLAP_SPANS, windowsOf, type Span, type StoredDocument, type StoredMember, type StoredPart, type Unit } from "./context";
export { batchUnits, contextLabel, estimateFacts, FACT_MAX_OUTPUT_TOKENS, FACTS_SYSTEM_PROMPT, formatBatch, formatUnit, MAX_BATCH_CHARS, spanLabel, unitLabel, type FactEstimate } from "./prompt";
export { checkFact, emptySignals, factKeyOf, openingMatches, readFacts, type CheckedFact, type FactReading, type UnitOutcome } from "./verify";
export { DUE, storedFactKeys, syncUnits, verifiedFacts, type FactFilter, type UnitStatus, type VerifiedFact } from "./store";
export { extractFacts, FACT_CONCURRENCY, planFacts, type FactExtractOptions, type FactExtractResult } from "./extract";
export { compatibility, evaluateRecall, factCoverage, QUESTION_OVERLAP_COMPATIBLE, type LabelledFact } from "./coverage";
