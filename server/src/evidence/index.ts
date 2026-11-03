// Public entry point of the evidence module (Stage 1): source references in their own scheme, the
// evidence fields of an exchange, and the original-testimony index over stored exchanges. No model calls.

export { formatRef, isCitable, REFERENCE_SCHEMES, schemeOf, sourceLineId, type ReferenceScheme } from "./references";
export { evidenceFieldsOf, evidenceKeyOf, SPEAKER_STATUSES, speakerStatusOf, textHashOf, type MemberLine, type SpeakerStatus } from "./exchange";
export { answerGroup, createSession, evidenceCoverage, getEvidence, indexEvidence, nextSessionPart, searchEvidence, sourceContext, type EvidenceExchange, type SearchFilters, type SourceRef } from "./store";
export { attributionReport, correctInPlace, parserAudit, reprocessDocument, reprocessImpact, storedAttribution, type AttributionCause, type AttributionReport } from "./audit";
