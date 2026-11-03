// Labelled discrepancies in real testimony (data/eval/*-discrepancies-*.json), scored as two separate
// questions. Discovery: did any proposal point at both passages, whatever it called them? Classification:
// for a discovered pair, did the model read it as the label says? A model can find the right pair and
// misread it, or read well and never find it; one score would hide which. Pure, apart from reading the file.
// Passages are anchored by document hash and printed page:line, never database IDs.

import { readFile } from "node:fs/promises";
import { z } from "zod";
import { parseCitation } from "../verify";

// What a person decided the discrepancy is. direct_conflict: both can't be true as stated. correction: a
// later account changes an earlier one, as a correction would. context_dependent: whether they conflict
// turns on a fact the testimony doesn't settle.
export const DISCREPANCY_CLASSES = ["direct_conflict", "correction", "context_dependent"] as const;
export type DiscrepancyClass = (typeof DISCREPANCY_CLASSES)[number];

const PageLine = z.string().regex(/^\d+:\d{1,2}$/);
const Range = z.strictObject({ document: z.string().min(1), from: PageLine, to: PageLine });

const Discrepancy = z.strictObject({
  id: z.string().min(1),
  topic: z.string().min(1),
  // Any of these passages counts for a side: the same account can be cited at more than one place.
  a: z.array(Range).min(1),
  b: z.array(Range).min(1),
  classification: z.strictObject({
    expected: z.enum(DISCREPANCY_CLASSES),
    // provisional: proposed, not yet decided by the developer; decided: a person's decision.
    status: z.enum(["provisional", "decided"]),
    decidedBy: z.string().min(1),
    basis: z.string().min(1).max(800),
  }),
  note: z.string().max(800),
});

export const DiscrepancyFile = z
  .strictObject({
    version: z.literal(1),
    set: z.string().min(1),
    about: z.string(),
    documents: z.record(z.string(), z.strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/), witness: z.string().min(1), takenOn: z.iso.date(), source: z.string() })),
    discrepancies: z.array(Discrepancy).min(1),
  })
  .superRefine((file, ctx) => {
    file.discrepancies.forEach((d, i) => {
      for (const side of ["a", "b"] as const)
        for (const r of d[side]) if (!file.documents[r.document]) ctx.addIssue({ code: "custom", message: `unknown document "${r.document}"`, path: ["discrepancies", i, side] });
    });
  });
export type DiscrepancyFile = z.infer<typeof DiscrepancyFile>;

export async function readDiscrepancyFile(path: string): Promise<DiscrepancyFile> {
  return DiscrepancyFile.parse(JSON.parse(await readFile(path, "utf8")));
}

// One proposed finding: each side's document (a label file key) and printed citation, and what the model called it.
export type Proposal = { a: { document: string; citation: string }; b: { document: string; citation: string }; modelClassification: string };

// The model's classifications, same-witness (discover-v1) and cross-witness (discover-cross-v2), read as
// label classes. No prompt has a correction class, so a correction is never classified correctly yet.
const READ_AS: Record<string, DiscrepancyClass | "no_conflict"> = {
  direct_contradiction: "direct_conflict",
  inferential_contradiction: "direct_conflict",
  direct_conflict: "direct_conflict",
  uncertain_needs_context: "context_dependent",
  insufficient_evidence: "context_dependent",
  possible_conflict_needs_context: "context_dependent",
  compatible: "no_conflict",
  recollection_or_knowledge_difference: "no_conflict",
};

const at = (ref: string) => {
  const [page, line] = ref.split(":").map(Number);
  return page * 1000 + line;
};

function overlaps(citation: { document: string; citation: string }, ranges: readonly z.infer<typeof Range>[]) {
  const c = parseCitation(citation.citation);
  if (!c) return false;
  const [from, to] = [c.first[0] * 1000 + c.first[1], c.last[0] * 1000 + c.last[1]];
  return ranges.some((r) => r.document === citation.document && from <= at(r.to) && to >= at(r.from));
}

export type DiscrepancyResult = {
  id: string;
  discovered: boolean;
  proposals: number[]; // indexes of the proposals that pointed at both passages
  classification: { expected: DiscrepancyClass; status: "provisional" | "decided"; readAs: (DiscrepancyClass | "no_conflict" | "unknown")[]; correct: boolean | null }; // null: not discovered, so not classified
};

export function scoreDiscrepancies(file: DiscrepancyFile, proposals: readonly Proposal[]) {
  const results: DiscrepancyResult[] = file.discrepancies.map((d) => {
    const hits = proposals.flatMap((p, i) => ((overlaps(p.a, d.a) && overlaps(p.b, d.b)) || (overlaps(p.a, d.b) && overlaps(p.b, d.a)) ? [i] : []));
    const readAs = hits.map((i) => READ_AS[proposals[i].modelClassification] ?? "unknown");
    return { id: d.id, discovered: hits.length > 0, proposals: hits, classification: { expected: d.classification.expected, status: d.classification.status, readAs, correct: hits.length === 0 ? null : readAs.includes(d.classification.expected) } };
  });
  const discovered = results.filter((r) => r.discovered);
  return {
    results,
    discovery: { labelled: results.length, found: discovered.length, missed: results.filter((r) => !r.discovered).map((r) => r.id) },
    classification: { scored: discovered.length, correct: discovered.filter((r) => r.classification.correct).length, wrong: discovered.filter((r) => r.classification.correct === false).map((r) => r.id) },
  };
}
