// Measures the transcript format adapters against every sample's hand-verified ground truth and prints
// a Markdown table (pasted into docs/transcript-formats.md). No model calls; samples absent from
// data/raw/transcripts are listed as missing. Run: npx tsx scripts/transcript-validation.ts

import { available, evaluate, ground, samples, type Measure } from "../tests/fixtures/transcripts/evaluate";

const pct = (m: Measure) => (m.of === 0 ? "–" : `${m.right}/${m.of}${m.right === m.of ? "" : ` (${Math.round((m.right / m.of) * 100)}%)`}`);

(async () => {
  const rows: string[] = [];
  for (const s of samples()) {
    if (!available(s)) {
      rows.push(`| ${s.id} | ${s.kind} | ${s.format} | missing: ${s.file} | | | | | | | | |`);
      continue;
    }
    const e = await evaluate(s);
    const g = ground(s);
    const lines = e.read.pdf?.pages.reduce((n, p) => n + p.lines.length, 0) ?? 0;
    rows.push(`| ${s.id} | ${s.kind} | ${s.format} | ${e.read.pdf?.pages.length ?? 0} pages, ${lines} lines | ${pct(e.pages)} | ${pct(e.lines)} | ${pct(e.text)} | ${pct(e.speakers)} | ${pct(e.exchanges)} | ${(e.read.validation.warnings ?? []).length} (${pct(e.warnings)} expected) | ${e.read.validation.status === "ready" ? 0 : 1} | ${e.deterministic ? "yes" : "no"} |`);
    for (const m of e.misses) rows.push(`|  | | | ↳ ${m.replaceAll("|", "\\|")} | | | | | | | | |`);
    void g;
  }
  console.log("| Sample | Kind | Format | Parsed | Pages | Lines at page:line | Exact text | Speakers | Q/A exchanges | Warnings | Parse failures | Same on rerun |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) console.log(r);
})();
