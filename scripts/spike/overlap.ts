// Dataset check, not retrieval: do P3171 and P3173 discuss enough of the same subjects to be worth
// analyzing for contradictions? Reads the exchanges written by run.ts for both documents and reports
// shared topic terms and the most similar exchange pairs, for manual review.
//   npx tsx scripts/spike/run.ts p3171 && npx tsx scripts/spike/run.ts p3173 && npx tsx scripts/spike/overlap.ts

import { readFileSync, writeFileSync } from "node:fs";
import type { Exchange } from "./exchanges";

const OUT = "data/spike-output";
const TOP_PAIRS = 25;
const MIN_EXCHANGES = 3; // a topic term must appear in at least this many exchanges in each document

const STOPWORDS = new Set(
  ("that this with have what from they there were your about would which their them then than when been " +
    "just like know think said because into some more other those these very also only does dont going " +
    "where right sure correct question answer page document exhibit yeah okay well sir all, mean really " +
    "could should being make made says said time thing things whether over terms point look looking talk " +
    "talking indicated understand people company companies")
    .split(/\s+/),
);

function terms(e: Exchange): Set<string> {
  const words = `${e.question} ${e.answer}`.toLowerCase().match(/[a-z][a-z'.-]{3,}/g) ?? [];
  return new Set(words.map((w) => w.replace(/['.-]+$/, "").replace(/'s$/, "")).filter((w) => w.length >= 4 && !STOPWORDS.has(w)));
}

function main() {
  const load = (doc: string): Exchange[] => JSON.parse(readFileSync(`${OUT}/${doc}/exchanges.json`, "utf8"));
  const a = load("p3171").filter((e) => e.question || e.answer);
  const b = load("p3173").filter((e) => e.question || e.answer);
  const ta = a.map(terms);
  const tb = b.map(terms);

  const df = new Map<string, [number, number]>();
  ta.forEach((s) => s.forEach((t) => df.set(t, [(df.get(t)?.[0] ?? 0) + 1, df.get(t)?.[1] ?? 0])));
  tb.forEach((s) => s.forEach((t) => df.set(t, [df.get(t)?.[0] ?? 0, (df.get(t)?.[1] ?? 0) + 1])));
  const total = a.length + b.length;
  const idf = (t: string) => Math.log(total / (df.get(t)![0] + df.get(t)![1]));

  const shared = [...df]
    .filter(([, [x, y]]) => x >= MIN_EXCHANGES && y >= MIN_EXCHANGES)
    .sort((p, q) => q[1][0] + q[1][1] - (p[1][0] + p[1][1]));

  const pairs: { score: number; a: Exchange; b: Exchange; common: string[] }[] = [];
  tb.forEach((sb, j) =>
    ta.forEach((sa, i) => {
      const common = [...sb].filter((t) => sa.has(t));
      const score = common.reduce((n, t) => n + idf(t), 0);
      if (score > 0) pairs.push({ score, a: a[i], b: b[j], common });
    }),
  );
  pairs.sort((p, q) => q.score - p.score);

  const bWithStrongMatch = new Set(pairs.filter((p) => p.score >= 15).map((p) => p.b.id)).size;
  const cite = (e: Exchange) => `${e.id} p.${e.start.page}:${e.start.line}`;
  const lines = [
    `# P3171 / P3173 subject overlap`,
    ``,
    `Exchanges with text: P3171 ${a.length}, P3173 ${b.length}.`,
    `Topic terms in at least ${MIN_EXCHANGES} exchanges of each document: ${shared.length}.`,
    `P3173 exchanges with a P3171 exchange scoring 15 or more: ${bWithStrongMatch} of ${b.length}.`,
    ``,
    `## Shared topic terms (exchanges in P3171 / P3173)`,
    ``,
    shared.slice(0, 60).map(([t, [x, y]]) => `${t} (${x}/${y})`).join(", "),
    ``,
    `## Top ${TOP_PAIRS} exchange pairs by shared-term weight`,
    ``,
  ];
  for (const p of pairs.slice(0, TOP_PAIRS)) {
    lines.push(`### ${p.score.toFixed(1)}: ${cite(p.a)} / ${cite(p.b)}`);
    lines.push(`shared: ${p.common.join(", ")}`, ``);
    lines.push(`- P3171 Q: ${p.a.question.slice(0, 300)}`, `- P3171 A: ${p.a.answer.slice(0, 400)}`);
    lines.push(`- P3173 Q: ${p.b.question.slice(0, 300)}`, `- P3173 A: ${p.b.answer.slice(0, 400)}`, ``);
  }
  writeFileSync(`${OUT}/overlap.md`, lines.join("\n"));
  console.log(lines.slice(0, 9).join("\n"));
}

main();
