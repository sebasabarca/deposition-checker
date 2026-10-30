// The human review set (no API call, nothing changed in the database).
//
//   npx tsx scripts/eval-review.ts build    Writes data/eval/review-set-v1.json (references, tracked) and
//                                           data/eval/review/review-set-v1.csv (with testimony, git-ignored).
//                                           Refuses to replace a file that already holds human labels.
//   npx tsx scripts/eval-review.ts import   Copies the sheet's human columns into the tracked file.
//
// 40 pairs in a fixed order: all 16 synthetic cases, and 24 real Ellison pairs from analysis 11: the
// pairs the model thought might be the same event, then insufficient-evidence ones, then an even
// spread. Selection uses no human judgement and no label.

import "dotenv/config";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { findingDetail } from "../server/src/api/analyses";
import { connect, type Database } from "../server/src/db/client";
import { candidates, cases, findings, verdicts, witnesses } from "../server/src/db/schema";
import { applySheet, HUMAN_CLASSIFICATIONS, ReviewSet, type ReviewPair } from "../server/src/eval/reviewSet";

const JSON_FILE = "data/eval/review-set-v1.json";
const CSV_FILE = "data/eval/review/review-set-v1.csv";
const REAL_SET = "analysis-11";
const SYNTHETIC_RUN = "exp-strategies-1-C"; // adjudicate-v3, the same prompt as analysis 11
const REAL_PAIRS = 24;
const FIXTURE_SETS = ["webb-synthetic-v1", "whitfield-synthetic-v1"];

type Row = { findingId: number; set: string; sources: string[]; rank: number; witnessId: number; sameEvent: string; classification: string; depositionA: number; depositionB: number; groupA: number; groupB: number; exchangeA: number; exchangeB: number; source: "real" | "synthetic"; hash: string };

const hash = (x: unknown) => createHash("sha256").update(String(x)).digest("hex");

async function rowsOf(db: Database, set: string, source: Row["source"], only?: (evidence: unknown) => boolean): Promise<Row[]> {
  const rows = await db
    .select({ f: findings, v: verdicts, c: candidates })
    .from(findings)
    .innerJoin(verdicts, eq(verdicts.id, findings.verdictId))
    .innerJoin(candidates, eq(candidates.id, findings.candidateId))
    .where(eq(candidates.candidateSet, set));
  return rows
    .filter((r) => !only || only(r.c.evidence))
    .map(({ f, v, c }) => ({
      findingId: f.id, set, sources: c.sources, rank: c.mergedRank, witnessId: c.witnessId, sameEvent: (v.parsed as { sameEvent: string }).sameEvent, classification: f.type,
      depositionA: c.depositionA, depositionB: c.depositionB, groupA: c.groupA, groupB: c.groupB, exchangeA: c.exchangeA, exchangeB: c.exchangeB, source, hash: hash(c.mergedRank),
    }));
}

async function choose(db: Database): Promise<Row[]> {
  const fixtures = new Set((await db.execute<{ id: string }>(sql`select id from candidates where candidate_set in (${sql.join(FIXTURE_SETS.map((s) => sql`${s}`), sql`, `)})`)).rows.map((r) => Number(r.id)));
  const synthetic = await rowsOf(db, SYNTHETIC_RUN, "synthetic", (e) => fixtures.has((e as { sourceCandidateId: number }[])[0].sourceCandidateId));
  const real = await rowsOf(db, REAL_SET, "real");
  const take = (xs: Row[], n: number, chosen: Row[]) => [...chosen, ...xs.filter((r) => !chosen.includes(r)).sort((a, b) => a.rank - b.rank).slice(0, n)];
  let chosen = take(real.filter((r) => r.sameEvent !== "no"), 11, []);
  chosen = take(real.filter((r) => r.classification === "insufficient_evidence"), 5, chosen);
  const rest = real.filter((r) => !chosen.includes(r)).sort((a, b) => a.rank - b.rank);
  const left = REAL_PAIRS - chosen.length;
  chosen = [...chosen, ...Array.from({ length: left }, (_, i) => rest[Math.floor(((i + 0.5) * rest.length) / left)])];
  // Mixed by a hash, so real and synthetic pairs don't sit in blocks.
  return [...synthetic, ...chosen].sort((a, b) => hash(`${a.set}${a.rank}`).localeCompare(hash(`${b.set}${b.rank}`)));
}

