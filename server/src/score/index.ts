// Scoring (DESIGN.md, "Confidence scoring"): the frozen rubric, code's own checks, score() and
// prioritize(). Pure functions only.

export { anchorsOf, contextCheck, corroborate, timeCheckOf, type ContextCheck, type CorroborationCheck } from "./checks";
export { RUBRIC_V1, type Rubric } from "./rubric";
export { prioritize, score, toBand, type Assessment, type Band, type Cap, type Factor, type Origin, type Priority, type ScoringInput } from "./score";
export { EVIDENCE_STRENGTH_VERSION, evidenceStrength, HIGH_FROM, MEDIUM_FROM, priorityOf, unscoredReasonOf, type EvidenceStrength, type StrengthCheck } from "./evidenceStrength";
