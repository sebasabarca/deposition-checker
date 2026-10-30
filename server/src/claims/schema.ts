// What the extraction model returns, checked with zod. The model reads; it never scores: there is no
// confidence, score or probability field, and the strict objects reject any extra key.

import { z } from "zod";
import { CLAIM_SOURCES, EPISTEMIC, POLARITIES, PREDICATE_NAMES } from "./vocabulary";

export const ExtractedClaim = z.strictObject({
  exchangeId: z.string(), // "E1453": a part of the batch; checked in code
  source: z.enum(CLAIM_SOURCES),
  keyPhrase: z.string(),
  answerPhrase: z.string().nullable(),
  subject: z.string(),
  predicate: z.enum(PREDICATE_NAMES),
  object: z.string().nullable(),
  polarity: z.enum(POLARITIES),
  epistemic: z.enum(EPISTEMIC),
  time: z.string().nullable(),
  place: z.string().nullable(),
  quantity: z.string().nullable(),
  entities: z.array(z.string()),
  dependsOnEarlierExchange: z.boolean(), // true when the claim can't be understood from this exchange alone
});

export const ExtractionOutput = z.strictObject({ claims: z.array(ExtractedClaim) });

export type ExtractedClaim = z.infer<typeof ExtractedClaim>;
export type ExtractionOutput = z.infer<typeof ExtractionOutput>;

// The JSON schema sent as the structured-output format.
const { $schema: _unused, ...jsonSchema } = z.toJSONSchema(ExtractionOutput);
export const EXTRACTION_JSON_SCHEMA = jsonSchema;
