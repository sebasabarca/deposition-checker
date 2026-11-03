// What the cross-witness discovery model returns, checked with zod. Strict objects reject any extra
// key, so an answer carrying a score or a confidence fails. Short by design (see discoverCrossPrompt.ts).

import { z } from "zod";

export const CROSS_CLASSIFICATIONS = ["direct_conflict", "possible_conflict_needs_context", "recollection_or_knowledge_difference", "compatible"] as const;
export const KNOWLEDGE_BASES = ["personal_observation", "told_by_someone", "belief_or_inference", "unclear"] as const;

export const CrossFinding = z.strictObject({
  finding_id: z.string(),
  subject: z.string(),
  classification: z.enum(CROSS_CLASSIFICATIONS),
  session_a: z.string(),
  citation_a: z.string(),
  excerpt_a: z.string(),
  basis_a: z.enum(KNOWLEDGE_BASES),
  session_b: z.string(),
  citation_b: z.string(),
  excerpt_b: z.string(),
  basis_b: z.enum(KNOWLEDGE_BASES),
  explanation: z.string(),
  missing_context: z.string(),
});
export type CrossFinding = z.infer<typeof CrossFinding>;

export const CrossOutput = z.strictObject({
  summary: z.strictObject({ completion_status: z.enum(["complete", "partial"]), limitations: z.array(z.string()) }),
  findings: z.array(CrossFinding),
});
export type CrossOutput = z.infer<typeof CrossOutput>;

const { $schema: _unused, ...jsonSchema } = z.toJSONSchema(CrossOutput);
export const CROSS_JSON_SCHEMA = jsonSchema as Record<string, unknown>;

// Pure. Separates output that isn't valid from a valid answer with no findings.
export function readCrossOutput(text: string | null): { output: CrossOutput | null; error: string | null } {
  if (!text) return { output: null, error: "no output" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { output: null, error: "the output is not JSON" };
  }
  const parsed = CrossOutput.safeParse(json);
  return parsed.success ? { output: parsed.data, error: null } : { output: null, error: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
}
