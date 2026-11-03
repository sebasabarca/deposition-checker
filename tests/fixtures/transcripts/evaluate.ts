// Compares a parsed transcript with its hand-verified ground truth. Used by the format tests and by
// scripts/transcript-validation.ts, which reports the same measures per sample.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { readDeposition, type DepositionRead } from "../../../server/src/ingest";

// Tests and scripts run from the repository root.
const ROOT = process.cwd();
const DIR = path.join(ROOT, "tests/fixtures/transcripts");

export type Sample = { id: string; file: string; format: string; kind: "genuine" | "derived"; source?: string; derivedFrom?: string; sha256: string; ground: string; notes?: string };
export type Ground = {
  witness: string;
  pages: { count: number; linesPerPage: number[] };
  lines: { ref: string; text: string; role?: string; speaker?: string }[];
  exchanges: { question: [string, string]; answer: [string, string]; note?: string }[];
  warnings: string[];
};
export type Measure = { right: number; of: number };
export type Evaluation = {
  sample: Sample;
  read: DepositionRead;
  pages: Measure; // pages with the right printed number and line count
  lines: Measure; // ground lines found at their page:line (whitespace aside)
  text: Measure; // ground lines whose text is exactly the original
  speakers: Measure; // ground lines with the right role (and named speaker)
  exchanges: Measure; // Q/A pairs grouped as one exchange with the right line roles
  warnings: Measure; // expected warnings present
  deterministic: boolean;
  misses: string[];
};

export const samples = (): Sample[] => (JSON.parse(readFileSync(path.join(DIR, "samples.json"), "utf8")) as { samples: Sample[] }).samples;
export const ground = (s: Sample): Ground => JSON.parse(readFileSync(path.join(DIR, s.ground), "utf8"));
export const filePath = (s: Sample) => path.join(ROOT, s.file);
export const available = (s: Sample) => existsSync(filePath(s));

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const refOf = (l: { printedPage: number | null; lineNo: number }) => `${l.printedPage}:${l.lineNo}`;
const fraction = (items: boolean[]): Measure => ({ right: items.filter(Boolean).length, of: items.length });

export async function evaluate(s: Sample): Promise<Evaluation> {
  const data = new Uint8Array(readFileSync(filePath(s)));
  const g = ground(s);
  const misses: string[] = [];
  const sha = createHash("sha256").update(data).digest("hex");
  if (sha !== s.sha256) misses.push(`file hash ${sha} differs from the manifest`);
  const read = await readDeposition(data, undefined, undefined, g.witness);
  const again = await readDeposition(data, undefined, undefined, g.witness);
  const deterministic = JSON.stringify(read) === JSON.stringify(again);
  if (read.format !== s.format) misses.push(`read as ${read.format ?? "pdf"}, expected ${s.format}`);

  const pages = read.pdf?.pages ?? [];
  const pageChecks = g.pages.linesPerPage.map((n, i) => {
    const ok = pages[i]?.printedPage === i + 1 && pages[i]?.lines.length === n;
    if (!ok) misses.push(`page ${i + 1}: parsed as page ${pages[i]?.printedPage} with ${pages[i]?.lines.length} lines, expected ${n}`);
    return ok;
  });
  if (pages.length !== g.pages.count) misses.push(`${pages.length} pages parsed, expected ${g.pages.count}`);

  const lines = read.exchanges?.lines ?? [];
  const at = new Map(lines.map((l) => [refOf(l), l]));
  const lineChecks: boolean[] = [];
  const textChecks: boolean[] = [];
  const speakerChecks: boolean[] = [];
  for (const want of g.lines) {
    const got = at.get(want.ref);
    lineChecks.push(got !== undefined && squash(got.rawText) === squash(want.text));
    textChecks.push(got?.rawText === want.text);
    if (got?.rawText !== want.text) misses.push(`${want.ref}: text ${JSON.stringify(got?.rawText)} expected ${JSON.stringify(want.text)}`);
    if (want.role) {
      const ok = got?.role === want.role && (want.speaker === undefined || got?.speakerName === want.speaker);
      speakerChecks.push(ok);
      if (!ok) misses.push(`${want.ref}: role ${got?.role}/${got?.speakerName} expected ${want.role}/${want.speaker ?? "-"}`);
    }
  }

  // An exchange is right when one exchange holds the whole question as question lines and the whole
  // answer as answer lines.
  const indexOf = new Map(lines.map((l) => [refOf(l), l.index]));
  const span = ([first, last]: [string, string]) => {
    const a = indexOf.get(first), b = indexOf.get(last);
    return a === undefined || b === undefined ? null : lines.slice(a, b + 1).map((l) => l.index);
  };
  const exchangeChecks = g.exchanges.map((e) => {
    const q = span(e.question), a = span(e.answer);
    const found = q && a && read.exchanges!.exchanges.find((x) => x.lines.some((l) => l.index === q[0]));
    const role = (i: number) => found?.lines.find((l) => l.index === i)?.role;
    const ok = !!found && q!.every((i) => role(i) === "question") && a!.every((i) => role(i) === "answer");
    if (!ok) misses.push(`exchange ${e.question[0]}–${e.answer[1]} is not grouped as question ${e.question.join("–")} and answer ${e.answer.join("–")}`);
    return ok;
  });

  const warnings = read.validation.warnings ?? [];
  const warningChecks = g.warnings.map((w) => {
    const ok = warnings.some((x) => x.includes(w));
    if (!ok) misses.push(`missing warning: ${w}`);
    return ok;
  });
  if (!deterministic) misses.push("two readings of the same file differ");

  return { sample: s, read, pages: fraction(pageChecks), lines: fraction(lineChecks), text: fraction(textChecks), speakers: fraction(speakerChecks), exchanges: fraction(exchangeChecks), warnings: fraction(warningChecks), deterministic, misses };
}
