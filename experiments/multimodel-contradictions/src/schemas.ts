// The one logical output schema, for discovery and pair adjudication alike: a pair is a run with one finding.
import { z } from "zod";

export const CLASSIFICATIONS = ["direct_contradiction", "inferential_contradiction", "compatible", "insufficient_evidence", "uncertain_needs_context"] as const;

export const Finding = z.strictObject({
  finding_id: z.string(),
  witness: z.string(),
  session_a: z.enum(["A", "B"]),
  citation_a: z.string(),
  exact_excerpt_a: z.string(),
  session_b: z.enum(["A", "B"]),
  citation_b: z.string(),
  exact_excerpt_b: z.string(),
  shared_subject: z.string(),
  comparable: z.enum(["yes", "no", "uncertain"]),
  classification: z.enum(CLASSIFICATIONS),
  factual_proposition_a: z.string(),
  factual_proposition_b: z.string(),
  conflict_basis: z.string(),
  explanation: z.string(),
  alternative_explanation: z.string(),
  missing_context: z.string(),
  confidence_rationale: z.string(),
});
export type Finding = z.infer<typeof Finding>;

export const RunOutput = z.strictObject({
  summary: z.strictObject({ completion_status: z.enum(["complete", "partial"]), limitations: z.array(z.string()) }),
  findings: z.array(Finding),
});
export type RunOutput = z.infer<typeof RunOutput>;

const { $schema: _unused, ...schema } = z.toJSONSchema(RunOutput);
export const RUN_OUTPUT_JSON_SCHEMA = schema as Record<string, unknown>;

// A model's confidence never replaces verification: a numeric field fails the strict schema, and
// the output is validated here whatever the provider enforced.
export function parseOutput(text: string | null): { output: RunOutput | null; error: string | null } {
  if (!text) return { output: null, error: "no output" };
  try {
    const parsed = RunOutput.safeParse(JSON.parse(text));
    return parsed.success ? { output: parsed.data, error: null } : { output: null, error: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  } catch {
    return { output: null, error: "not JSON" };
  }
}
