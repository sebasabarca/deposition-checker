// Findings, the person's decision on one, and the workspace: the rows every cross-case screen shows. Requests only
// read and write rows. Every quotation is a stored transcript line; model text is only in fields named as the model's.

import { Router } from "express";
import { eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { candidates, depositions, exchangeLines, findings, lines, verdicts, witnesses } from "../db/schema";
import { hasPhysicalLines } from "../ingest";
import { caseRunFindings, caseRunReport } from "../jobs/caseRun";
import { isEvidenceOnHold, standingOf, type Standing } from "../evidence/correction";
import { captureEpochs, fencedTransaction, isStaleEvidence } from "../evidence/epoch";
import { caseDetail, caseSummaries, LATEST_ANALYSIS_RUN } from "./cases";
import { findingGroup, GROUP_LABELS, SOURCE_LABELS, UNSCORED_REASONS, type FindingGroup, type VerdictSource } from "./present";

const Id = z.coerce.number().int().positive();
const ref = (page: number, line: number) => `${page}:${String(line).padStart(2, "0")}`;
type PacketSide = { id: string; session?: "A" | "B"; depositionId: number; groupId: number; partIds?: number[]; lineIds: number[]; contextLineIds?: number[]; gapBefore?: boolean; gapAfter?: boolean };
// The verdict fields a finding shows (a packet verdict, as stored).
type StoredVerdict = { attributionA: string; attributionB: string; sameEvent: string; scopeAligned: string; conflictBasis: string; falsePositiveReason: string | null; explanation: string; alternativeExplanation: string | null; alternativeSupport?: unknown; inferenceSteps?: unknown; unestablishedAssumptions?: unknown; needsMoreContext?: unknown };
type SideCheck = { status: string; reason: string | null; location: string | null; evidenceLineIds: number[]; bareAnswer?: boolean; matchScore: number };
type AttributionCheck = { level: string; codeRule?: string; disagreement?: string | null; qualifier: string | null; noRecall: boolean; approximation: boolean };

export async function findingDetail(db: Database, id: number) {
  // The evidence versions this detail is read at, taken first: a review is saved only against them.
  const [sides] = await db.select({ a: candidates.depositionA, b: candidates.depositionB }).from(findings).innerJoin(candidates, eq(candidates.id, findings.candidateId)).where(eq(findings.id, id));
  const evidenceEpochs = sides ? await captureEpochs(db, [sides.a, sides.b]) : {};
  const [row] = await db
    .select({ f: findings, v: verdicts, c: candidates })
    .from(findings)
    .innerJoin(verdicts, eq(verdicts.id, findings.verdictId))
    .innerJoin(candidates, eq(candidates.id, findings.candidateId))
    .where(eq(findings.id, id));
  if (!row) return null;
  const { f, v, c } = row;
  const parsed = v.parsed as StoredVerdict;
  const standing = (await standingOf(db, [f.id])).get(f.id)!;
  const quarantined = standing.state === "quarantined";
  const packet = v.packet as { sides: PacketSide[] };
  const checks = f.checks as {
    source: { status: string; a: SideCheck; b: SideCheck };
    attribution: { a: AttributionCheck; b: AttributionCheck };
    context: { detail: string };
    timeCheck: { status: string; detail: string } | null;
    notCorroborated: string[];
    reasons: string[];
    consistencyIssues?: string[];
  };
  const allIds = packet.sides.flatMap((s) => [...s.lineIds, ...(s.contextLineIds ?? [])]);
  const stored = new Map(
    (allIds.length ? await db.select({ id: lines.id, page: lines.printedPage, line: lines.lineNo, text: lines.rawText, speaker: lines.speakerRole, ocrConfidence: lines.ocrConfidence, pdfPage: lines.pdfPage }).from(lines).where(inArray(lines.id, allIds)) : []).map((l) => [l.id, l]),
  );
  const roles = new Map(
    (allIds.length
      ? await db.select({ lineId: exchangeLines.lineId, role: exchangeLines.role }).from(exchangeLines).where(inArray(exchangeLines.exchangeId, packet.sides.flatMap((s) => s.partIds ?? [])))
      : []
    ).map((r) => [r.lineId, r.role]),
  );
  const docs = await db
    .select({ id: depositions.id, takenOn: depositions.takenOn, originalFilename: depositions.originalFilename, witness: witnesses.name, validation: depositions.validation })
    .from(depositions)
    .innerJoin(witnesses, eq(witnesses.id, depositions.witnessId))
    .where(inArray(depositions.id, [c.depositionA, c.depositionB]));

  const side = (which: "a" | "b") => {
    // Whole-case packets keep the two sides in order, without a session letter.
    const p = packet.sides.find((s) => s.session === (which === "a" ? "A" : "B")) ?? packet.sides[which === "a" ? 0 : 1];
    const source = checks.source[which];
    const highlight = new Set(source.evidenceLineIds);
    const validation = docs.find((d) => d.id === p.depositionId)?.validation;
    const inferred = new Set(validation?.ocr?.inferredPages ?? validation?.inferredPages ?? []);
    const show = (ids: number[], kind: "context" | "exchange") =>
      ids.map((lid) => stored.get(lid)).filter((l) => l !== undefined).map((l) => ({ id: l.id, ref: ref(l.page, l.line), text: l.text, role: kind === "exchange" ? (roles.get(l.id) ?? "unknown") : "context", highlighted: highlight.has(l.id), ocrConfidence: l.ocrConfidence, pdfPage: l.pdfPage, pageInferred: inferred.has(l.pdfPage) }));
    const exchangeLineIds = new Set(p.lineIds);
    const firstId = p.lineIds[0];
    const lastId = p.lineIds[p.lineIds.length - 1];
    const before = (p.contextLineIds ?? []).filter((lid) => !exchangeLineIds.has(lid) && (stored.get(lid)?.page ?? 0) * 100 + (stored.get(lid)?.line ?? 0) < (stored.get(firstId)?.page ?? 0) * 100 + (stored.get(firstId)?.line ?? 0));
    const after = (p.contextLineIds ?? []).filter((lid) => !before.includes(lid));
    const doc = docs.find((d) => d.id === p.depositionId)!;
    const att = checks.attribution[which];
    return {
      exchangeId: p.id,
      deposition: { id: doc.id, takenOn: doc.takenOn, originalFilename: doc.originalFilename, witness: doc.witness, physicalLines: hasPhysicalLines(doc.validation) },
      range: firstId && lastId ? `${ref(stored.get(firstId)!.page, stored.get(firstId)!.line)}–${ref(stored.get(lastId)!.page, stored.get(lastId)!.line)}` : null,
      before: show(before, "context"),
      lines: show(p.lineIds, "exchange"),
      after: show(after, "context"),
      gapBefore: p.gapBefore ?? false,
      gapAfter: p.gapAfter ?? false,
      verification: { status: source.status, reason: source.reason, location: source.location, bareAnswer: source.bareAnswer ?? false, matchScore: source.matchScore },
      attribution: {
        level: att.level,
        claude: parsed[which === "a" ? "attributionA" : "attributionB"],
        codeRule: att.codeRule ?? null,
        disagreement: att.disagreement ?? null,
        qualifier: att.qualifier,
        noRecall: att.noRecall,
        approximation: att.approximation,
      },
    };
  };

  return {
    id: f.id,
    group: findingGroup(f, quarantined),
    groupLabel: GROUP_LABELS[findingGroup(f, quarantined)],
    standing,
    evidenceEpochs,
    classification: f.type,
    priority: f.priority,
    score: f.score,
    band: f.band,
    unscoredReason: f.unscoredReason,
    unscoredExplanation: f.unscoredReason ? UNSCORED_REASONS[f.unscoredReason] ?? null : null,
    evidenceStatus: f.evidenceStatus,
    contextRequested: f.contextRequested,
    reviewState: f.reviewState,
    reviewNote: f.reviewNote,
    reviewedAt: f.reviewedAt,
    rubricVersion: f.rubricVersion,
    factors: f.factors,
    caps: f.caps,
    notCorroborated: checks.notCorroborated ?? [],
    reasons: checks.reasons ?? [],
    consistencyIssues: checks.consistencyIssues ?? v.consistencyIssues,
    contextCheck: checks.context?.detail ?? null,
    timeCheck: checks.timeCheck,
    source: { kind: v.origin as VerdictSource, label: SOURCE_LABELS[v.origin as VerdictSource], model: v.model, promptVersion: v.promptVersion, verdictId: v.id, replayOf: v.replayOf },
    assessment: {
      sameEvent: parsed.sameEvent,
      scopeAligned: parsed.scopeAligned,
      conflictBasis: parsed.conflictBasis,
      falsePositiveReason: parsed.falsePositiveReason,
      explanation: parsed.explanation,
      alternativeExplanation: parsed.alternativeExplanation,
      alternativeSupport: parsed.alternativeSupport ?? null,
      inferenceSteps: parsed.inferenceSteps,
      unestablishedAssumptions: parsed.unestablishedAssumptions,
      needsMoreContext: parsed.needsMoreContext,
    },
    a: side("a"),
    b: side("b"),
  };
}

// A finding as the cross-case screens list it (Findings, Overview): its lane, the person's decision, both sides'
// citations and the model's explanation, from each case's latest whole-case analysis. explanation is the model's.
export type WorkspaceFinding = {
  id: number; runId: number; runName: string | null; caseId: number; caseName: string; lane: FindingGroup;
  type: string; priority: string; score: number | null; evidenceStatus: string; reviewState: string; reviewedAt: Date | null; crossWitness: boolean;
  a: { witness: string | null; takenOn: string | null; range: string | null }; b: { witness: string | null; takenOn: string | null; range: string | null };
  explanation: string | null;
};
export async function workspaceFindings(db: Database, caseIds: number[], caseName: Map<number, string>): Promise<WorkspaceFinding[]> {
  if (!caseIds.length) return [];
  const runs = (await db.execute<{ case_id: number; run_id: number | null }>(sql`select c.id as case_id, ${LATEST_ANALYSIS_RUN} as run_id from cases c where c.id in (${sql.join(caseIds.map((x) => sql`${x}`), sql`, `)})`)).rows.filter((r) => r.run_id !== null);
  return (await Promise.all(runs.map(async (r) => {
    const [run, fs] = await Promise.all([caseRunReport(db, Number(r.run_id)), caseRunFindings(db, Number(r.run_id))]);
    return fs.map((f): WorkspaceFinding => {
      const explanation = (f.model.verdict as { explanation?: unknown } | null)?.explanation;
      return {
        id: f.id, runId: Number(r.run_id), runName: run?.name ?? null, caseId: Number(r.case_id), caseName: caseName.get(Number(r.case_id)) ?? "Case",
        lane: findingGroup(f, f.standing.state === "quarantined"), type: f.type, priority: f.priority, score: f.score, evidenceStatus: f.evidenceStatus, reviewState: f.reviewState, reviewedAt: f.reviewedAt, crossWitness: f.crossWitness,
        a: { witness: f.a?.witness ?? null, takenOn: f.a?.takenOn ?? null, range: f.a?.range ?? null }, b: { witness: f.b?.witness ?? null, takenOn: f.b?.takenOn ?? null, range: f.b?.range ?? null },
        explanation: typeof explanation === "string" ? explanation : null,
      };
    });
  }))).flat();
}

export function findingRoutes({ db }: { db: Database }): Router {
  const router = Router();

  // Everything the cross-case screens (Overview, Depositions, Findings, Analyses) show, in one response: the cases,
  // each case's detail, the whole-case analyses running now (not estimates), and each case's latest analysis's findings.
  router.get("/workspace", async (_req, res) => {
    const summaries = await caseSummaries(db, res.locals.user?.orgId);
    const details = (await Promise.all(summaries.map((c) => caseDetail(db, c.id)))).filter((d) => d !== null);
    const caseIds = summaries.map((c) => c.id);
    const running = caseIds.length ? (await db.execute<{ id: number }>(sql`select id from case_runs where case_id in (${sql.join(caseIds.map((x) => sql`${x}`), sql`, `)}) and status in ('queued', 'retrieving', 'adjudicating', 'reconciling') and (confirmed_at is not null or mode = 'mock') order by id`)).rows : [];
    const caseRuns = (await Promise.all(running.map((r) => caseRunReport(db, Number(r.id))))).filter((r) => r !== null);
    const findings = await workspaceFindings(db, caseIds, new Map(summaries.map((c) => [c.id, c.name])));
    return res.json({ cases: summaries, details, caseRuns, findings });
  });

  router.patch("/findings/:id/review", async (req, res) => {
    const id = Id.safeParse(req.params.id);
    // epochs: the evidence versions of the finding's depositions when the reviewer opened it (findingDetail).
    const body = z.object({ decision: z.enum(["confirmed", "needs_context", "dismissed"]).nullable(), note: z.string().trim().max(5000).optional(), epochs: z.record(z.string().regex(/^\d+$/), z.number().int().nonnegative()) }).safeParse(req.body ?? {});
    if (!id.success || !body.success) return res.status(400).json({ error: "Invalid review decision: it needs the decision and the evidence versions the finding was opened at." });
    const { decision, note, epochs } = body.data;
    const [sides] = await db.select({ a: candidates.depositionA, b: candidates.depositionB }).from(findings).innerJoin(candidates, eq(candidates.id, findings.candidateId)).where(eq(findings.id, id.data));
    if (!sides) return res.status(404).json({ error: "Finding not found." });
    if (Object.keys(epochs).sort().join() !== [...new Set([String(sides.a), String(sides.b)])].sort().join()) return res.status(400).json({ error: "The evidence versions sent are not those of this finding's depositions." });
    const changes = decision === null ? { reviewState: "unreviewed", reviewNote: null, reviewedAt: null } : { reviewState: decision, reviewNote: note || null, reviewedAt: new Date() };
    type Outcome = { review: { reviewState: string; reviewNote: string | null; reviewedAt: Date | null } } | { refused: number; error: string; standing?: Standing };
    // Saved only against the versions the reviewer saw: the guard checks them in the same statement (VE002 if a
    // correction committed since). The quarantine is checked after the write, inside the same transaction, so a
    // quarantine committed meanwhile can't be missed.
    const outcome: Outcome = await fencedTransaction(db, epochs, async (tx) => {
      const [row] = await tx.update(findings).set(changes).where(eq(findings.id, id.data)).returning({ reviewState: findings.reviewState, reviewNote: findings.reviewNote, reviewedAt: findings.reviewedAt });
      const standing = (await standingOf(tx, [id.data])).get(id.data)!;
      if (standing.state === "quarantined") throw Object.assign(new Error("quarantined"), { standing });
      return { review: row };
    }).catch((e: unknown): Outcome => {
      const standing = (e as { standing?: Standing }).standing;
      if (standing && standing.state === "quarantined") return { refused: 409, standing, error: `This finding's transcript was re-read with a corrected parser (${standing.reason}). It is kept for audit and can't be reviewed; revalidate it by analysing the corrected transcript again.` };
      if (isStaleEvidence(e)) return { refused: 409, error: "This finding's transcript was corrected after you opened it, so your review wasn't saved. It is shown again as it stands now; review it again." };
      if (isEvidenceOnHold(e)) return { refused: 409, error: "This finding's transcript is being corrected right now, so your review wasn't saved. Try again in a moment." };
      throw e;
    });
    if ("refused" in outcome) return res.status(outcome.refused).json({ error: outcome.error, ...(outcome.standing ? { standing: outcome.standing } : {}) });
    return res.json(outcome);
  });

  return router;
}
