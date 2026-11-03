// Cross-witness direct discovery: one model reads one session of each of two witnesses and proposes where
// their accounts may conflict; code checks every citation (verify/cross.ts), sorts each into a lane and
// stores it as a finding. The request itself (reserve, submit, poll, settle, refusal fallback) is
// discover.ts's, shared with same-witness discovery; this file supplies what differs.

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { analyses, candidates, depositions, exchangeLines, exchanges, findings, lines, verdicts, witnesses } from "../db/schema";
import { hasPhysicalLines } from "../ingest";
import { EVIDENCE_STRENGTH_CROSS_VERSION, evidenceStrengthCross, unscoredReasonOf } from "../score";
import { evidenceKey, groupDuplicates, type DirectSide, type StoredLine } from "../verify";
import { verifyCrossFinding, type CrossCheck, type CrossStoredSession } from "../verify/cross";
import { CROSS_PROMPT_VERSION_V2, CROSS_SYSTEM_V2, crossUserPrompt, type CrossSession } from "./discoverCrossPrompt";
import { CROSS_JSON_SCHEMA, readCrossOutput, type CrossFinding, type CrossOutput } from "./discoverCrossSchema";

// Chosen from the Phase 3 to 5 evaluations (November 3, 2026): on the independent synthetic suite Opus
// matched Fable's recall and control rate at about a third of the cost, and on Simpson-Resnick it found
// the same review-worthy pairs. Fable answers only after a confirmed refusal, as Opus does for same-witness.
export const CROSS_DISCOVERY_MODEL = "claude-opus-5-5";
export const CROSS_FALLBACK_MODEL = "claude-fable-5-1";
export const CROSS_DISCOVERY_PROMPT_VERSION = CROSS_PROMPT_VERSION_V2;
export const CROSS_DISCOVERY_SYSTEM = CROSS_SYSTEM_V2;
export { CROSS_JSON_SCHEMA, readCrossOutput };
const CONTEXT_LINES = 5;

type Analysis = typeof analyses.$inferSelect;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type CrossLoaded = { witnessA: string; witnessB: string; sessions: (CrossStoredSession & CrossSession)[]; hashes: Record<number, string> };

// Each side's sessions in date order: A1, A2, ... for witness A, B1, B2, ... for witness B. A stored analysis
// has one session a side (A1 and B1); the prompt and benchmarks allow more.
export async function loadCrossSessions(db: Database, sides: { witnessA: number; witnessB: number; a: readonly number[]; b: readonly number[] }): Promise<CrossLoaded> {
  const names = await db.select({ id: witnesses.id, name: witnesses.name }).from(witnesses).where(inArray(witnesses.id, [sides.witnessA, sides.witnessB]));
  const nameOf = (id: number) => names.find((w) => w.id === id)?.name ?? "Witness";
  const docs = await db.select({ id: depositions.id, takenOn: depositions.takenOn, sha: depositions.fileSha256, validation: depositions.validation }).from(depositions).where(inArray(depositions.id, [...sides.a, ...sides.b]));
  const ordered = (ids: readonly number[]) => ids.map((id) => docs.find((d) => d.id === id)!).filter(Boolean).sort((x, y) => (x.takenOn ?? "9999").localeCompare(y.takenOn ?? "9999") || x.id - y.id);
  const sessions: CrossLoaded["sessions"] = [];
  for (const [side, witnessId, ids] of [["A", sides.witnessA, sides.a], ["B", sides.witnessB, sides.b]] as const) {
    for (const [i, doc] of ordered(ids).entries()) {
      const rows = await db
        .select({ id: lines.id, page: lines.printedPage, line: lines.lineNo, pdfPage: lines.pdfPage, text: lines.rawText, role: lines.speakerRole, ocrConfidence: lines.ocrConfidence })
        .from(lines)
        .where(eq(lines.depositionId, doc.id))
        .orderBy(asc(lines.printedPage), asc(lines.lineNo));
      sessions.push({ label: `${side}${i + 1}`, witness: nameOf(witnessId), takenOn: doc.takenOn ?? "date not stated", description: `session of ${doc.takenOn ?? "date not stated"}`, depositionId: doc.id, lines: rows as StoredLine[], physicalLines: hasPhysicalLines(doc.validation) });
    }
  }
  return { witnessA: nameOf(sides.witnessA), witnessB: nameOf(sides.witnessB), sessions, hashes: Object.fromEntries(docs.map((d) => [d.id, d.sha])) };
}

// The two sides of a stored cross-witness analysis: witness A's session and witness B's.
export const crossSidesOf = (a: Pick<Analysis, "witnessId" | "witnessBId" | "depositionA" | "depositionB">) => ({ witnessA: a.witnessId, witnessB: a.witnessBId!, a: [a.depositionA], b: [a.depositionB] });

export const crossPrompt = (loaded: CrossLoaded) => crossUserPrompt(loaded.witnessA, loaded.witnessB, loaded.sessions);

