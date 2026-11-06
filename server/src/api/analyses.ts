// Analysis and findings endpoints. Starting an analysis records it and queues its job in one
// transaction; the worker does the work. Reading an analysis or a finding only reads stored rows.
// Every quotation in a response is a stored transcript line; model text is returned only in fields
// named as the model's (explanation, alternativeExplanation), with where the verdict came from.

import { Router } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Pool } from "pg";
import { z } from "zod";
import { DEFAULT_EFFORT, DEFAULT_PROMPT_VERSION, DEFAULT_STRATEGY, directCanResume, discoveryRunsOf, DISCOVERY_EFFORT, DISCOVERY_FALLBACK_MODEL, DISCOVERY_MODEL, DISCOVERY_PROMPT_VERSION, EFFORTS, MAX_CONCURRENCY, PRODUCTION_STRATEGY_IDS, PROMPT_VERSIONS, STRATEGIES, type Verdict } from "../adjudicate";
import { withTransaction, type Database } from "../db/client";
import { analyses, budgets, candidates, depositions, discoveryRuns, exchangeLines, findings, lines, verdicts, witnesses } from "../db/schema";
import { analysisCost, candidateSetOf, DIRECT_FABLE, enqueueAnalysis } from "../jobs";
import { cardSummary, latestMapVersion, mapMembers, topicReport } from "../claims";
import { hasPhysicalLines } from "../ingest";
import { sessionCoverage } from "../verify";
import { caseDetail, caseSummaries } from "./cases";
import { runningAnalysis, runningConflict, type RunningAnalysis } from "./caseRuns";
import { caseRunReport } from "../jobs/caseRun";
import { estimateCrossDiscovery, estimateDiscovery } from "../adjudicate/estimateDiscovery";
import { CROSS_DISCOVERY_MODEL, CROSS_DISCOVERY_PROMPT_VERSION, CROSS_FALLBACK_MODEL, crossSidesOf } from "../adjudicate/discoverCross";
import { isEvidenceOnHold, standingOf, type Standing } from "../evidence/correction";
import { captureEpochs, fencedTransaction, isStaleEvidence } from "../evidence/epoch";
import { candidateCoverage, compareFindings, coverageNotes, directSourceLabel, findingGroup, GROUP_LABELS, GROUP_ORDER, modelName, SOURCE_LABELS, UNSCORED_REASONS, type FindingGroup, type VerdictSource } from "./present";

const Id = z.coerce.number().int().positive();
export const MAX_BUDGET_USD = 20;
export const DEFAULT_BUDGET_USD = 3; // DESIGN.md's default per two-session analysis
// Covers the worst case of a long pair at batch prices, and of a fallback after a refusal.
export const DEFAULT_DIRECT_BUDGET_USD = 6;
// Opus's worst case on both Simpson and both Resnick sessions together was $2.43, so one session of each
// fits easily, with room for Fable after a refusal.
export const DEFAULT_CROSS_BUDGET_USD = 6;
export const MAX_CANDIDATES = 300;

const StartAnalysis = z.object({
  depositionA: z.number().int().positive(),
  depositionB: z.number().int().positive(),
  mode: z.enum(["demo", "live"]).default("demo"),
  method: z.enum(["direct_fable", "hybrid"]).optional(), // live defaults to direct_fable; a demo replays stored hybrid verdicts
  budgetUsd: z.number().min(0).max(MAX_BUDGET_USD).optional(),
  maxCandidates: z.number().int().min(1).max(MAX_CANDIDATES).default(MAX_CANDIDATES),
  promptVersion: z.enum(PROMPT_VERSIONS).default(DEFAULT_PROMPT_VERSION),
  effort: z.enum(EFFORTS).default(DEFAULT_EFFORT),
  strategy: z.enum(PRODUCTION_STRATEGY_IDS).default(DEFAULT_STRATEGY as (typeof PRODUCTION_STRATEGY_IDS)[number]),
  maxConcurrency: z.number().int().min(1).max(MAX_CONCURRENCY).optional(), // overrides the strategy's; A stays sequential
});
const StartCross = z.object({ kind: z.literal("cross_witness"), witnessA: z.number().int().positive(), witnessB: z.number().int().positive(), budgetUsd: z.number().min(0).max(MAX_BUDGET_USD).optional() });
const ACTIVE = ["queued", "parsing", "retrieving", "adjudicating"] as const;
const RESUMABLE = ["blocked_budget", "blocked_credentials", "failed", "cancelled", "interrupted"];

