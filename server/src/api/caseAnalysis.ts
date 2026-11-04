// The hand-authored whole-case analysis of the demo case (data/demoCaseAnalysis.ts), resolved against the
// stored transcript. Read-only: it writes nothing and calls no model.
//
// Each citation names file lines of a session's original text. Code reads those lines from the stored
// original, finds the stored exchange with exactly that question and answer, and returns that exchange's
// stored lines (with a little context). What the app shows is always the stored lines, never the
// fixture's text. A citation that doesn't resolve is returned as unverified, with its reason, never dropped.

import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { cases, depositions, exchanges, lines, witnesses } from "../db/schema";
import { CASE_ANALYSIS_EDITS, CASE_ANALYSIS_FOR, DEMO_CASE_ANALYSIS, type CaseAnalysis } from "../data/demoCaseAnalysis";
import { readUpload, UPLOADS_DIR } from "../ingest/uploads";
import type { Report } from "./report";

const CONTEXT = 2; // stored lines shown before and after the cited exchange

export type AnalysisLine = { id: number; ref: string; text: string; role: string; highlighted: boolean };
export type ResolvedCitation = {
  sessionId: string; witness: string; date: string; depositionId: number | null;
  status: "verified" | "unverified"; reason: string | null; range: string | null; lines: AnalysisLine[];
};
export type CaseAnalysisView = {
  provenance: CaseAnalysis["provenance"]; execution: CaseAnalysis["execution"]; coverage: CaseAnalysis["coverage"]; edits: string;
  sessions: { id: string; witness: string; date: string; depositionId: number | null }[];
  pairs: (CaseAnalysis["pairwise_coverage"][number] & { sessions: { id: string; witness: string; date: string; depositionId: number | null }[] })[];
  findings: (Omit<CaseAnalysis["findings"][number], "source_citations"> & { citations: [ResolvedCitation, ResolvedCitation] })[];
  unverified: number;
};

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const ref = (l: { printedPage: number; lineNo: number }) => `${l.printedPage}:${String(l.lineNo).padStart(2, "0")}`;

// The cited file lines as a question and an answer ("Q: …", "A: …"), or why they aren't one.
export function questionAndAnswer(fileLines: readonly string[], start: number, end: number): { question: string; answer: string } | { error: string } {
  if (start > end || end > fileLines.length) return { error: `lines ${start}–${end} are not in the file (${fileLines.length} lines)` };
  const cited = fileLines.slice(start - 1, end);
  const q = cited.find((l) => /^Q:\s*/.test(l)), a = cited.find((l) => /^A:\s*/.test(l));
  if (!q || !a) return { error: `lines ${start}–${end} are not one question and its answer` };
  return { question: norm(q.replace(/^Q:\s*/, "")), answer: norm(a.replace(/^A:\s*/, "")) };
}

export async function caseAnalysisView(db: Database, caseId: number, uploadsDir = UPLOADS_DIR, analysis: CaseAnalysis = DEMO_CASE_ANALYSIS): Promise<CaseAnalysisView | null> {
  const [kase] = await db.select({ name: cases.name }).from(cases).where(eq(cases.id, caseId));
  if (!kase || kase.name !== CASE_ANALYSIS_FOR) return null;

  const deps = await db
    .select({ id: depositions.id, takenOn: depositions.takenOn, storageKey: depositions.storageKey, witness: witnesses.name, excluded: depositions.excludedReason })
    .from(depositions).innerJoin(witnesses, eq(witnesses.id, depositions.witnessId))
    .where(eq(depositions.caseId, caseId));
  const sessions = analysis.sessions.map((s) => ({ ...s, depositionId: deps.find((d) => d.witness === s.witness && d.takenOn === s.date && !d.excluded)?.id ?? null }));
  const sessionOf = new Map(sessions.map((s) => [s.id, s]));

  // Each session's original text (to locate citations) and its stored exchanges and lines (to show them).
  const ids = sessions.flatMap((s) => (s.depositionId === null ? [] : [s.depositionId]));
  const exch = ids.length ? await db.select().from(exchanges).where(inArray(exchanges.depositionId, ids)) : [];
  const allLines = ids.length ? await db.select({ id: lines.id, depositionId: lines.depositionId, printedPage: lines.printedPage, lineNo: lines.lineNo, text: lines.rawText, role: lines.speakerRole }).from(lines).where(inArray(lines.depositionId, ids)).orderBy(asc(lines.id)) : [];
  const originals = new Map<number, string[] | null>();
  for (const d of deps.filter((x) => ids.includes(x.id))) originals.set(d.id, await readUpload(d.storageKey, uploadsDir).then((b) => new TextDecoder().decode(b).split("\n"), () => null));

  const resolve = (c: CaseAnalysis["findings"][number]["source_citations"][number]): ResolvedCitation => {
    const s = sessionOf.get(c.session_id);
    const base = { sessionId: c.session_id, witness: s?.witness ?? "?", date: s?.date ?? "?", depositionId: s?.depositionId ?? null, range: null, lines: [] };
    if (!s) return { ...base, status: "unverified", reason: `session ${c.session_id} is not in the analysis's session list` };
    if (s.depositionId === null) return { ...base, status: "unverified", reason: `no stored session of ${s.witness} taken on ${s.date} in this case` };
    const file = originals.get(s.depositionId);
    if (!file) return { ...base, status: "unverified", reason: "the session's original file is not available" };
    const qa = questionAndAnswer(file, c.line_start, c.line_end);
    if ("error" in qa) return { ...base, status: "unverified", reason: qa.error };
    const e = exch.find((x) => x.depositionId === s.depositionId && norm(x.questionText) === qa.question && norm(x.answerText) === qa.answer);
    if (!e) return { ...base, status: "unverified", reason: "no stored exchange has exactly this question and answer" };
    const own = allLines.filter((l) => l.depositionId === s.depositionId);
    const first = own.findIndex((l) => l.id === e.firstLineId), last = own.findIndex((l) => l.id === e.lastLineId);
    if (first < 0 || last < first) return { ...base, status: "unverified", reason: "the stored exchange's lines could not be found" };
    const from = Math.max(0, first - CONTEXT);
    return {
      ...base, status: "verified", reason: null, range: `${ref(own[first])}–${ref(own[last])}`,
      lines: own.slice(from, last + CONTEXT + 1).map((l, i) => ({ id: l.id, ref: ref(l), text: l.text, role: l.role, highlighted: from + i >= first && from + i <= last })),
    };
  };

  const findings = analysis.findings.map(({ source_citations, ...f }) => ({ ...f, citations: [resolve(source_citations[0]), resolve(source_citations[1])] as [ResolvedCitation, ResolvedCitation] }));
  return {
    provenance: analysis.provenance, execution: analysis.execution, coverage: analysis.coverage, edits: CASE_ANALYSIS_EDITS,
    sessions,
    pairs: analysis.pairwise_coverage.map((p) => ({ ...p, sessions: p.session_ids.map((id) => sessionOf.get(id) ?? { id, witness: "?", date: "?", depositionId: null }) })),
    findings,
    unverified: findings.reduce((n, f) => n + f.citations.filter((c) => c.status === "unverified").length, 0),
  };
}