// discover-cross classifications as finding types: the same names the same-witness path stores.
const FINDING_TYPE: Record<CrossFinding["classification"], string> = { direct_conflict: "direct", possible_conflict_needs_context: "insufficient_evidence", recollection_or_knowledge_difference: "false_positive", compatible: "false_positive" };

type Proposed = { finding: CrossFinding; check: CrossCheck; a: DirectSide; b: DirectSide; lane: CrossCheck["lane"]; swapped: boolean };

// Witness A's side first, whichever way round the model cited them.
function oriented(finding: CrossFinding, check: CrossCheck): Proposed {
  const swapped = finding.session_a.startsWith("B") && finding.session_b.startsWith("A");
  return { finding, check, a: swapped ? check.b : check.a, b: swapped ? check.a : check.b, lane: check.lane, swapped };
}
const pick = <T>(p: Proposed, a: T, b: T): [T, T] => (p.swapped ? [b, a] : [a, b]);

const sideChecks = (s: DirectSide) => ({
  source: { status: s.quote === "exact" || s.quote === "fragments" ? "verified" : s.quote === "approximate" ? "approximate" : s.quote === "elsewhere_in_session" ? "wrong_reference" : "unsupported", reason: s.resolved ? null : "the citation doesn't resolve to stored lines", location: s.speaker, evidenceLineIds: s.lineIds, matchScore: s.matchScore },
  attribution: { level: s.level, codeRule: s.rule, disagreement: null, qualifier: s.qualifier, noRecall: s.noRecall, approximation: false },
});