const ref = (page: number, line: number) => `${page}:${String(line).padStart(2, "0")}`;

// Every candidate's status, and for a hybrid analysis what its cards and topic map cover.
async function analysisCoverage(db: Database, a: typeof analyses.$inferSelect) {
  const rows = await db
    .select({ status: candidates.status, sources: candidates.sources, deferredReason: candidates.deferredReason, exclusionReason: candidates.exclusionReason, selectedBy: candidates.selectedBy, n: sql<number>`count(*)::int` })
    .from(candidates)
    .where(eq(candidates.candidateSet, candidateSetOf(a.id)))
    .groupBy(candidates.status, candidates.sources, candidates.deferredReason, candidates.exclusionReason, candidates.selectedBy);
  if (a.retrieval !== "hybrid") return { candidates: candidateCoverage(rows), cards: null, topics: null };
  const mapVersion = await latestMapVersion(db, a.witnessId);
  return {
    candidates: candidateCoverage(rows),
    cards: await Promise.all([a.depositionA, a.depositionB].map((d) => cardSummary(db, d))),
    topics: mapVersion === null ? null : { mapVersion, ...topicReport(await mapMembers(db, a.witnessId, mapVersion)) },
  };
}

export async function analysisView(db: Database, id: number) {
  const [a] = await db.select().from(analyses).where(eq(analyses.id, id));
  if (!a) return null;
  const cross = a.kind === "cross_witness" ? crossSidesOf(a) : null;
  const sessionIds = cross ? [...cross.a, ...cross.b] : [a.depositionA, a.depositionB];
  const docs = await db
    .select({ id: depositions.id, takenOn: depositions.takenOn, status: depositions.status, originalFilename: depositions.originalFilename, witness: witnesses.name, witnessId: depositions.witnessId })
    .from(depositions)
    .innerJoin(witnesses, eq(witnesses.id, depositions.witnessId))
    .where(inArray(depositions.id, sessionIds));
  const witnessNames = await db.select({ id: witnesses.id, name: witnesses.name }).from(witnesses).where(inArray(witnesses.id, [a.witnessId, ...(a.witnessBId ? [a.witnessBId] : [])]));
  const rows = await db
    .select({ id: findings.id, type: findings.type, evidenceStatus: findings.evidenceStatus, score: findings.score, unscoredReason: findings.unscoredReason, priority: findings.priority, reviewState: findings.reviewState })
    .from(findings)
    .innerJoin(candidates, eq(candidates.id, findings.candidateId))
    .where(eq(candidates.candidateSet, candidateSetOf(id)));
  const standing = await standingOf(db, rows.map((r) => r.id));
  const quarantined = (r: { id: number }) => standing.get(r.id)?.state === "quarantined";
  const groups: Record<FindingGroup, number> = { contradictions: 0, needs_context: 0, compatible: 0, unverified: 0, quarantined: 0 };
  for (const r of rows) groups[findingGroup(r, quarantined(r))]++;
  const cost = await analysisCost(db, a);
  const runs = a.retrieval === DIRECT_FABLE ? await discoveryRunsOf(db, a.id) : [];
  return {
    id: a.id,
    caseId: a.caseId,
    witnessId: a.witnessId,
    kind: a.kind as "same_witness" | "cross_witness",
    // Witness A, and witness B for a cross-witness check.
    witnesses: { a: { id: a.witnessId, name: witnessNames.find((w) => w.id === a.witnessId)?.name ?? "Witness" }, b: a.witnessBId ? { id: a.witnessBId, name: witnessNames.find((w) => w.id === a.witnessBId)?.name ?? "Witness" } : null },
    mode: a.mode,
    retrieval: a.retrieval,
    discovery: a.retrieval === DIRECT_FABLE ? discoveryView(runs, a.kind === "cross_witness") : null,
    evidence: a.retrieval === DIRECT_FABLE ? await evidenceCoverage(db, a, runs) : null,
    resumable: a.retrieval === DIRECT_FABLE ? directCanResume(a.status, runs.length) : RESUMABLE.includes(a.status),
    status: a.status,
    error: a.error,
    progress: a.progress,
    coverage: await analysisCoverage(db, a),
    promptVersion: a.promptVersion,
    effort: a.effort,
    maxCandidates: a.maxCandidates,
    strategy: a.strategy,
    candidatesPerRequest: a.candidatesPerRequest,
    maxConcurrency: a.maxConcurrency,
    cancelRequested: a.cancelRequestedAt !== null,
    // Every session compared, side A's first, each in date order. For a same-witness check, its two sessions.
    depositions: sessionIds.map((d, i) => ({ ...docs.find((x) => x.id === d)!, side: (cross ? (i < cross.a.length ? "A" : "B") : i === 0 ? "A" : "B") as "A" | "B" })),
    findings: { total: rows.length, groups, decided: rows.filter((r) => r.reviewState !== "unreviewed" && !quarantined(r)).length },
    cost: { calls: cost.calls, actualUsd: cost.actualUsd, budgetUsd: a.budgetUsd, budgetSpentUsd: cost.budget?.spentUsd ?? 0, budgetReservedUsd: cost.budget?.reservedUsd ?? 0 },
    createdAt: a.createdAt,
    startedAt: a.startedAt,
    finishedAt: a.finishedAt,
    updatedAt: a.updatedAt,
  };
}

