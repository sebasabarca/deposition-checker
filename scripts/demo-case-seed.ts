// Seeds the hand-authored demonstration case (server/src/data/demoCase.ts) into one organization: two
// witnesses, two sessions each, one completed demo analysis per witness with prepared example
// assessments. No model or API call, nothing deleted. Run it with scripts/demo-case.ts.
//
// The sessions go through the real ingestion code and per-page validation; each prepared assessment
// goes through the real pipeline (packet from stored lines, Layer 1 source check, Layer 2 attribution,
// code scoring), stored as origin "fixture", so the app labels it "Demo: a prepared example
// assessment … Not produced by a model". Idempotent: a second run finds the case and changes nothing.

import { and, eq } from "drizzle-orm";
import { loadPacket } from "../server/src/adjudicate/packet";
import { storeVerdict } from "../server/src/adjudicate/run";
import type { Verdict } from "../server/src/adjudicate/schema";
import type { Database } from "../server/src/db/client";
import { analyses, candidates, cases, depositions, exchanges, findings, witnesses } from "../server/src/db/schema";
import { DEMO_CASE_NAME, DEMO_PROVENANCE, DEMO_WITNESSES } from "../server/src/data/demoCase";
import { syntheticPages } from "../server/src/eval/syntheticStore";
import { toSourceLines } from "../server/src/eval/synthetic";
import { PARSER_VERSION, saveDeposition } from "../server/src/ingest";
import { buildExchangeParts } from "../server/src/ingest/exchanges";
import { ELLISON_DOJ_V1 } from "../server/src/ingest/layout";
import { storeUpload, UPLOADS_DIR } from "../server/src/ingest/uploads";
import { validateDeposition } from "../server/src/ingest/validate";
import { candidateSetOf } from "../server/src/jobs/analysis";

export type DemoSeed = { caseId: number; created: boolean; analyses: number[]; findings: number };

// The original file of a demo session: its invented text under a line that says so. "View original text"
// opens exactly this, and it is the text the session's lines are read from.
export const demoOriginal = (witness: string, takenOn: string, text: string) =>
  `Hand-authored demonstration transcript: ${witness}, ${takenOn}. Invented testimony for the Veridict demo; no real person or case.\n${text}`;
const filenameOf = (witness: string, takenOn: string) => `${witness.toLowerCase().replace(/[^a-z]+/g, "-")}-${takenOn}-demo.txt`;

