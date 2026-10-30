// Rubric v1 (DESIGN.md, "Confidence scoring"): every weight, cap and threshold the scoring engine
// uses, in one frozen object. Approved provisionally and frozen for the initial evaluation; any change
// ships as a new, explained rubric version, and every finding stores the version that scored it.

export const RUBRIC_V1 = Object.freeze({
  version: "v1",
  // A: attribution and source quality, per side
  exactMatch: 2,
  attribution: Object.freeze({ clear: 8, qualified: 4 }),
  falsePositiveAttribution: 8, // a side whose label code doesn't contradict
  // C: context sufficiency
  wholeExchanges: 5,
  noMoreContextNeeded: 5,
  // S: semantic support, by classification (max 30)
  direct: Object.freeze({ sameEventYes: 12, sameEventUncertain: 4, conflictBasis: 12, scopeYes: 6, scopeUncertain: 2 }),
  inferential: Object.freeze({ sameEventYes: 10, sameEventUncertain: 3, supportedSteps: 10, assumptions: Object.freeze([10, 5, 0]) }),
  falsePositive: Object.freeze({ reasonGiven: 15, reasonConsistent: 15 }),
  // K: independent corroboration
  corroborationEach: 5,
  corroborationMax: 15,
  // U: uncertainty allowance and its deductions
  uncertainty: 25,
  alternativeExplanation: 10,
  approximationPerSide: 5,
  extractionDisagreement: 5,
  // Caps, applied after the sum; the lowest applicable cap wins
  caps: Object.freeze({ notAdopted: 40, qualified: 70, notSameEvent: 25, compatibleTimes: 60, incompatibleTimes: 60, unsupportedReason: 60 }),
  bands: Object.freeze({ high: 75, medium: 50 }),
});

export type Rubric = typeof RUBRIC_V1;
