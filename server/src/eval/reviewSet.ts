// The human review set: the shape of its tracked file, and reading the labels back from the review
// sheet. Pure apart from reading a file. The tracked file holds references only; testimony stays in
// the git-ignored sheet. Human fields are separate from the model's verdict, which is never ground
// truth. Retrieval code must not read this file: its pairs are evaluation targets.

import { z } from "zod";

export const HUMAN_CLASSIFICATIONS = ["direct_contradiction", "inferential_contradiction", "compatible", "insufficient_evidence", "uncertain_needs_expert_review"] as const;

const Side = z.strictObject({ document: z.string().regex(/^[0-9a-f]{12}$/), depositionId: z.number().int().positive(), exchangeId: z.number().int().positive(), group: z.number().int().positive(), range: z.string().min(1) });
export const ReviewPair = z.strictObject({
  id: z.string().regex(/^R\d{2}$/),
  source: z.enum(["real", "synthetic"]),
  caseName: z.string(),
  witness: z.string(),
  a: Side,
  b: Side,
  retrieval: z.strictObject({ set: z.string(), sources: z.array(z.string()), rank: z.number().int() }),
  modelVerdict: z.strictObject({ note: z.literal("model-generated; not ground truth"), classification: z.string(), promptVersion: z.string(), citationStatus: z.string() }),
  human: z.strictObject({ classification: z.enum(HUMAN_CLASSIFICATIONS).nullable(), comparable: z.boolean().nullable(), notes: z.string() }),
});
export const ReviewSet = z.strictObject({ version: z.literal(1), about: z.string(), choices: z.array(z.string()), pairs: z.array(ReviewPair).min(1) });
export type ReviewSet = z.infer<typeof ReviewSet>;
export type ReviewPair = z.infer<typeof ReviewPair>;

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') cell += text[++i];
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ",") (row.push(cell), (cell = ""));
    else if (c === "\n") (row.push(cell.replace(/\r$/, "")), rows.push(row), (row = []), (cell = ""));
    else cell += c;
  }
  if (cell || row.length) (row.push(cell), rows.push(row));
  return rows;
}

const COMPARABLE: Record<string, boolean> = { yes: true, no: false };

// Copies the filled-in human columns onto the set. A value outside the choices throws: a typo in a
// label must never become a silent blank. An empty cell stays unlabelled.
export function applySheet(set: ReviewSet, csv: string): ReviewSet {
  const [header, ...rows] = parseCsv(csv);
  const column = (name: string) => {
    const at = header.indexOf(name);
    if (at < 0) throw new Error(`The sheet has no ${name} column.`);
    return at;
  };
  const [id, classification, comparable, notes] = ["id", "human_classification", "human_comparable", "human_notes"].map(column);
  const filled = new Map(rows.filter((r) => r[id]).map((r) => [r[id], r]));
  return ReviewSet.parse({
    ...set,
    pairs: set.pairs.map((p) => {
      const r = filled.get(p.id);
      if (!r) return p;
      const label = r[classification].trim();
      const same = r[comparable].trim().toLowerCase();
      if (same && !(same in COMPARABLE)) throw new Error(`${p.id}: human_comparable must be yes or no, not "${same}".`);
      return { ...p, human: { classification: label || null, comparable: same ? COMPARABLE[same] : null, notes: r[notes].trim() } };
    }),
  });
}
