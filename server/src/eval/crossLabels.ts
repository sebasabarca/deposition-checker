// Cross-witness evaluation labels (data/eval/*-cross-*.json): which pairs of passages from two
// different witnesses are expected to conflict, and which are negative controls that must not be
// reported. Labels are references and short notes, never transcript text, and come from people,
// never from a model's output. A passage is anchored by the line numbers its file prints (an archive's
// statement numbers) or by an exact phrase from it, so the anchor doesn't depend on how a file is read.

import { readFile } from "node:fs/promises";
import { z } from "zod";

// conflict: established, materially incompatible claims (the only strict positives).
// conflict_needs_context: review-worthy disagreements that need context; never strict positives.
// no_conflict: verified negative controls.
// exploratory: shared-topic cases kept for inspection, never scored.
export const EXPECTED = ["conflict", "conflict_needs_context", "no_conflict", "exploratory"] as const;

const Anchor = z.union([
  // part: which run of an archive's count, when the count starts again; omitted for a single run.
  z.strictObject({ document: z.string().min(1), part: z.number().int().positive().optional(), lines: z.array(z.number().int().positive()).min(1) }),
  z.strictObject({ document: z.string().min(1), phrase: z.string().min(3).max(200) }),
]);
export type Anchor = z.infer<typeof Anchor>;

const Pair = z.strictObject({
  id: z.string().min(1),
  topic: z.string().min(1),
  expected: z.enum(EXPECTED),
  a: Anchor,
  b: Anchor,
  note: z.string().trim().min(1).max(600),
});

const Document = z.strictObject({
  file: z.string().min(1), // relative to the set's root directory, which is given when the set is run
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  witness: z.string().min(1),
  takenOn: z.iso.date(),
  session: z.string().min(1), // how the session is named in citations, e.g. "Feb 11, 1996, cross-examination"
});

// One comparison: the witnesses whose sessions are compared, and the labelled pairs between them.
const Comparison = z.strictObject({ id: z.string().min(1), witnessA: z.string().min(1), witnessB: z.string().min(1), pairs: z.array(Pair) });

export const CrossLabelFile = z
  .strictObject({
    version: z.literal(1),
    set: z.string().min(1),
    synthetic: z.boolean(),
    about: z.string(),
    documents: z.record(z.string(), Document),
    comparisons: z.array(Comparison).min(1),
    // Candidates reviewed and left out of the set, with the reason: recorded, never silently dropped.
    exclusions: z.array(z.strictObject({ id: z.string().min(1), reason: z.string().min(1).max(600) })).optional(),
    // What changed from the set this one supersedes, label by label; the earlier file is kept unchanged.
    supersedes: z.string().optional(),
    // The labelling rules the reviewer applied, in words, so a later reader knows what "strict" meant.
    policy: z.array(z.string().min(1).max(800)).optional(),
    // from: null when the label is new in this version.
    changelog: z.array(z.strictObject({ id: z.string().min(1), from: z.enum(EXPECTED).nullable(), to: z.enum(EXPECTED), date: z.iso.date(), reason: z.string().min(1).max(600) })).optional(),
  })
  .superRefine((file, ctx) => {
    file.comparisons.forEach((c, ci) => {
      if (c.witnessA === c.witnessB) ctx.addIssue({ code: "custom", message: "a comparison needs two different witnesses", path: ["comparisons", ci] });
      c.pairs.forEach((p, pi) => {
        for (const side of ["a", "b"] as const) {
          const doc = file.documents[p[side].document];
          if (!doc) ctx.addIssue({ code: "custom", message: `unknown document "${p[side].document}"`, path: ["comparisons", ci, "pairs", pi, side] });
          else if (doc.witness !== (side === "a" ? c.witnessA : c.witnessB)) ctx.addIssue({ code: "custom", message: `side ${side} must be ${side === "a" ? c.witnessA : c.witnessB}'s testimony`, path: ["comparisons", ci, "pairs", pi, side] });
        }
      });
    });
  });
export type CrossLabelFile = z.infer<typeof CrossLabelFile>;

export async function readCrossLabelFile(path: string): Promise<CrossLabelFile> {
  return CrossLabelFile.parse(JSON.parse(await readFile(path, "utf8")));
}

const squash = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();

const PHRASE_WINDOW = 6; // a quoted phrase may wrap over this many consecutive stored lines

// The stored lines an anchor names, in one document's lines (in transcript order). Pure. Empty when nothing
// matches, which the scorer reports rather than guessing. A phrase is looked for on one line first, then
// across consecutive lines (a quotation that wraps), taking the shortest run that contains it.
export function resolveAnchor(anchor: Anchor, lines: readonly { id: number; page: number; line: number; text: string }[]): number[] {
  if ("lines" in anchor) {
    // A document in parts needs the part: without it a number may name several statements.
    const parts = new Set(lines.map((l) => l.page));
    if (anchor.part === undefined && parts.size > 1) return [];
    return lines.filter((l) => anchor.lines.includes(l.line) && (anchor.part === undefined || l.page === anchor.part)).map((l) => l.id);
  }
  const phrase = squash(anchor.phrase);
  const single = lines.filter((l) => squash(l.text).includes(phrase)).map((l) => l.id);
  if (single.length) return single;
  for (let size = 2; size <= PHRASE_WINDOW; size++) {
    for (let i = 0; i + size <= lines.length; i++) {
      const run = lines.slice(i, i + size);
      if (squash(run.map((l) => l.text).join(" ")).includes(phrase)) return run.map((l) => l.id);
    }
  }
  return [];
}

// Pure. Grows resolved lines to the whole answer they belong to: the unbroken run of the witness's lines
// around them, so a finding that cites any part of that answer (a qualifier included) counts.
export function wholeAnswer(ids: readonly number[], lines: readonly { id: number; role: string }[]): number[] {
  const at = new Set(ids);
  const out = new Set(ids);
  lines.forEach((l, i) => {
    if (!at.has(l.id) || l.role !== "witness") return;
    for (let j = i - 1; j >= 0 && lines[j].role === "witness"; j--) out.add(lines[j].id);
    for (let j = i + 1; j < lines.length && lines[j].role === "witness"; j++) out.add(lines[j].id);
  });
  return lines.filter((l) => out.has(l.id)).map((l) => l.id);
}