export async function seedDemoCase(db: Database, orgId: number, uploadsDir = UPLOADS_DIR): Promise<DemoSeed> {
  const [existing] = await db.select().from(cases).where(and(eq(cases.orgId, orgId), eq(cases.name, DEMO_CASE_NAME)));
  if (existing) {
    const rows = await db.select({ id: analyses.id }).from(analyses).where(eq(analyses.caseId, existing.id));
    const count = (await db.select({ id: findings.id }).from(findings).where(eq(findings.caseId, existing.id))).length;
    return { caseId: existing.id, created: false, analyses: rows.map((r) => r.id), findings: count };
  }

  // Content-addressed and written atomically, so storing the same originals again is harmless.
  const originals = new Map<string, { fileSha256: string; storageKey: string }>();
  for (const w of DEMO_WITNESSES) for (const s of w.sessions) originals.set(`${w.name}|${s.takenOn}`, await storeUpload(new TextEncoder().encode(demoOriginal(w.name, s.takenOn, s.text)), uploadsDir));

  return db.transaction(async (tx) => {
    const [kase] = await tx.insert(cases).values({ orgId, name: DEMO_CASE_NAME }).returning();
    const analysisIds: number[] = [];
    let findingCount = 0;
    for (const w of DEMO_WITNESSES) {
      const [witness] = await tx.insert(witnesses).values({ caseId: kase.id, name: w.name }).returning();
      const depositionIds: number[] = [];
      for (const s of w.sessions) {
        // The first line (the disclosure) is not a Q. or A. turn, so the reader skips it.
        const lines = toSourceLines(demoOriginal(w.name, s.takenOn, s.text), s.firstPage);
        const validation = validateOrThrow(lines, `${w.name}, ${s.takenOn}`);
        const original = originals.get(`${w.name}|${s.takenOn}`)!;
        const saved = await saveDeposition(tx, {
          caseId: kase.id, witnessId: witness.id, takenOn: s.takenOn, ...original,
          read: { parserVersion: PARSER_VERSION, pdf: null, validation, exchanges: buildExchangeParts(lines, ELLISON_DOJ_V1) },
        });
        if (!("depositionId" in saved)) throw new Error(`The demo session ${s.takenOn} of ${w.name} wasn't saved.`);
        await tx.update(depositions).set({ sourceFormat: "text", originalFilename: filenameOf(w.name, s.takenOn) }).where(eq(depositions.id, saved.depositionId));
        depositionIds.push(saved.depositionId);
      }

      const now = new Date();
      const [analysis] = await tx
        .insert(analyses)
        .values({
          caseId: kase.id, kind: "same_witness", witnessId: witness.id, depositionA: depositionIds[0], depositionB: depositionIds[1],
          mode: "demo", retrieval: "hybrid", promptVersion: DEMO_PROVENANCE, effort: "none", maxCandidates: w.findings.length, budgetUsd: 0,
          status: "completed", startedAt: now, finishedAt: now,
        })
        .returning({ id: analyses.id });
      analysisIds.push(analysis.id);

      const find = async (depositionId: number, phrase: string) => {
        const hit = (await tx.select().from(exchanges).where(eq(exchanges.depositionId, depositionId))).find((r) => r.questionText.includes(phrase));
        if (!hit) throw new Error(`No demo exchange of ${w.name} asks "${phrase}".`);
        return hit;
      };
      let fixture = 0;
      for (const [i, f] of w.findings.entries()) {
        const [a, b] = [await find(depositionIds[0], f.questionA), await find(depositionIds[1], f.questionB)];
        const [candidate] = await tx
          .insert(candidates)
          .values({
            candidateSet: candidateSetOf(analysis.id), witnessId: witness.id, depositionA: depositionIds[0], groupA: a.groupId, depositionB: depositionIds[1], groupB: b.groupId,
            exchangeA: a.id, exchangeB: b.id, sources: ["fixture"], rrfScore: 0, mergedRank: i + 1, evidence: [{ path: "fixture", fixture: f.id }],
          })
          .returning({ id: candidates.id });
        const packet = await loadPacket(tx, candidate.id);
        const side = (id: string) => (id === "A" ? packet.a.id : id === "B" ? packet.b.id : id);
        const inferenceSteps = f.verdict.inferenceSteps.map((s) => ({ ...s, supportingIds: s.supportingIds.map(side) }));
        const parsed = { ...f.verdict, inferenceSteps, evidenceAId: packet.a.id, evidenceBId: packet.b.id } as Verdict;
        const out = await storeVerdict(tx, {
          candidateId: candidate.id, packet, read: { status: "valid", parsed, error: null }, raw: JSON.stringify(parsed),
          model: "fixture", promptVersion: DEMO_PROVENANCE, effort: "none", origin: "fixture",
        });
        if (out.findingId === null) throw new Error(`The prepared assessment ${f.id} produced no finding.`);
        fixture++;
        findingCount++;
      }
      await tx.update(analyses).set({ progress: { candidates: { selected: fixture, deferred: 0 }, fixture, findings: fixture } }).where(eq(analyses.id, analysis.id));
    }
    return { caseId: kase.id, created: true, analyses: analysisIds, findings: findingCount };
  });
}

// The real per-page validation, not a hand-written "ready": a demo session that breaks the layout fails here.
function validateOrThrow(lines: ReturnType<typeof toSourceLines>, label: string) {
  const v = validateDeposition(syntheticPages(lines), ELLISON_DOJ_V1);
  if (v.status !== "ready") throw new Error(`Demo session ${label} fails validation: ${JSON.stringify(v.reasons)}`);
  return v;
}