// What testimony a direct analysis received, from code (pages and lines stored), and what the model
// itself said limited its review, kept apart and named as the model's. Read-only.
export async function evidenceCoverage(db: Database, a: typeof analyses.$inferSelect, runs: Awaited<ReturnType<typeof discoveryRunsOf>>) {
  const sides = a.kind === "cross_witness" ? crossSidesOf(a) : null;
  const ids = sides ? [...sides.a, ...sides.b] : [a.depositionA, a.depositionB];
  const docs = await db.select({ id: depositions.id, validation: depositions.validation }).from(depositions).where(inArray(depositions.id, ids));
  const sessions = await Promise.all(
    ids.map(async (depositionId) => {
      const rows = await db.select({ page: lines.printedPage, line: lines.lineNo }).from(lines).where(eq(lines.depositionId, depositionId)).orderBy(lines.printedPage, lines.lineNo);
      const coverage = sessionCoverage(rows, (docs.find((d) => d.id === depositionId)?.validation ?? null) as Parameters<typeof sessionCoverage>[1]);
      return { depositionId, ...coverage, notes: coverageNotes(coverage) };
    }),
  );
  const answered = [...runs].reverse().find((r) => r.status === "succeeded");
  const summary = (answered?.output as { summary?: { completion_status: "complete" | "partial"; limitations: string[] } } | null)?.summary ?? null;
  return { sessions, model: summary ? { completionStatus: summary.completion_status, limitations: summary.limitations } : null };
}

// What each paid attempt did, and which model's results these are, in fields a lawyer can read.
function discoveryView(runs: Awaited<ReturnType<typeof discoveryRunsOf>>, cross: boolean) {
  const fallback = runs.find((r) => r.role === "fallback");
  const answered = [...runs].reverse().find((r) => r.status === "succeeded");
  return {
    resultModel: answered ? (answered.answered_by ?? answered.model) : null,
    resultModelName: answered ? modelName(answered.answered_by ?? answered.model, cross) : null,
    usedFallback: fallback !== undefined,
    fallbackModel: cross ? CROSS_FALLBACK_MODEL : DISCOVERY_FALLBACK_MODEL,
    primaryModel: cross ? CROSS_DISCOVERY_MODEL : DISCOVERY_MODEL,
    promptVersion: runs[0]?.prompt_version ?? (cross ? CROSS_DISCOVERY_PROMPT_VERSION : DISCOVERY_PROMPT_VERSION),
    sourceHashes: runs[0]?.source_hashes ?? null,
    attempts: runs.map((r) => ({ attempt: r.attempt, role: r.role, model: r.model, modelName: modelName(r.model, cross), status: r.status, batchId: r.batch_id, stopReason: r.stop_reason, refusalCategory: r.refusal_category, error: r.error, costUsd: r.cost_usd === null ? null : Number(r.cost_usd), inputTokens: r.input_tokens, outputTokens: r.output_tokens, thinkingTokens: r.thinking_tokens, latencyMs: r.latency_ms })),
  };
}

