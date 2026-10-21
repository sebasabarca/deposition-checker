import { z } from "zod";

export const CONTRADICTION_TYPES = [
  "direct",
  "inferential",
  "false_positive",
] as const;

export const CandidateSchema = z.object({
  t1_id: z.string(),
  t2_id: z.string(),
  t1_quote: z.string(),
  t2_quote: z.string(),
  proposed_type: z.enum(CONTRADICTION_TYPES),
  explanation: z.string(),
});

export const CandidatesSchema = z.object({
  contradictions: z.array(CandidateSchema),
});

export type Candidate = z.infer<typeof CandidateSchema>;