// Stores what verification made of every proposed finding: a row for each that ties to stored exchanges,
// and an audit entry for every one, including those that couldn't be tied (shown as not stored).
export async function storeCrossFindings(tx: Tx, a: Analysis, llmCallId: number, modelAnswered: string, output: CrossOutput, loaded: CrossLoaded) {
  const proposed = output.findings.map((f) => oriented(f, verifyCrossFinding(f, loaded.sessions)));
  const lineIds = proposed.flatMap((p) => [...p.a.lineIds, ...p.b.lineIds]);
  const parts = lineIds.length === 0 ? [] : await tx
    .select({ lineId: exchangeLines.lineId, exchangeId: exchanges.id, groupId: exchanges.groupId })
    .from(exchangeLines)
    .innerJoin(exchanges, eq(exchanges.id, exchangeLines.exchangeId))
    .where(inArray(exchangeLines.lineId, lineIds));
  const partOf = new Map<number, (typeof parts)[number]>();
  for (const p of parts) if (!partOf.has(p.lineId) || p.exchangeId < partOf.get(p.lineId)!.exchangeId) partOf.set(p.lineId, p);
  const firstPart = (s: DirectSide) => s.lineIds.map((id) => partOf.get(id)).find((p) => p !== undefined);
  const labelOf = (depositionId: number) => loaded.sessions.find((s) => s.depositionId === depositionId)?.label ?? null;

  const placed = proposed.filter((p) => firstPart(p.a) && firstPart(p.b) && p.a.depositionId !== p.b.depositionId);
  const audit = proposed.map((p) => ({ findingId: p.finding.finding_id, classification: p.finding.classification, lane: p.lane, evidenceStatus: p.check.evidenceStatus, identityIssues: p.check.identityIssues, reasons: p.check.reasons, a: p.a, b: p.b, explanation: p.finding.explanation, shown: "not_stored" as "not_stored" | "shown" | "duplicate" }));
  for (const group of groupDuplicates(placed)) {
    const [p, ...copies] = group;
    const [pa, pb] = [firstPart(p.a)!, firstPart(p.b)!];
    const key = evidenceKey(p.a, p.b);
    const f = p.finding;
    const [excerptA, excerptB] = pick(p, f.excerpt_a, f.excerpt_b);
    const [basisA, basisB] = pick(p, f.basis_a, f.basis_b);
    const [quoteA, quoteB] = pick(p, p.check.quotes.a, p.check.quotes.b);
    // The database keeps pairs in deposition order, and a pair can hold several distinct findings.
    const ordered = p.a.depositionId <= p.b.depositionId;
    const [low, high] = ordered ? [{ s: p.a, x: pa }, { s: p.b, x: pb }] : [{ s: p.b, x: pb }, { s: p.a, x: pa }];
    const pair = { candidateSet: `analysis-${a.id}`, depositionA: low.s.depositionId, groupA: low.x.groupId, depositionB: high.s.depositionId, groupB: high.x.groupId };
    const [existing] = await tx.select({ id: candidates.id }).from(candidates).where(and(eq(candidates.candidateSet, pair.candidateSet), eq(candidates.depositionA, pair.depositionA), eq(candidates.groupA, pair.groupA), eq(candidates.depositionB, pair.depositionB), eq(candidates.groupB, pair.groupB)));
    const candidateId = existing?.id ?? (await tx.insert(candidates).values({ ...pair, jobId: a.id, witnessId: a.witnessId, exchangeA: low.x.exchangeId, exchangeB: high.x.exchangeId, sources: ["direct_cross"], rrfScore: 0, mergedRank: placed.indexOf(p) + 1, evidence: [], status: "adjudicated", retrievalVersion: CROSS_DISCOVERY_PROMPT_VERSION }).returning({ id: candidates.id }))[0].id;
    const context = (s: DirectSide) => {
      const all = loaded.sessions.find((x) => x.depositionId === s.depositionId)!.lines;
      const [first, last] = [all.findIndex((l) => l.id === s.lineIds[0]), all.findIndex((l) => l.id === s.lineIds[s.lineIds.length - 1])];
      return all.slice(Math.max(0, first - CONTEXT_LINES), last + 1 + CONTEXT_LINES).map((l) => l.id).filter((id) => !s.lineIds.includes(id));
    };
    const sidePacket = (session: "A" | "B", s: DirectSide, x: typeof pa) => ({ id: `E${x.exchangeId}`, session, sessionLabel: labelOf(s.depositionId), depositionId: s.depositionId, groupId: x.groupId, partIds: [...new Set(s.lineIds.map((id) => partOf.get(id)?.exchangeId).filter((e): e is number => e !== undefined))], lineIds: s.lineIds, contextLineIds: context(s) });
    const parsed = {
      classification: FINDING_TYPE[f.classification], modelClassification: f.classification,
      evidenceAId: `E${pa.exchangeId}`, evidenceBId: `E${pb.exchangeId}`, keyPhraseA: excerptA, keyPhraseB: excerptB,
      attributionA: "unclear", attributionB: "unclear", stanceA: "unclear", stanceB: "unclear",
      sameEvent: "uncertain", scopeAligned: "uncertain", conflictBasis: "none", conflictBasisText: "", aboutTimingOfSameEvent: false,
      inferenceSteps: [], unestablishedAssumptions: f.missing_context ? [f.missing_context] : [], falsePositiveReason: null,
      explanation: f.explanation, alternativeExplanation: null, needsMoreContext: p.lane === "needs_context",
      sharedSubject: f.subject, missingContext: f.missing_context, basisA, basisB,
    };
    const [verdict] = await tx
      .insert(verdicts)
      .values({ candidateId, model: modelAnswered, promptVersion: CROSS_DISCOVERY_PROMPT_VERSION, effort: a.effort, status: "valid", raw: JSON.stringify(f), parsed, packet: { sides: [sidePacket("A", p.a, pa), sidePacket("B", p.b, pb)] }, origin: "model", llmCallId })
      .returning({ id: verdicts.id });
    const [ca, cb] = [sideChecks(p.a), sideChecks(p.b)];
    const strength = evidenceStrengthCross({ classification: f.classification, lane: p.lane, a: p.a, b: p.b, basisA, basisB });
    // A person's decision on these same passages carries into a new report of them.
    const [decided] = await tx.select({ state: findings.reviewState, note: findings.reviewNote, at: findings.reviewedAt }).from(findings).where(and(eq(findings.caseId, a.caseId), sql`${findings.checks}->'direct'->>'evidenceKey' = ${key}`, sql`${findings.reviewState} <> 'unreviewed'`)).orderBy(desc(findings.reviewedAt)).limit(1);
    await tx.insert(findings).values({
      caseId: a.caseId, candidateId, verdictId: verdict.id, type: FINDING_TYPE[f.classification], evidenceStatus: p.check.evidenceStatus, attributionA: p.a.level, attributionB: p.b.level, score: strength.score, band: strength.band,
      unscoredReason: unscoredReasonOf(p.lane, p.check.evidenceStatus, strength.score),
      factors: strength.checks, caps: [],
      checks: {
        source: { status: p.check.evidenceStatus, a: ca.source, b: cb.source }, attribution: { a: ca.attribution, b: cb.attribution }, context: { detail: `${CONTEXT_LINES} lines either side of each citation, for reading. The model was given every stored line of each witness's sessions; see the analysis for pages it never received.` },
        timeCheck: null, notCorroborated: [], reasons: p.check.reasons, consistencyIssues: [],
        direct: { lane: p.lane, evidenceKey: key, a: p.a, b: p.b, identityIssues: p.check.identityIssues, modelClassification: f.classification, duplicates: copies.map((c) => ({ findingId: c.finding.finding_id, classification: c.finding.classification, a: c.a.citation, b: c.b.citation, explanation: c.finding.explanation })) },
        cross: { witnessA: loaded.witnessA, witnessB: loaded.witnessB, sessionA: labelOf(p.a.depositionId), sessionB: labelOf(p.b.depositionId), basisA, basisB, quotes: { a: quoteA, b: quoteB } },
      },
      rubricVersion: EVIDENCE_STRENGTH_CROSS_VERSION,
      priority: strength.priority,
      contextRequested: p.lane === "needs_context",
      ...(decided ? { reviewState: decided.state, reviewNote: decided.note, reviewedAt: decided.at } : {}),
    });
    audit[proposed.indexOf(p)].shown = "shown";
    for (const c of copies) audit[proposed.indexOf(c)].shown = "duplicate";
  }
  return audit;
}