type DirectChecks = { lane: FindingGroup; evidenceKey: string; a: DirectSideCheck; b: DirectSideCheck; modelClassification: string; duplicates: unknown[] };
type DirectSideCheck = { depositionId: number; citation: string; speaker: string; ocr: { read: boolean; minConfidence: number | null; lowLines: string[] }; reportedSpeech: boolean };

// The findings of an analysis, grouped for review, each with its references and where it came from.
export async function analysisFindings(db: Database, id: number) {
  const rows = await db
    .select({ f: findings, v: verdicts, c: candidates })
    .from(findings)
    .innerJoin(verdicts, eq(verdicts.id, findings.verdictId))
    .innerJoin(candidates, eq(candidates.id, findings.candidateId))
    .where(eq(candidates.candidateSet, candidateSetOf(id)));
  const firstLines = await firstLineRefs(db, rows.flatMap((r) => [r.c.exchangeA, r.c.exchangeB]));
  const standing = await standingOf(db, rows.map((r) => r.f.id));
  const items = rows
    .map(({ f, v, c }) => {
      const parsed = v.parsed as Verdict;
      const direct = (f.checks as { direct?: DirectChecks }).direct ?? null;
      const st = standing.get(f.id)!;
      return {
        id: f.id,
        group: findingGroup(f, st.state === "quarantined"),
        standing: st,
        model: v.model,
        modelName: modelName(v.model, (f.checks as { cross?: unknown }).cross !== undefined),
        direct: direct ? { modelClassification: direct.modelClassification, evidenceKey: direct.evidenceKey, duplicates: direct.duplicates.length, ocrRead: direct.a.ocr.read || direct.b.ocr.read, lowOcrLines: [...direct.a.ocr.lowLines, ...direct.b.ocr.lowLines], speakers: [direct.a.speaker, direct.b.speaker] } : null,
        classification: f.type,
        priority: f.priority,
        score: f.score,
        band: f.band,
        evidenceStatus: f.evidenceStatus,
        unscoredReason: f.unscoredReason,
        contextRequested: f.contextRequested,
        reviewState: f.reviewState,
        reviewNote: f.reviewNote,
        subject: (parsed as { sharedSubject?: string }).sharedSubject ?? null,
        source: v.origin as VerdictSource,
        rank: c.mergedRank,
        // A direct finding cites exact lines, which may start well inside the exchange.
        cross: (f.checks as { cross?: CrossChecks }).cross ? { witnessA: (f.checks as { cross: CrossChecks }).cross.witnessA, witnessB: (f.checks as { cross: CrossChecks }).cross.witnessB } : null,
        a: direct ? { depositionId: direct.a.depositionId, ref: direct.a.citation } : { depositionId: c.depositionA, ref: firstLines.get(c.exchangeA) ?? null },
        b: direct ? { depositionId: direct.b.depositionId, ref: direct.b.citation } : { depositionId: c.depositionB, ref: firstLines.get(c.exchangeB) ?? null },
        sameEvent: parsed.sameEvent,
        explanation: parsed.explanation,
      };
    })
    .sort((x, y) => compareFindings(x, y));
  const groups = GROUP_ORDER.map((g) => ({ group: g, label: GROUP_LABELS[g], findings: items.filter((i) => i.group === g) }));
  // Proposed findings that couldn't be tied to stored lines have no finding row. They stay visible here.
  const runs = await discoveryRunsOf(db, id);
  const isCross = (await db.select({ kind: analyses.kind }).from(analyses).where(eq(analyses.id, id)))[0]?.kind === "cross_witness";
  const notStored = runs.flatMap((r) => ((r.audit ?? []) as { shown: string; findingId: string; classification: string; explanation: string; reasons: string[]; evidenceStatus: string; a: { citation: string }; b: { citation: string } }[])
    .filter((x) => x.shown === "not_stored")
    .map((x) => ({ findingId: x.findingId, model: r.answered_by ?? r.model, modelName: modelName(r.answered_by ?? r.model, isCross), classification: x.classification, evidenceStatus: x.evidenceStatus, reasons: x.reasons, citationA: x.a.citation, citationB: x.b.citation, explanation: x.explanation })));
  return { groups, notStored };
}