const cell = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;

async function build(db: Database) {
  if (existsSync(JSON_FILE) && ReviewSet.parse(JSON.parse(readFileSync(JSON_FILE, "utf8"))).pairs.some((p) => p.human.classification || p.human.comparable !== null || p.human.notes)) {
    throw new Error(`${JSON_FILE} already holds human labels; it is never rebuilt over them.`);
  }
  const rows = await choose(db);
  const pairs: ReviewPair[] = [];
  const sheet: string[] = [];
  for (const [i, r] of rows.entries()) {
    const f = (await findingDetail(db, r.findingId))!;
    const id = `R${String(i + 1).padStart(2, "0")}`;
    const [w] = await db.select({ witness: witnesses.name, caseName: cases.name }).from(witnesses).innerJoin(cases, eq(cases.id, witnesses.caseId)).where(eq(witnesses.id, r.witnessId));
    const sha = async (d: number) => (await db.execute<{ s: string }>(sql`select left(file_sha256, 12) s from depositions where id = ${d}`)).rows[0].s;
    const side = async (depositionId: number, exchangeId: number, group: number, range: string | null) => ({ document: await sha(depositionId), depositionId, exchangeId, group, range: range ?? "unknown" });
    pairs.push({
      id, source: r.source, caseName: w.caseName, witness: w.witness,
      a: await side(r.depositionA, r.exchangeA, r.groupA, f.a.range), b: await side(r.depositionB, r.exchangeB, r.groupB, f.b.range),
      retrieval: { set: r.set, sources: r.sources, rank: r.rank },
      modelVerdict: { note: "model-generated; not ground truth", classification: f.classification, promptVersion: f.source.promptVersion, citationStatus: f.evidenceStatus },
      human: { classification: null, comparable: null, notes: "" },
    });
    const text = (s: typeof f.a) => s.lines.map((l) => `${l.ref} ${l.text}`).join("\n");
    const date = (s: typeof f.a) => s.deposition.takenOn ?? "date not stated";
    sheet.push([id, r.source, w.caseName, w.witness, date(f.a), f.a.range, text(f.a), date(f.b), f.b.range, text(f.b), "", "", "", f.classification, f.evidenceStatus, f.assessment.explanation].map(cell).join(","));
  }
  writeFileSync(JSON_FILE, `${JSON.stringify(ReviewSet.parse({ version: 1, about: "Human review set. References only: the testimony is in the git-ignored sheet. human fields are filled by a person and stay null until then. modelVerdict is model output, never ground truth. Pairs are evaluation targets: retrieval must never read this file.", choices: [...HUMAN_CLASSIFICATIONS], pairs }), null, 2)}\n`);
  const header = ["id", "source", "case", "witness", "a_session", "a_page_line", "statement_a", "b_session", "b_page_line", "statement_b", "human_classification", "human_comparable", "human_notes", "MODEL_classification_not_ground_truth", "MODEL_citation_check", "MODEL_explanation_not_ground_truth"];
  writeFileSync(CSV_FILE, `${[header.map(cell).join(","), ...sheet].join("\n")}\n`);
  console.log(`${pairs.length} pairs: ${pairs.filter((p) => p.source === "real").length} real, ${pairs.filter((p) => p.source === "synthetic").length} synthetic.\n${JSON_FILE}\n${CSV_FILE}`);
}

function importSheet() {
  const set = applySheet(ReviewSet.parse(JSON.parse(readFileSync(JSON_FILE, "utf8"))), readFileSync(CSV_FILE, "utf8"));
  writeFileSync(JSON_FILE, `${JSON.stringify(set, null, 2)}\n`);
  console.log(`${set.pairs.filter((p) => p.human.classification).length} of ${set.pairs.length} pairs classified; ${set.pairs.filter((p) => p.human.comparable !== null).length} marked for comparability.`);
}

async function main() {
  const command = process.argv[2];
  if (command === "import") return importSheet();
  if (command !== "build") throw new Error("Usage: npx tsx scripts/eval-review.ts build|import");
  const { db, pool } = connect();
  try {
    await build(db);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
