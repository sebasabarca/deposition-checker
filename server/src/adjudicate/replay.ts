// Demo mode: verdicts for a candidate without calling a model. Two sources, both labelled as what
// they are and never shown as live model output:
//   replayed  a stored, valid model verdict for the same pair of logical exchanges (from an earlier
//             paid run), copied with replay_of pointing at the original. The same exchanges means
//             the same files read by the same parser, so the same PDFs uploaded to another case
//             replay too; only the exchange IDs the verdict cites change. Its checks and score are
//             recomputed by today's code, against this deposition's stored lines, as for a live call.
//   fixture   the prepared verdict of a synthetic evaluation case (eval/synthetic.ts), written by
//             hand for tests. Only for candidates in a synthetic fixture case.
// A candidate with neither is left without a verdict and counted; nothing is invented for it.

import { and, desc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Database } from "../db/client";
import { candidates, depositions, verdicts } from "../db/schema";
import { SYNTHETIC_SUITES } from "../eval/synthetic";
import { verdictNotQuarantined } from "../evidence/correction";
import { loadPacket } from "./packet";
import { PROMPT_VERSIONS } from "./prompt";
import { storeVerdict } from "./run";
import type { Verdict } from "./schema";

export type ReplayOutcome = { source: "replayed"; verdictId: number; findingId: number | null } | { source: "fixture"; verdictId: number; findingId: number | null } | { source: "none" };

// The verdict with the exchange IDs it cites changed to this packet's. Pure.
export function retarget(verdict: Verdict, ids: Record<string, string>): Verdict {
  return JSON.parse(JSON.stringify(verdict).replace(/\bE\d+\b/g, (id) => ids[id] ?? id)) as Verdict;
}

export async function replayCandidate(db: Database, candidateId: number, preferPromptVersion: string): Promise<ReplayOutcome> {
  const [c] = await db.select().from(candidates).where(eq(candidates.id, candidateId));
  if (!c) throw new Error(`No candidate ${candidateId}.`);

  // Stored model verdicts for the same two logical exchanges, the preferred prompt version first,
  // then the most recent.
  const files = await db.select({ id: depositions.id, sha: depositions.fileSha256, parser: depositions.parserVersion }).from(depositions).where(inArray(depositions.id, [c.depositionA, c.depositionB]));
  const fileA = files.find((f) => f.id === c.depositionA)!;
  const fileB = files.find((f) => f.id === c.depositionB)!;
  const [storedA, storedB] = [alias(depositions, "stored_a"), alias(depositions, "stored_b")];
  const stored = await db
    .select({ verdict: verdicts })
    .from(verdicts)
    .innerJoin(candidates, eq(candidates.id, verdicts.candidateId))
    .innerJoin(storedA, eq(storedA.id, candidates.depositionA))
    .innerJoin(storedB, eq(storedB.id, candidates.depositionB))
    .where(
      and(
        eq(verdicts.origin, "model"),
        eq(verdicts.status, "valid"),
        inArray(verdicts.promptVersion, [...PROMPT_VERSIONS]), // never the batch experiment's verdicts
        eq(storedA.fileSha256, fileA.sha),
        eq(storedA.parserVersion, fileA.parser),
        eq(candidates.groupA, c.groupA),
        eq(storedB.fileSha256, fileB.sha),
        eq(storedB.parserVersion, fileB.parser),
        eq(candidates.groupB, c.groupB),
        verdictNotQuarantined(verdicts.id), // a verdict whose evidence a correction changed is never copied
      ),
    )
    .orderBy(desc(verdicts.id));
  const pick = stored.find((r) => r.verdict.promptVersion === preferPromptVersion) ?? stored[0];
  const packet = await loadPacket(db, candidateId);

  if (pick) {
    const v = pick.verdict;
    const [was, now] = [(v.packet as { sides: { id: string }[] }).sides, [packet.a, packet.b]];
    const out = await storeVerdict(db, {
      candidateId,
      packet,
      read: { status: "valid", parsed: retarget(v.parsed as Verdict, { [was[0].id]: now[0].id, [was[1].id]: now[1].id }), error: null },
      raw: v.raw,
      model: v.model,
      promptVersion: v.promptVersion,
      effort: v.effort,
      origin: "replayed",
      replayOf: v.id,
    });
    return { source: "replayed", verdictId: out.verdictId, findingId: out.findingId };
  }

  // A synthetic fixture case: its prepared verdict, matched by the two exchanges.
  for (const suite of SYNTHETIC_SUITES) {
    const fixtureCandidates = await db
      .select({ evidence: candidates.evidence, depositionA: candidates.depositionA, groupA: candidates.groupA, depositionB: candidates.depositionB, groupB: candidates.groupB })
      .from(candidates)
      .where(eq(candidates.candidateSet, suite.set));
    const match = fixtureCandidates.find((f) => f.depositionA === c.depositionA && f.groupA === c.groupA && f.depositionB === c.depositionB && f.groupB === c.groupB);
    if (!match) continue;
    const fixtureId = (match.evidence as { fixture?: string }[])[0]?.fixture;
    const prepared = suite.cases.find((x) => x.id === fixtureId)?.verdict;
    if (!prepared) continue;
    const parsed = { ...prepared, evidenceAId: packet.a.id, evidenceBId: packet.b.id } as Verdict;
    const out = await storeVerdict(db, {
      candidateId,
      packet,
      read: { status: "valid", parsed, error: null },
      raw: JSON.stringify(parsed),
      model: "fixture",
      promptVersion: `fixture:${suite.set}`,
      effort: "none",
      origin: "fixture",
    });
    return { source: "fixture", verdictId: out.verdictId, findingId: out.findingId };
  }
  return { source: "none" };
}