// ---------- The case analysis's PDF report ----------

// The reviewer's decisions, sent by the client (they are kept in the reviewer's browser; see
// client/src/lib/caseDecisions.ts).
export const CaseDecisionsBody = z.object({
  decisions: z.array(z.object({ id: z.string().max(40), decision: z.enum(["confirmed", "needs_context", "dismissed"]), note: z.string().max(5000), at: z.string().max(40) }).strict()).max(500),
}).strict();
export type CaseDecisionInput = z.infer<typeof CaseDecisionsBody>["decisions"][number];

const HEADLINE = { incompatible: "Incompatible statements", uncertain: "Uncertain: needs context", compatible: "Likely compatible" } as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso: string) => { const [y, m, d] = iso.slice(0, 10).split("-").map(Number); return `${MONTHS[m - 1]} ${d}, ${y}`; };

// The report data renderReport (report.ts) draws, for the findings kept in a case analysis: each with its
// two passages as resolved from the stored transcript, the hand-written explanation and the reviewer's note.
export async function caseAnalysisReport(db: Database, caseId: number, decisions: readonly CaseDecisionInput[], uploadsDir = UPLOADS_DIR): Promise<Report | null> {
  const view = await caseAnalysisView(db, caseId, uploadsDir);
  if (!view) return null;
  const known = new Set(view.findings.map((f) => f.id));
  const byId = new Map(decisions.filter((d) => known.has(d.id)).map((d) => [d.id, d]));
  const side = (c: ResolvedCitation) => ({
    deposition: { witness: c.witness, takenOn: c.date, physicalLines: false },
    range: c.range,
    lines: c.lines.map((l) => ({ ref: l.ref, text: l.text, highlighted: l.highlighted, pageInferred: false })),
  });
  const kept = view.findings.filter((f) => byId.get(f.id)?.decision === "confirmed");
  // Shaped as the report's finding entries: renderReport reads only these fields.
  const entries = kept.map((f) => {
    const d = byId.get(f.id)!;
    const [earlier, later] = [...f.citations].sort((x, y) => x.date.localeCompare(y.date));
    return {
      group: "case_analysis", groupLabel: HEADLINE[f.classification], classification: f.classification,
      cross: f.relationship === "cross_witness" ? { witnessA: earlier.witness, witnessB: later.witness } : null,
      direct: { sharedSubject: f.topic[0].toUpperCase() + f.topic.slice(1) },
      reviewState: "confirmed", reviewedAt: d.at, reviewNote: d.note.trim() || null,
      a: side(earlier), b: side(later),
      assessment: { explanation: f.summary, alternativeExplanation: null },
    } as unknown as Report["entries"][number];
  });
  const covered = view.pairs.map((p) => {
    const [x, y] = [...p.sessions].sort((a, b) => a.date.localeCompare(b.date));
    return p.relationship === "within_witness" ? `${x.witness}: ${day(x.date)} and ${day(y.date)}` : `${x.witness}, ${day(x.date)}, and ${y.witness}, ${day(y.date)}`;
  });
  const gaps = [
    ...view.pairs.filter((p) => p.status !== "complete").map((p) => `Pair ${p.pair_id}: ${p.status}`),
    ...(view.unverified > 0 ? [`${view.unverified} citation(s) could not be matched to the stored transcript.`] : []),
  ];
  const [kase] = await db.select({ name: cases.name }).from(cases).where(eq(cases.id, caseId));
  return {
    name: kase.name, witnesses: [...new Set(view.sessions.map((s) => s.witness))], covered, gaps,
    kept: kept.length, context: view.findings.filter((f) => byId.get(f.id)?.decision === "needs_context").length, withContext: false,
    entries, authorship: "hand",
  };
}
