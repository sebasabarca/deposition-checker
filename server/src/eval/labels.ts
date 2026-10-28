// The evaluation label file (data/eval/*.json): its shape, checked with zod when it is read.
// Pairs point at passages by document (whose PDF SHA-256 the file declares) and printed page:line,
// never by database IDs, which change on re-ingestion. Resolving them to exchanges is the evaluation's job.

import { readFile } from "node:fs/promises";
import { z } from "zod";

export const LABELS = [
  "potentially_contradictory",
  "related_compatible",
  "different_events",
  "ambiguous",
  "qualified",
  "lack_of_recollection",
] as const;

const PageLine = z.strictObject({
  document: z.string().min(1),
  page: z.number().int().positive(),
  line: z.number().int().positive(),
});

const LabelledPair = z.strictObject({
  a: PageLine,
  b: PageLine,
  label: z.enum(LABELS),
  retrievalRelevant: z.boolean(),
  note: z.string().trim().min(1).max(500), // a short explanation, not transcript text
});

export const LabelFile = z
  .strictObject({
    version: z.literal(1),
    set: z.string().min(1),
    synthetic: z.boolean(),
    about: z.string(),
    documents: z.record(z.string(), z.strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/), source: z.string() })),
    definitions: z.record(z.string(), z.string()),
    pairs: z.array(LabelledPair),
  })
  .superRefine((file, ctx) => {
    for (const label of LABELS) {
      if (!file.definitions[label]) ctx.addIssue({ code: "custom", message: `definition missing for "${label}"`, path: ["definitions"] });
    }
    file.pairs.forEach((pair, i) => {
      for (const side of ["a", "b"] as const) {
        if (!file.documents[pair[side].document]) {
          ctx.addIssue({ code: "custom", message: `unknown document "${pair[side].document}"`, path: ["pairs", i, side, "document"] });
        }
      }
      // A pair is always two sessions (DESIGN.md: contradictions within one session are out of scope).
      if (pair.a.document === pair.b.document) {
        ctx.addIssue({ code: "custom", message: "both sides are in the same document", path: ["pairs", i] });
      }
    });
  });

export type LabelFile = z.infer<typeof LabelFile>;

export async function readLabelFile(path: string): Promise<LabelFile> {
  return LabelFile.parse(JSON.parse(await readFile(path, "utf8")));
}