async function firstLineRefs(db: Database, partIds: number[]) {
  if (partIds.length === 0) return new Map<number, string>();
  const rows = await db.execute<{ exchange_id: string; page: number; line: number }>(sql`
    select distinct on (el.exchange_id) el.exchange_id, l.printed_page as page, l.line_no as line
    from exchange_lines el join lines l on l.id = el.line_id
    where el.exchange_id in (${sql.join(partIds.map((p) => sql`${p}`), sql`, `)})
    order by el.exchange_id, l.printed_page, l.line_no
  `);
  return new Map(rows.rows.map((r) => [Number(r.exchange_id), ref(r.page, r.line)]));
}

// contextLineIds: absent on whole-case packets, which carry only the cited exchanges.
type PacketSide = { id: string; session?: "A" | "B"; depositionId: number; groupId: number; partIds?: number[]; lineIds: number[]; contextLineIds?: number[]; gapBefore?: boolean; gapAfter?: boolean };

// One finding with both passages as stored: every line's page:line and text from the transcript,
// the lines code found the cited phrase on, and the context shown to the adjudicator.
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
  const parsed = v.parsed as Verdict;
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
  const direct = (f.checks as { direct?: DirectChecks }).direct ?? null;
  const cross = (f.checks as { cross?: CrossChecks }).cross ?? null;
  const usedFallback = direct !== null && v.model === (cross ? CROSS_FALLBACK_MODEL : DISCOVERY_FALLBACK_MODEL);
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
    analysisId: c.jobId,
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
    source: { kind: v.origin as VerdictSource, label: direct ? directSourceLabel(v.model, usedFallback, cross !== null) : SOURCE_LABELS[v.origin as VerdictSource], model: v.model, modelName: modelName(v.model, cross !== null), usedFallback, promptVersion: v.promptVersion, verdictId: v.id, replayOf: v.replayOf },
    direct: direct ? { modelClassification: direct.modelClassification, evidenceKey: direct.evidenceKey, duplicates: direct.duplicates, sharedSubject: (parsed as { sharedSubject?: string }).sharedSubject ?? null, missingContext: (parsed as { missingContext?: string }).missingContext ?? null, reasoning: (parsed as { confidenceRationale?: string }).confidenceRationale ?? null, conflictBasis: (parsed as { conflictBasisText?: string }).conflictBasisText ?? null, a: { speaker: direct.a.speaker, ocr: direct.a.ocr, reportedSpeech: direct.a.reportedSpeech }, b: { speaker: direct.b.speaker, ocr: direct.b.ocr, reportedSpeech: direct.b.reportedSpeech } } : null,
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
    // A cross-witness finding: whose testimony each side is, its session label, and how each witness
    // knows what they said, as the model read it.
    cross: cross ? { witnessA: cross.witnessA, witnessB: cross.witnessB, sessionA: cross.sessionA, sessionB: cross.sessionB, basisA: cross.basisA, basisB: cross.basisB } : null,
    a: side("a"),
    b: side("b"),
  };
}
type CrossChecks = { witnessA: string; witnessB: string; sessionA: string | null; sessionB: string | null; basisA: string; basisB: string };
type SideCheck = { status: string; reason: string | null; location: string | null; evidenceLineIds: number[]; bareAnswer?: boolean; matchScore: number };
type AttributionCheck = { level: string; codeRule?: string; disagreement?: string | null; qualifier: string | null; noRecall: boolean; approximation: boolean };

