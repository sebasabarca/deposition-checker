// The adjudicator's structured output (DESIGN.md, "Verdict schema"), checked with zod. Claude
// classifies and reports categorical observations; it never returns a confidence, score, band or
// probability, and the strict objects reject any extra key, so a verdict carrying one fails.

import { z } from "zod";

export const CLASSIFICATIONS = ["direct", "inferential", "false_positive", "insufficient_evidence"] as const;
export const ATTRIBUTIONS = ["asserted", "qualified", "does_not_recall", "reported_by_other", "hypothetical", "attorney_statement", "unclear"] as const;
export const STANCES = ["affirms", "denies", "unclear"] as const;
const TRISTATE = ["yes", "no", "uncertain"] as const;
export const CONFLICT_BASES = ["explicit_negation", "value_conflict", "mutually_exclusive", "requires_inference", "none"] as const;
export const FALSE_POSITIVE_REASONS = [
  "compatible_approximation",
  "different_event",
  "qualified_statement",
  "uncertain_recollection",
  "not_adopted_by_witness",
  "both_can_be_true",
] as const;

export const Verdict = z.strictObject({
  classification: z.enum(CLASSIFICATIONS),
  evidenceAId: z.string(), // must be the packet's exchanges; checked in code
  evidenceBId: z.string(),
  keyPhraseA: z.string(), // Layer 1 check only; never displayed
  keyPhraseB: z.string(),
  attributionA: z.enum(ATTRIBUTIONS),
  attributionB: z.enum(ATTRIBUTIONS),
  stanceA: z.enum(STANCES),
  stanceB: z.enum(STANCES),
  sameEvent: z.enum(TRISTATE),
  scopeAligned: z.enum(TRISTATE),
  conflictBasis: z.enum(CONFLICT_BASES),
  aboutTimingOfSameEvent: z.boolean(),
  inferenceSteps: z.array(z.strictObject({ statement: z.string(), supportingIds: z.array(z.string()) })),
  unestablishedAssumptions: z.array(z.string()),
  falsePositiveReason: z.enum(FALSE_POSITIVE_REASONS).nullable(),
  explanation: z.string(),
  alternativeExplanation: z.string().nullable(),
  needsMoreContext: z.boolean(),
});

// adjudicate-v2 adds how well the alternative explanation is supported, so a speculative reading
// can't pass for an established one. Everything else is unchanged, so v1 and v2 verdicts score alike.
export const ALTERNATIVE_SUPPORT = ["established", "plausible", "speculative"] as const;
export const VerdictV2 = Verdict.extend({ alternativeSupport: z.enum(ALTERNATIVE_SUPPORT).nullable() });

// adjudicate-v3 adds what the conflict rests on and which context lines were used, and why, so code
// can check that a contradiction comes from the two cited exchanges and not from the context.
export const CONFLICT_SOURCES = ["cited_exchanges", "context", "none"] as const;
export const CONTEXT_PURPOSES = ["resolve_reference", "clarify_event_time_or_scope", "short_answer_question", "same_event"] as const;
export const VerdictV3 = VerdictV2.extend({
  conflictSource: z.enum(CONFLICT_SOURCES),
  contextUsed: z.array(z.strictObject({ lines: z.string(), purpose: z.enum(CONTEXT_PURPOSES) })),
});

// adjudicate-v4 adds a detail-by-detail comparison. A difference in a single detail can sit inside
// testimony that otherwise agrees, so the model lists details before it classifies.
export const DETAIL_RELATIONS = ["same", "different", "only_one"] as const;
export const VerdictV4 = VerdictV3.extend({
  detailsCompared: z.array(z.strictObject({ detail: z.string(), sessionA: z.string(), sessionB: z.string(), relation: z.enum(DETAIL_RELATIONS) })),
});

export type Verdict = z.infer<typeof Verdict> & {
  alternativeSupport?: (typeof ALTERNATIVE_SUPPORT)[number] | null;
  conflictSource?: (typeof CONFLICT_SOURCES)[number];
  contextUsed?: { lines: string; purpose: (typeof CONTEXT_PURPOSES)[number] }[];
  detailsCompared?: { detail: string; sessionA: string; sessionB: string; relation: (typeof DETAIL_RELATIONS)[number] }[];
};
export type VerdictV2 = z.infer<typeof VerdictV2>;
export type VerdictV3 = z.infer<typeof VerdictV3>;
export type VerdictV4 = z.infer<typeof VerdictV4>;
export type Attribution = Verdict["attributionA"];
export type Stance = Verdict["stanceA"];
export type Classification = Verdict["classification"];

// The JSON schemas sent as the structured-output format.
const { $schema: _unused, ...jsonSchema } = z.toJSONSchema(Verdict);
export const VERDICT_JSON_SCHEMA = jsonSchema;
const { $schema: _unusedV2, ...jsonSchemaV2 } = z.toJSONSchema(VerdictV2);
export const VERDICT_V2_JSON_SCHEMA = jsonSchemaV2;
const { $schema: _unusedV3, ...jsonSchemaV3 } = z.toJSONSchema(VerdictV3);
export const VERDICT_V3_JSON_SCHEMA = jsonSchemaV3;
const { $schema: _unusedV4, ...jsonSchemaV4 } = z.toJSONSchema(VerdictV4);
export const VERDICT_V4_JSON_SCHEMA = jsonSchemaV4;
