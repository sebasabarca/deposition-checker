// What a direct-discovery model returns, checked with zod. The strict objects reject any extra key,
// so an answer carrying a score or a confidence fails. Same shape as the experiment's output.

import { z } from "zod";

export const DISCOVERY_CLASSIFICATIONS = ["direct_contradiction", "inferential_contradiction", "compatible", "insufficient_evidence", "uncertain_needs_context"] as const;

export const DiscoveryFinding = z.strictObject({
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
  classification: z.enum(DISCOVERY_CLASSIFICATIONS),
  factual_proposition_a: z.string(),
  factual_proposition_b: z.string(),
  conflict_basis: z.string(),
  explanation: z.string(),
  alternative_explanation: z.string(),
  missing_context: z.string(),
  confidence_rationale: z.string(),
});
export type DiscoveryFinding = z.infer<typeof DiscoveryFinding>;

export const DiscoveryOutput = z.strictObject({
  summary: z.strictObject({ completion_status: z.enum(["complete", "partial"]), limitations: z.array(z.string()) }),
  findings: z.array(DiscoveryFinding),
});
export type DiscoveryOutput = z.infer<typeof DiscoveryOutput>;

const { $schema: _unused, ...jsonSchema } = z.toJSONSchema(DiscoveryOutput);
export const DISCOVERY_JSON_SCHEMA = jsonSchema as Record<string, unknown>;

// Pure. Separates output that isn't valid from a valid answer with no findings.
export function readDiscoveryOutput(text: string | null): { output: DiscoveryOutput | null; error: string | null } {
  if (!text) return { output: null, error: "no output" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { output: null, error: "the output is not JSON" };
  }
  const parsed = DiscoveryOutput.safeParse(json);
  return parsed.success ? { output: parsed.data, error: null } : { output: null, error: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
}