export function analysisRoutes({ db, pool, boss }: { db: Database; pool: Pool; boss: PgBoss }): Router {
  const router = Router();

  // What checking two sessions is expected to cost, before anything is sent: the prompt the check
  // would send, sized from measured rates. Nothing is reserved or sent.
  // Excluded copies keep their analyses and findings but are never compared again.
  const excludedMessage = (d: { id: number; excludedReason: string | null; duplicateOf: number | null }) =>
    d.excludedReason === "duplicate"
      ? `Deposition ${d.id} is a duplicate copy of deposition ${d.duplicateOf}; check that one instead.`
      : `Deposition ${d.id} was read by an older parser and is kept for its earlier findings only; it can't be checked again.`;

  router.get("/cases/:id/estimate", async (req, res) => {
    const caseId = Id.safeParse(req.params.id);
    const q = z.object({ a: Id, b: Id }).safeParse(req.query);
    if (!caseId.success || !q.success) return res.status(400).json({ error: "The case ID and both deposition IDs (a, b) must be positive numbers." });
    const docs = await db.select().from(depositions).where(and(eq(depositions.caseId, caseId.data), inArray(depositions.id, [q.data.a, q.data.b])));
    if (docs.length !== 2) return res.status(404).json({ error: "Both depositions must belong to this case." });
    const excluded = docs.find((d) => d.excludedReason !== null);
    if (excluded) return res.status(409).json({ error: excludedMessage(excluded), code: "deposition_excluded" });
    // Sessions of two different witnesses are a cross-witness check: witness A's is the earlier session.
    if (docs[0].witnessId !== docs[1].witnessId) {
      const [x, y] = [...docs].sort((p, q) => (p.takenOn ?? "9999").localeCompare(q.takenOn ?? "9999") || p.id - q.id);
      const estimate = await estimateCrossDiscovery(db, { witnessA: x.witnessId, witnessB: y.witnessId, a: [x.id], b: [y.id] });
      return res.json({ estimate: { ...estimate, budgetUsd: DEFAULT_CROSS_BUDGET_USD } });
    }
    const estimate = await estimateDiscovery(db, { witnessId: docs[0].witnessId, depositionA: docs[0].id, depositionB: docs[1].id });
    return res.json({ estimate: { ...estimate, budgetUsd: DEFAULT_DIRECT_BUDGET_USD } });
  });

  router.post("/cases/:id/analyses", async (req, res) => {
    const caseId = Id.safeParse(req.params.id);
    if (!caseId.success) return res.status(400).json({ error: "The case ID must be a positive number." });
    const body = StartAnalysis.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: `Invalid analysis request: ${body.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` });
    const b = body.data;
    const method = b.method ?? (b.mode === "live" ? DIRECT_FABLE : "hybrid");
    if (method === DIRECT_FABLE && b.mode === "demo") return res.status(400).json({ error: "Direct discovery has no demo mode: a demo replays stored hybrid assessments." });
    if (b.depositionA === b.depositionB) return res.status(400).json({ error: "Choose two different deposition sessions." });
    const strategy = STRATEGIES[b.strategy];
    const maxConcurrency = strategy.id === "A" ? 1 : (b.maxConcurrency ?? strategy.maxConcurrency);
    const docs = await db.select().from(depositions).where(and(eq(depositions.caseId, caseId.data), inArray(depositions.id, [b.depositionA, b.depositionB])));
    if (docs.length !== 2) return res.status(404).json({ error: "Both depositions must belong to this case." });
    const excluded = docs.find((d) => d.excludedReason !== null);
    if (excluded) return res.status(409).json({ error: excludedMessage(excluded), code: "deposition_excluded" });
    // Sessions of two different witnesses: a cross-witness check, read by Opus. Direct discovery only.
    const cross = docs[0].witnessId !== docs[1].witnessId;
    if (cross && method !== DIRECT_FABLE) return res.status(400).json({ error: "Comparing two witnesses runs as a live check only: it has no example or hybrid mode." });
    const budgetUsd = b.budgetUsd ?? (cross ? DEFAULT_CROSS_BUDGET_USD : method === DIRECT_FABLE ? DEFAULT_DIRECT_BUDGET_USD : DEFAULT_BUDGET_USD);
    // The dates decide which session is the earlier one in every finding, so neither may be guessed.
    if (docs.some((d) => !d.takenOn)) return res.status(400).json({ error: "Add the date each session was taken before checking them. The dates decide which testimony came first.", code: "date_missing" });
    // Session A is the earlier one (by date, then by upload order), as the findings show them. In a
    // cross-witness check its witness is witness A.
    const [first, second] = [...docs].sort((x, y) => (x.takenOn ?? "9999").localeCompare(y.takenOn ?? "9999") || x.id - y.id);

    const outcome = await withTransaction(pool, async (tx, client) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`analysis:${first.id}:${second.id}:${b.mode}`}, 0))`);
      const [active] = await tx
        .select({ id: analyses.id })
        .from(analyses)
        .where(and(eq(analyses.depositionA, first.id), eq(analyses.depositionB, second.id), eq(analyses.mode, b.mode), eq(analyses.retrieval, method), inArray(analyses.status, [...ACTIVE])));
      if (active) return { id: active.id, created: false };
      // One analysis at a time per workspace (api/caseRuns.ts runningAnalysis).
      const busy = await runningAnalysis(db, caseId.data);
      if (busy) return { busy };
      const [a] = await tx
        .insert(analyses)
        .values({ caseId: caseId.data, kind: cross ? "cross_witness" : "same_witness", witnessId: first.witnessId, witnessBId: cross ? second.witnessId : null, depositionA: first.id, depositionB: second.id, mode: b.mode, retrieval: method, promptVersion: cross ? CROSS_DISCOVERY_PROMPT_VERSION : method === DIRECT_FABLE ? DISCOVERY_PROMPT_VERSION : b.promptVersion, effort: method === DIRECT_FABLE ? DISCOVERY_EFFORT : b.effort, maxCandidates: b.maxCandidates, budgetUsd, strategy: strategy.id, candidatesPerRequest: strategy.candidatesPerRequest, maxConcurrency })
        .returning({ id: analyses.id });
      const [budget] = await tx.insert(budgets).values({ name: `analysis-${a.id}`, limitUsd: budgetUsd }).returning({ id: budgets.id });
      await tx.update(analyses).set({ budgetId: budget.id }).where(eq(analyses.id, a.id));
      await enqueueAnalysis(boss, { analysisId: a.id }, { client });
      return { id: a.id, created: true };
    });
    if ("busy" in outcome) return res.status(409).json(runningConflict(outcome.busy as RunningAnalysis));
    return res.status(outcome.created ? 202 : 200).json({ created: outcome.created, analysis: await analysisView(db, outcome.id) });
  });

  router.get("/cases/:id/analyses", async (req, res) => {
    const caseId = Id.safeParse(req.params.id);
    if (!caseId.success) return res.status(400).json({ error: "The case ID must be a positive number." });
    const ids = await db.select({ id: analyses.id }).from(analyses).where(eq(analyses.caseId, caseId.data)).orderBy(desc(analyses.id));
    return res.json({ analyses: await Promise.all(ids.map((r) => analysisView(db, r.id))) });
  });

  // Everything the cross-case screens (Overview, Depositions, Findings, Analyses) show, in one
  // response, so the browser doesn't fetch every case and analysis on its own. Findings come from
  // finished analyses. shortcut: built per case and per analysis in-process; replace with set-based
  // queries if a workspace grows past a few hundred analyses.
  router.get("/workspace", async (_req, res) => {
    const summaries = await caseSummaries(db, res.locals.user?.orgId);
    const details = (await Promise.all(summaries.map((c) => caseDetail(db, c.id)))).filter((d) => d !== null);
    const ids = details.flatMap((d) => d.analyses.map((a) => a.id));
    const views = (await Promise.all(ids.map((id) => analysisView(db, id)))).filter((v) => v !== null);
    const caseName = new Map(details.map((d) => [d.case.id, d.case.name]));
    const findings = (await Promise.all(views.filter((v) => v.findings.total > 0).map(async (v) => {
      const { groups } = await analysisFindings(db, v.id);
      return groups.flatMap((g) => g.findings.map((f) => ({ ...f, analysisId: v.id, caseName: caseName.get(v.caseId) ?? "Unknown case" })));
    }))).flat();
    // Whole-case analyses running now (confirmed or test-model, not estimates), so every screen can show a case at work.
    const caseIds = summaries.map((c) => c.id);
    const running = caseIds.length ? (await db.execute<{ id: number }>(sql`select id from case_runs where case_id in (${sql.join(caseIds.map((x) => sql`${x}`), sql`, `)}) and status in ('queued', 'retrieving', 'adjudicating', 'reconciling') and (confirmed_at is not null or mode = 'mock') order by id`)).rows : [];
    const caseRuns = (await Promise.all(running.map((r) => caseRunReport(db, Number(r.id))))).filter((r) => r !== null);
    return res.json({ cases: summaries, details, analyses: views.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()), findings, caseRuns });
  });

  router.get("/analyses/:id", async (req, res) => {
    const id = Id.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "The analysis ID must be a positive number." });
    const view = await analysisView(db, id.data);
    if (!view) return res.status(404).json({ error: "Analysis not found." });
    return res.json({ analysis: view });
  });

  // Continue a blocked or failed analysis, optionally with a larger budget. Completed work is kept,
  // and candidates that already have a verdict are not adjudicated again.
  router.post("/analyses/:id/resume", async (req, res) => {
    const id = Id.safeParse(req.params.id);
    const body = z.object({ budgetUsd: z.number().min(0).max(MAX_BUDGET_USD).optional(), retryInvalid: z.boolean().optional() }).safeParse(req.body ?? {});
    if (!id.success || !body.success) return res.status(400).json({ error: "Invalid resume request." });
    const outcome = await withTransaction(pool, async (tx, client) => {
      const [a] = await tx.select().from(analyses).where(eq(analyses.id, id.data)).for("update");
      if (!a) return "not_found" as const;
      if (a.retrieval === DIRECT_FABLE) {
        const attempts = await tx.$count(discoveryRuns, eq(discoveryRuns.analysisId, a.id));
        if (!directCanResume(a.status, attempts)) return "direct_final" as const;
      } else if (!RESUMABLE.includes(a.status)) return a.status;
      if (body.data.budgetUsd !== undefined) {
        if (body.data.budgetUsd < a.budgetUsd) return "lower_budget" as const;
        await tx.update(budgets).set({ limitUsd: body.data.budgetUsd }).where(eq(budgets.id, a.budgetId!));
        await tx.update(analyses).set({ budgetUsd: body.data.budgetUsd }).where(eq(analyses.id, a.id));
      }
      await tx.update(analyses).set({ status: "queued", error: null, finishedAt: null, cancelRequestedAt: null, updatedAt: new Date(), progress: sql`${analyses.progress} || ${JSON.stringify({ retryInvalid: body.data.retryInvalid === true })}::jsonb` }).where(eq(analyses.id, a.id));
      await enqueueAnalysis(boss, { analysisId: a.id }, { client });
      return "queued" as const;
    });
    if (outcome === "not_found") return res.status(404).json({ error: "Analysis not found." });
    if (outcome === "direct_final") return res.status(409).json({ error: "This direct analysis can't continue, because no paid attempt is repeated. Start a new analysis." });
    if (outcome === "lower_budget") return res.status(400).json({ error: "A budget can only be raised, not lowered." });
    if (outcome !== "queued") return res.status(409).json({ error: `Only a blocked or failed analysis can be resumed; this one is ${outcome}.` });
    return res.status(202).json({ analysis: await analysisView(db, id.data) });
  });

  // Stop an analysis: no new request is sent, and requests in flight are aborted within a second or
  // so and counted in full, in case they were billed. One not yet running is cancelled at once.
  router.post("/analyses/:id/cancel", async (req, res) => {
    const id = Id.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "The analysis ID must be a positive number." });
    const [a] = await db.select().from(analyses).where(eq(analyses.id, id.data));
    if (!a) return res.status(404).json({ error: "Analysis not found." });
    if (!ACTIVE.includes(a.status as (typeof ACTIVE)[number])) return res.status(409).json({ error: `Only a running analysis can be cancelled; this one is ${a.status}.` });
    // A direct analysis may hold a paid batch: the job cancels it and records what came back.
    const holdsBatch = a.retrieval === DIRECT_FABLE && (await db.select({ id: discoveryRuns.id }).from(discoveryRuns).where(eq(discoveryRuns.analysisId, a.id)).limit(1)).length > 0;
    const changes = a.runnerId === null && !holdsBatch ? { status: "cancelled" as const, error: "Cancelled before it started assessing. Completed findings are kept.", finishedAt: new Date() } : {};
    await db.update(analyses).set({ cancelRequestedAt: new Date(), updatedAt: new Date(), ...changes }).where(eq(analyses.id, a.id));
    return res.status(202).json({ analysis: await analysisView(db, a.id) });
  });

  router.get("/analyses/:id/findings", async (req, res) => {
    const id = Id.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "The analysis ID must be a positive number." });
    const [a] = await db.select({ id: analyses.id }).from(analyses).where(eq(analyses.id, id.data));
    if (!a) return res.status(404).json({ error: "Analysis not found." });
    return res.json(await analysisFindings(db, id.data));
  });

  // A person's decision on a finding, kept with the case. A null decision clears it.
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

  router.get("/findings/:id", async (req, res) => {
    const id = Id.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: "The finding ID must be a positive number." });
    const detail = await findingDetail(db, id.data);
    if (!detail) return res.status(404).json({ error: "Finding not found." });
    return res.json({ finding: detail });
  });

  return router;
}

