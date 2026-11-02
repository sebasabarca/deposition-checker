// Scores stored direct findings again with the evidence-strength checklist. No API call. Only the
// score, band, priority and checklist change: review state, verdicts and verification stay as stored.
//   npx tsx scripts/rescore-direct.ts --analysis <id> [--write]     without --write, prints only

import "dotenv/config";
import { eq } from "drizzle-orm";
import { parseArgs } from "node:util";
import { connect } from "../server/src/db/client";
import { candidates, findings, verdicts } from "../server/src/db/schema";
import { EVIDENCE_STRENGTH_VERSION, evidenceStrength, unscoredReasonOf } from "../server/src/score";
import type { DirectSide, Lane } from "../server/src/verify";

const { values } = parseArgs({ options: { analysis: { type: "string" }, write: { type: "boolean" } } });

async function main() {
  const { db, pool } = connect();
  try {
    const rows = await db.select({ f: findings, v: verdicts }).from(findings).innerJoin(verdicts, eq(verdicts.id, findings.verdictId)).innerJoin(candidates, eq(candidates.id, findings.candidateId)).where(eq(candidates.candidateSet, `analysis-${values.analysis}`));
    for (const { f, v } of rows) {
      const direct = (f.checks as { direct?: { lane: Lane; a: DirectSide; b: DirectSide; modelClassification: string } }).direct;
      if (!direct) continue;
      const s = evidenceStrength({ classification: direct.modelClassification, comparable: (v.parsed as { sameEvent: string }).sameEvent, lane: direct.lane, a: direct.a, b: direct.b });
      console.log(JSON.stringify({ finding: f.id, lane: direct.lane, classification: direct.modelClassification, a: direct.a.citation, b: direct.b.citation, score: s.score, previousPriority: f.priority, priority: s.priority, reason: s.priorityReason, checks: s.checks.map((c) => `${c.points}/${c.max}`).join(" ") }));
      if (values.write) await db.update(findings).set({ score: s.score, band: s.band, priority: s.priority, factors: s.checks, rubricVersion: EVIDENCE_STRENGTH_VERSION, unscoredReason: unscoredReasonOf(direct.lane, f.evidenceStatus, s.score) }).where(eq(findings.id, f.id));
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
