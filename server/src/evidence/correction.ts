// Safe evidence correction: re-reading a stored document under the current parser without leaving anything
// derived from it broken, stale or silently current. No model call. Run only by scripts/evidence.ts.
//
// It wraps correctInPlace (audit.ts, which keeps line and exchange IDs) and syncUnits (claims/facts/store.ts)
// and adds what a rehearsal on copies of real data showed they miss:
//   - Integrity before and after: every reference into the document's exchanges must be whole (fact units,
//     facts, screening entries, candidate group numbers), or nothing is written.
//   - Facts on a replaced exchange are detached and marked stale before the foreign key could delete them.
//   - Screening entries that name a replaced exchange block the correction: they record model calls.
//   - Only the expected lines may change (`expect.lines`, page:line), or nothing is written.
//   - Findings, verdicts and candidates whose evidence changed are quarantined (evidence_quarantine): their
//     rows and a person's review are never changed; the quarantine says they no longer describe the source.
//   - The dry run is the whole correction, rolled back. Executing needs the dry run's plan hash.
//   - A backup is written before commit; rollbackCorrection() restores it and proves the state is the one before.
//
// Worker coordination. Executing first HOLDS the document (depositions.evidence_hold, its own transaction),
// refusing while any analysis or case run of the case is unfinished or the document isn't ready. From then on
// the database itself rejects every write to the document's evidence and derived rows (migration 0039's
// triggers, SQLSTATE VE001) except the holder's, and analysis and case-run jobs wait instead of reading it. The
// correction then runs in one transaction that also releases the hold. If it fails, nothing changed and the hold
// is released; if the process dies in between, the hold stays until releaseHold(), which checks nothing changed.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, inArray, notInArray, sql, type SQL } from "drizzle-orm";
import { buildUnits, loadDocument } from "../claims/facts/context";
import { syncUnits } from "../claims/facts/store";
import type { Database } from "../db/client";
import { candidates, depositions, evidenceMigrations, evidenceQuarantine, exchangeLines, exchanges, lines, lineSegments } from "../db/schema";
import type { DepositionRead } from "../ingest";
import { correctInPlace } from "./audit";

export const CORRECTION_VERSION = "evidence-correction-v1";
export const EVIDENCE_ON_HOLD = "VE001"; // the SQLSTATE migration 0039's triggers raise
// Unfinished work that blocks a hold: analyses and case runs not in these states (jobs/analysis.ts TERMINAL and
// jobs/caseRun.ts CASE_RUN_TERMINAL, repeated here to keep evidence/ free of the jobs module; a test keeps them equal).
export const ANALYSIS_DONE = ["completed", "failed", "blocked_budget", "blocked_credentials", "cancelled", "interrupted"];
export const CASE_RUN_DONE = ["completed", "incomplete", "failed", "blocked_budget", "blocked_credentials", "cancelled", "interrupted"];

export type Step = "hold" | "probe" | "facts" | "correct" | "units" | "quarantine" | "verify";
export type CorrectionOptions = {
  read?: (data: Uint8Array, witness: string) => Promise<DepositionRead>;
  uploadsDir?: string;
  backupDir: string;
  expect?: { lines: string[] }; // page:line of every line the correction may change; required to execute
  planHash?: string; // the dry run's; required to execute
  failAfter?: Step; // tests only: fail after this step ("hold": as if the process died after holding)
  onStep?: (step: Step) => Promise<void>; // tests only: called after each step inside the transaction
};
export type Integrity = { factUnitsDangling: number; factUnitsGroupMismatch: number; factsDangling: number; screeningDangling: number; candidateGroupMismatch: number };
export type CorrectionResult = {
  documentId: number;
  outcome: "dry_run" | "applied" | "busy" | "already_applied" | "integrity_failed_before" | "refused_by_correction" | "blocked" | "unexpected_difference" | "verification_failed" | "plan_changed" | "no_expectation";
  detail?: string;
  planHash?: string;
  plan?: CorrectionPlan;
  integrityBefore?: Integrity;
  integrityAfter?: Integrity;
  correction?: Record<string, unknown>;
  migrationId?: string;
  backup?: string;
};
export type CorrectionPlan = {
  version: string; documentId: number; fromParser: string; toParser: string; beforeHash: string;
  changedLines: string[]; regroupedLines: number;
  exchanges: { before: number; after: number; removed: string[]; added: string[]; keptWithChangedContent: number; groupRenumbered: number };
  facts: { detachedFromReplacedExchanges: number };
  units: { versions: string[]; reset: number; rekeyed: number; removed: number; added: number; factsMadeStale: number; skipped: string | null };
  quarantine: { findings: number[]; reviewedFindings: number; verdicts: number[]; candidates: number[] };
};

const arr = (ids: readonly number[]) => sql`${`{${ids.join(",")}}`}::bigint[]`;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const rows = async <T>(db: Database, q: SQL) => (await db.execute(q)).rows as T[];
class Refusal extends Error { constructor(readonly result: CorrectionResult) { super(result.outcome); } }
export class InjectedFailure extends Error {}

// Whether an error is the database refusing a write to held evidence (drizzle wraps the driver's error).
export function isEvidenceOnHold(e: unknown): boolean {
  for (let x = e as { code?: string; cause?: unknown } | undefined, i = 0; x && i < 5; x = x.cause as typeof x, i++) if (x.code === EVIDENCE_ON_HOLD) return true;
  return false;
}

// Documents among these whose evidence is held by a correction or rollback. Jobs wait while any is.
export async function heldDocuments(db: Database, ids: readonly number[]) {
  if (!ids.length) return [];
  return db.select({ id: depositions.id, hold: depositions.evidenceHold }).from(depositions).where(and(inArray(depositions.id, [...ids]), sql`${depositions.evidenceHold} is not null`));
}

// Unfinished work on the document's case, and whether the document itself is ready: a hold waits for none.
// With `before`, only work created before then (work created later checks the hold before reading).
export async function unfinishedWork(db: Database, dep: number, before?: Date) {
  const since = before ? sql`and created_at < ${before.toISOString()}::timestamptz` : sql``;
  const [r] = await rows<{ status: string; analyses: number; caseRuns: number }>(db, sql`select d.status::text status,
      (select count(*) from analyses a where a.case_id = d.case_id and a.status::text <> all(${`{${ANALYSIS_DONE.join(",")}}`}::text[]) ${since})::int analyses,
      (select count(*) from case_runs r where r.case_id = d.case_id and r.status <> all(${`{${CASE_RUN_DONE.join(",")}}`}::text[]) ${since})::int "caseRuns"
    from depositions d where d.id = ${dep}`);
  return r;
}

// Every reference into this document's exchanges that a correction can break. All must be 0.
export async function integrity(db: Database, dep: number): Promise<Integrity> {
  const [r] = await rows<Integrity>(db, sql`select
    (select count(*) from fact_units f where f.deposition_id = ${dep} and exists (select 1 from unnest(f.exchange_ids) x where not exists (select 1 from exchanges e where e.id = x and e.deposition_id = ${dep})))::int "factUnitsDangling",
    (select count(*) from fact_units f where f.deposition_id = ${dep} and exists (select 1 from unnest(f.exchange_ids) x join exchanges e on e.id = x where e.group_id <> f.group_id))::int "factUnitsGroupMismatch",
    (select count(*) from facts t where t.deposition_id = ${dep} and t.exchange_id is not null and not exists (select 1 from exchanges e where e.id = t.exchange_id))::int "factsDangling",
    (select count(*) from screening_entries s where ${dep} = any(s.document_ids) and exists (select 1 from unnest(s.exchange_ids) x where not exists (select 1 from exchanges e where e.id = x)))::int "screeningDangling",
    ((select count(*) from candidates c join exchanges e on e.id = c.exchange_a where c.deposition_a = ${dep} and c.group_a <> e.group_id)
      + (select count(*) from candidates c join exchanges e on e.id = c.exchange_b where c.deposition_b = ${dep} and c.group_b <> e.group_id))::int "candidateGroupMismatch"`);
  return r;
}

// The document's evidence and every row derived from it, as one hash. The hold and epoch are left out: they
// say who holds the evidence, not what it is.
export async function documentHash(db: Database, dep: number) {
  const part = (q: SQL) => sql`(select md5(coalesce(string_agg(md5(j::text), '' order by md5(j::text)), '')) from (${q}) z(j))`;
  const [r] = await rows<{ h: string }>(db, sql`select md5(concat_ws('|',
    ${part(sql`select to_jsonb(d) - 'evidence_hold' - 'evidence_epoch' from depositions d where id = ${dep}`)},
    ${part(sql`select to_jsonb(l) from lines l where deposition_id = ${dep}`)},
    ${part(sql`select to_jsonb(s) from line_segments s where deposition_id = ${dep}`)},
    ${part(sql`select to_jsonb(e) - 'tsv' from exchanges e where deposition_id = ${dep}`)},
    ${part(sql`select to_jsonb(x) from exchange_lines x where deposition_id = ${dep}`)},
    ${part(sql`select to_jsonb(c) from candidates c where deposition_a = ${dep} or deposition_b = ${dep}`)},
    ${part(sql`select to_jsonb(v) from verdicts v join candidates c on c.id = v.candidate_id where c.deposition_a = ${dep} or c.deposition_b = ${dep}`)},
    ${part(sql`select to_jsonb(f) from findings f join candidates c on c.id = f.candidate_id where c.deposition_a = ${dep} or c.deposition_b = ${dep}`)},
    ${part(sql`select to_jsonb(s) from statement_cards s where deposition_id = ${dep}`)},
    ${part(sql`select to_jsonb(s) from card_coverage s where deposition_id = ${dep}`)},
    ${part(sql`select to_jsonb(s) from claims s where deposition_id = ${dep}`)},
    ${part(sql`select to_jsonb(s) from claim_tagging s where deposition_id = ${dep}`)},
    ${part(sql`select to_jsonb(f) from fact_units f where deposition_id = ${dep}`)},
    ${part(sql`select to_jsonb(f) from facts f where deposition_id = ${dep}`)},
    ${part(sql`select to_jsonb(s) from screening_entries s where ${dep} = any(s.document_ids)`)})) h`);
  return r.h;
}

type ExchangeState = { id: number; key: string; group: number; content: string; lineIds: number[] };
type LineState = { id: number; ref: string; text: string; role: string; segs: string; member: string };
async function snapshot(db: Database, dep: number) {
  const ex = await rows<ExchangeState>(db, sql`select e.id::int id, e.evidence_key key, e.group_id "group",
      md5(((to_jsonb(e) - 'id' - 'group_id' - 'tsv')::text) || coalesce((select jsonb_agg(to_jsonb(x) - 'exchange_id' order by x.line_id)::text from exchange_lines x where x.exchange_id = e.id), '')) content,
      coalesce((select array_agg(x.line_id::int order by x.line_id) from exchange_lines x where x.exchange_id = e.id), '{}') "lineIds"
    from exchanges e where e.deposition_id = ${dep}`);
  const ln = await rows<LineState>(db, sql`select l.id::int id, l.printed_page || ':' || l.line_no ref, md5(l.raw_text) text, l.speaker_role::text role,
      coalesce((select jsonb_agg(to_jsonb(s) - 'id' order by s.seq)::text from line_segments s where s.line_id = l.id), '') segs,
      coalesce((select string_agg(concat_ws(',', e.evidence_key, x.role, x.segment_from, x.segment_to), ';' order by e.evidence_key) from exchange_lines x join exchanges e on e.id = x.exchange_id where x.line_id = l.id), '') member
    from lines l where l.deposition_id = ${dep}`);
  return { ex: new Map(ex.map((e) => [e.id, e])), lines: new Map(ln.map((l) => [l.id, l])) };
}

type Body = { result: CorrectionResult; backupData: Record<string, unknown> | null; afterHash: string };

// The correction itself, inside the caller's transaction (which holds the document row FOR UPDATE).
async function correctionBody(tx: Database, dep: number, opts: CorrectionOptions, scratch: string, migrationId: string | null): Promise<Body> {
  const execute = migrationId !== null;
  const stop = (r: CorrectionResult): never => { throw new Refusal(r); };
  const step = async (s: Step) => {
    await opts.onStep?.(s);
    if (opts.failAfter === s) throw new InjectedFailure(`injected failure after ${s}`);
  };
  const integrityBefore = await integrity(tx, dep);
  if (Object.values(integrityBefore).some((n) => n > 0)) stop({ documentId: dep, outcome: "integrity_failed_before", integrityBefore, detail: "References into this document are already broken; repair them before correcting it." });
  const [{ fromParser }] = await rows<{ fromParser: string }>(tx, sql`select parser_version "fromParser" from depositions where id = ${dep}`);
  const beforeHash = await documentHash(tx, dep);
  const before = await snapshot(tx, dep);
  const unitsBefore = (await rows<{ j: Record<string, unknown> }>(tx, sql`select to_jsonb(f) j from fact_units f where deposition_id = ${dep}`)).map((r) => r.j);
  const factsBefore = await rows<{ id: number; exchangeId: number | null; j: Record<string, unknown> }>(tx, sql`select id::int, exchange_id::int "exchangeId", to_jsonb(f) j from facts f where deposition_id = ${dep}`);

  // 1. Probe: correctInPlace in a savepoint that is rolled back, to learn which exchanges it replaces.
  let probe: Record<string, any> = {};
  let afterProbe = new Set<number>();
  try {
    await tx.transaction(async (sp) => {
      probe = (await correctInPlace(sp as unknown as Database, dep, { read: opts.read, uploadsDir: opts.uploadsDir, backupDir: mkdtempSync(path.join(scratch, "probe-")), execute: true })) as Record<string, any>;
      afterProbe = new Set((await rows<{ id: number }>(sp as unknown as Database, sql`select id::int from exchanges where deposition_id = ${dep}`)).map((r) => r.id));
      throw new InjectedFailure("probe");
    });
  } catch (e) { if (!(e instanceof InjectedFailure)) throw e; }
  const correction = { outcome: probe.outcome, detail: probe.detail, fromParser: probe.fromParser, toParser: probe.toParser, lines: probe.lines, exchanges: probe.exchanges, findings: probe.findings && { total: probe.findings.total, carriesOver: probe.findings.carriesOver, requiresReview: probe.findings.requiresReview }, mapping: probe.mapping };
  if (probe.outcome !== "corrected") stop({ documentId: dep, outcome: "refused_by_correction", correction, integrityBefore, detail: probe.detail });
  const removed = [...before.ex.keys()].filter((id) => !afterProbe.has(id));
  await step("probe");

  // 2. Screening entries on replaced exchanges block it; facts on them are kept, detached and stale.
  const [{ screening }] = await rows<{ screening: number }>(tx, sql`select count(*)::int screening from screening_entries where exchange_ids && ${arr(removed)}`);
  if (screening > 0) stop({ documentId: dep, outcome: "blocked", correction, integrityBefore, detail: `${screening} screening entries name exchanges the correction replaces; they record model calls and are never rewritten.` });
  const detached = factsBefore.filter((f) => f.exchangeId !== null && removed.includes(f.exchangeId)).map((f) => f.id);
  if (detached.length) await tx.execute(sql`update facts set exchange_id = null, status = case when status = 'indexed' then 'stale' else status end, warnings = array_append(warnings, 'exchange_replaced_by_parser_correction') where id = any(${arr(detached)})`);
  await step("facts");

  // 3. The correction (a savepoint of this transaction).
  const done = (await correctInPlace(tx, dep, { read: opts.read, uploadsDir: opts.uploadsDir, backupDir: mkdtempSync(path.join(scratch, "correct-")), execute: true })) as Record<string, any>;
  if (done.outcome !== "corrected") stop({ documentId: dep, outcome: "plan_changed", correction, detail: `The correction answered ${done.outcome} after the probe answered corrected.` });
  await step("correct");
  const after = await snapshot(tx, dep);
  const added = [...after.ex.keys()].filter((id) => !before.ex.has(id));
  // Lines whose speaker or segments changed, and lines that moved to another exchange (a split moves its neighbours).
  const changedLines = [...after.lines.values()].filter((l) => { const b = before.lines.get(l.id)!; return b.role !== l.role || b.segs !== l.segs; });
  const regrouped = [...after.lines.values()].filter((l) => before.lines.get(l.id)!.member !== l.member);
  const changedLineIds = new Set([...changedLines, ...regrouped].map((l) => l.id));
  const keptChanged = [...after.ex.values()].filter((e) => before.ex.has(e.id) && before.ex.get(e.id)!.content !== e.content).map((e) => e.id);
  const renumbered = [...after.ex.values()].filter((e) => before.ex.has(e.id) && before.ex.get(e.id)!.group !== e.group).length;

  // 4. Only the expected difference: changed lines are the expected ones, and every replaced or changed exchange holds one.
  if (!opts.expect && execute) stop({ documentId: dep, outcome: "no_expectation", detail: "Executing needs the expected changed lines (expect.lines)." });
  if (opts.expect) {
    const want = new Set(opts.expect.lines);
    const refOf = (id: number) => before.lines.get(id)!.ref;
    const unexpected = {
      extraLines: changedLines.filter((l) => !want.has(l.ref)).map((l) => l.ref),
      missingLines: [...want].filter((r) => ![...changedLines, ...regrouped].some((l) => l.ref === r)),
      unexplainedExchanges: [...removed.map((id) => before.ex.get(id)!), ...keptChanged.map((id) => after.ex.get(id)!)].filter((e) => !e.lineIds.some((l) => want.has(refOf(l)))).map((e) => e.key),
      textChanged: [...after.lines.values()].filter((l) => before.lines.get(l.id)?.text !== l.text).map((l) => l.ref),
    };
    if (Object.values(unexpected).some((v) => v.length)) stop({ documentId: dep, outcome: "unexpected_difference", correction, detail: JSON.stringify(unexpected).slice(0, 2000) });
  }

  // 5. Fact units follow the corrected evidence (syncUnits: stale facts for changed sources, re-keyed units for unchanged ones).
  const versions = (await rows<{ v: string }>(tx, sql`select distinct extractor_version v from fact_units where deposition_id = ${dep} order by 1`)).map((r) => r.v);
  const [{ excluded, status }] = await rows<{ excluded: string | null; status: string }>(tx, sql`select excluded_reason excluded, status::text status from depositions where id = ${dep}`);
  const units: CorrectionPlan["units"] = { versions, reset: 0, rekeyed: 0, removed: 0, added: 0, factsMadeStale: 0, skipped: excluded || status !== "ready" ? `document ${excluded ?? status}` : null };
  if (versions.length && !units.skipped) {
    const [{ n: staleBefore }] = await rows<{ n: number }>(tx, sql`select count(*)::int n from facts where deposition_id = ${dep} and status = 'stale'`);
    const keysBefore = new Set(unitsBefore.map((u) => u.unit_key as string));
    for (const v of versions) { const r = await syncUnits(tx, dep, v); units.reset += r.staleUnits; units.rekeyed += r.rekeyed ?? 0; }
    const built = new Set(buildUnits(await loadDocument(tx, dep)).map((u) => u.unitKey));
    units.added = [...built].filter((k) => !keysBefore.has(k)).length * versions.length;
    units.removed = [...keysBefore].filter((k) => !built.has(k)).length;
    const [{ n: staleAfter }] = await rows<{ n: number }>(tx, sql`select count(*)::int n from facts where deposition_id = ${dep} and status = 'stale'`);
    units.factsMadeStale = staleAfter - staleBefore;
  }
  await step("units");

  // 6. Quarantine: candidates, verdicts and findings whose evidence changed. An exchange whose row is identical
  //    but holds a line that changed speaker or moved is affected too (correctInPlace calls that "carries over").
  const holdsChanged = [...after.ex.values()].filter((e) => e.lineIds.some((l) => changedLineIds.has(l))).map((e) => e.id);
  const affected = [...new Set([...removed, ...added, ...keptChanged, ...holdsChanged])];
  const staleCandidates = (await rows<{ id: number }>(tx, sql`select id::int from candidates where (deposition_a = ${dep} and exchange_a = any(${arr(affected)})) or (deposition_b = ${dep} and exchange_b = any(${arr(affected)}))`)).map((r) => r.id);
  const stale = await rows<{ verdict: number; finding: number | null; review: string | null; note: string | null; reviewedAt: string | null; why: string }>(tx, sql`
    select v.id::int verdict, f.id::int finding, f.review_state review, f.review_note note, f.reviewed_at::text "reviewedAt",
      case when c.id = any(${arr(staleCandidates)}) then 'its exchange changed' else 'a line its packet showed changed speaker or exchange' end why
    from verdicts v join candidates c on c.id = v.candidate_id left join findings f on f.verdict_id = v.id
    where (c.deposition_a = ${dep} or c.deposition_b = ${dep}) and (c.id = any(${arr(staleCandidates)})
      or exists (select 1 from jsonb_array_elements(coalesce(v.packet->'sides', '[]')) s
                 where (s->>'depositionId')::bigint = ${dep} and (
                   exists (select 1 from jsonb_array_elements_text(coalesce(s->'lineIds', '[]') || coalesce(s->'contextLineIds', '[]')) l where l::bigint = any(${arr([...changedLineIds])}))
                   or exists (select 1 from jsonb_array_elements_text(coalesce(s->'partIds', '[]')) p where p::bigint = any(${arr(affected)})))))`);
  await step("quarantine");

  // 7. Verification: every reference whole, no source text changed, no fact deleted, and every finding the
  //    correction says needs review quarantined.
  const integrityAfter = await integrity(tx, dep);
  const factsAfter = new Set((await rows<{ id: number }>(tx, sql`select id::int from facts where deposition_id = ${dep}`)).map((r) => r.id));
  const quarantinedFindings = new Set(stale.map((s) => s.finding).filter((f): f is number => f !== null));
  const needsReview = ((done.findings?.requiresReview ?? []) as { findingId: number }[]).map((f) => f.findingId);
  const failures = {
    ...Object.fromEntries(Object.entries(integrityAfter).filter(([, n]) => n > 0)),
    ...(factsBefore.some((f) => !factsAfter.has(f.id)) ? { factsDeleted: factsBefore.filter((f) => !factsAfter.has(f.id)).length } : {}),
    ...([...after.lines.values()].some((l) => before.lines.get(l.id)?.text !== l.text) || after.lines.size !== before.lines.size ? { sourceTextChanged: 1 } : {}),
    ...(needsReview.some((f) => !quarantinedFindings.has(f)) ? { reviewNotQuarantined: needsReview.filter((f) => !quarantinedFindings.has(f)).length } : {}),
  };
  await step("verify");
  if (Object.keys(failures).length) stop({ documentId: dep, outcome: "verification_failed", integrityBefore, integrityAfter, correction, detail: JSON.stringify(failures) });

  const plan: CorrectionPlan = {
    version: CORRECTION_VERSION, documentId: dep, fromParser, toParser: probe.toParser as string, beforeHash,
    changedLines: changedLines.map((l) => l.ref).sort(), regroupedLines: regrouped.length,
    exchanges: { before: before.ex.size, after: after.ex.size, removed: removed.map((id) => before.ex.get(id)!.key).sort(), added: added.map((id) => after.ex.get(id)!.key).sort(), keptWithChangedContent: keptChanged.length, groupRenumbered: renumbered },
    facts: { detachedFromReplacedExchanges: detached.length },
    units,
    quarantine: { findings: [...quarantinedFindings].sort((a, b) => a - b), reviewedFindings: stale.filter((s) => s.finding !== null && s.review !== "unreviewed").length, verdicts: stale.map((s) => s.verdict).sort((a, b) => a - b), candidates: [...staleCandidates].sort((a, b) => a - b) },
  };
  const planHash = hash(plan);
  const result: CorrectionResult = { documentId: dep, outcome: "dry_run", planHash, plan, integrityBefore, integrityAfter, correction };
  if (!execute) return { result, backupData: null, afterHash: "" };
  if (opts.planHash !== planHash) stop({ ...result, outcome: "plan_changed", detail: "The plan differs from the dry run's; run the dry run again and review it." });
  const reasonOf = (why: string) => `source re-read by ${plan.toParser}: ${why}`;
  const quarantine = [
    ...staleCandidates.map((id) => ({ migrationId: migrationId!, kind: "candidate", rowId: id, reason: reasonOf("its exchange changed"), prior: {} })),
    ...stale.map((s) => ({ migrationId: migrationId!, kind: "verdict", rowId: s.verdict, reason: `${reasonOf(s.why)}; not replayable`, prior: {} })),
    ...stale.filter((s) => s.finding !== null).map((s) => ({ migrationId: migrationId!, kind: "finding", rowId: s.finding!, reason: reasonOf(s.why), prior: { reviewState: s.review, reviewNote: s.note, reviewedAt: s.reviewedAt, parser: fromParser } })),
  ];
  for (let i = 0; i < quarantine.length; i += 500) await tx.insert(evidenceQuarantine).values(quarantine.slice(i, i + 500)).onConflictDoNothing();
  return { result, afterHash: await documentHash(tx, dep), backupData: { documentId: dep, beforeHash, correction: JSON.parse(readFileSync(done.backup, "utf8")), factUnits: unitsBefore, facts: factsBefore.map((f) => f.j) } };
}

const newId = (kind: string, dep: number) => `${kind}-${dep}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

// The dry run: the whole correction in a transaction that is rolled back. Changes nothing.
export async function planCorrection(db: Database, dep: number, opts: CorrectionOptions): Promise<CorrectionResult> {
  const scratch = mkdtempSync(path.join(tmpdir(), "evidence-correction-"));
  try {
    return await db.transaction(async (txn) => {
      const tx = txn as unknown as Database;
      const [d] = await rows<{ hold: string | null }>(tx, sql`select evidence_hold hold from depositions where id = ${dep} for update`);
      if (!d) throw new Error(`No document ${dep}.`);
      if (d.hold) throw new Refusal({ documentId: dep, outcome: "busy", detail: `The document's evidence is held by ${d.hold}.` });
      const body = await correctionBody(tx, dep, { ...opts, failAfter: undefined, onStep: undefined }, scratch, null);
      throw new Refusal(body.result); // roll back
    });
  } catch (e) {
    if (e instanceof Refusal) return e.result;
    throw e;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

// Holds the document's evidence, refusing while work on its case is unfinished. Its own transaction.
async function hold(db: Database, dep: number, kind: "correction" | "rollback", fields: { toParser: string; planHash?: string; rollbackOf?: string }): Promise<{ id: string } | CorrectionResult> {
  return db.transaction(async (txn) => {
    const tx = txn as unknown as Database;
    const [d] = await rows<{ hold: string | null; parser: string; status: string }>(tx, sql`select evidence_hold hold, parser_version parser, status::text status from depositions where id = ${dep} for update`);
    if (!d) throw new Error(`No document ${dep}.`);
    if (d.hold) return { documentId: dep, outcome: "busy" as const, detail: `The document's evidence is already held by ${d.hold}.` };
    if (fields.planHash) {
      const [done] = await tx.select({ id: evidenceMigrations.id }).from(evidenceMigrations).where(and(eq(evidenceMigrations.depositionId, dep), eq(evidenceMigrations.planHash, fields.planHash), eq(evidenceMigrations.status, "applied"), eq(evidenceMigrations.kind, "correction")));
      if (done) return { documentId: dep, outcome: "already_applied" as const, migrationId: done.id, detail: `Correction ${done.id} already applied this plan.` };
    }
    const work = await unfinishedWork(tx, dep);
    if (work.status !== "ready" || work.analyses > 0 || work.caseRuns > 0) return { documentId: dep, outcome: "busy" as const, detail: `Not while work on the case is unfinished: document ${work.status}, ${work.analyses} analyses and ${work.caseRuns} case runs running or queued. Let them finish or cancel them first.` };
    const id = newId(kind, dep);
    await tx.insert(evidenceMigrations).values({ id, depositionId: dep, kind, status: "holding", version: CORRECTION_VERSION, fromParser: d.parser, toParser: fields.toParser, planHash: fields.planHash ?? null, beforeHash: await documentHash(tx, dep), rollbackOf: fields.rollbackOf ?? null });
    await tx.update(depositions).set({ evidenceHold: id }).where(eq(depositions.id, dep));
    return { id };
  });
}

// Recovery: releases a hold whose correction or rollback never committed, after checking nothing changed.
export async function releaseHold(db: Database, migrationId: string) {
  return db.transaction(async (txn) => {
    const tx = txn as unknown as Database;
    const [m] = await tx.select().from(evidenceMigrations).where(eq(evidenceMigrations.id, migrationId));
    if (!m) throw new Error(`No evidence migration ${migrationId}.`);
    const [d] = await rows<{ hold: string | null }>(tx, sql`select evidence_hold hold from depositions where id = ${m.depositionId} for update`);
    if (d.hold !== migrationId) throw new Error(`Document ${m.depositionId} isn't held by ${migrationId}; nothing to release.`);
    // Applied (it committed, then the process stopped before releasing): the evidence must be what it left.
    // Holding (it never committed): the evidence must be what it was before.
    const expected = m.status === "applied" ? m.afterHash : m.status === "holding" ? m.beforeHash : null;
    if (!expected) throw new Error(`Migration ${migrationId} is ${m.status}; only a hold can be released.`);
    if ((await documentHash(tx, m.depositionId)) !== expected) throw new Error(`Document ${m.depositionId} changed while held by ${migrationId}; it isn't released. Investigate before releasing it by hand.`);
    if (m.status === "holding") await tx.update(evidenceMigrations).set({ status: "abandoned", finishedAt: new Date() }).where(eq(evidenceMigrations.id, migrationId));
    await tx.update(depositions).set({ evidenceHold: null }).where(eq(depositions.id, m.depositionId));
    return { migrationId, released: true };
  });
}

// Releases the hold of a migration that has just committed.
async function releaseApplied(db: Database, migrationId: string) {
  await db.execute(sql`update depositions set evidence_hold = null where evidence_hold = ${migrationId}`);
}

// Executes a reviewed dry run: hold, then the correction and the release in one transaction.
export async function applyCorrection(db: Database, dep: number, opts: CorrectionOptions): Promise<CorrectionResult> {
  if (!opts.expect) return { documentId: dep, outcome: "no_expectation", detail: "Executing needs the expected changed lines (expect.lines)." };
  if (!opts.planHash) return { documentId: dep, outcome: "plan_changed", detail: "Executing needs the dry run's plan hash." };
  const [{ parser }] = await rows<{ parser: string }>(db, sql`select parser_version parser from depositions where id = ${dep}`);
  const held = await hold(db, dep, "correction", { toParser: parser, planHash: opts.planHash });
  if (!("id" in held)) return held;
  if (opts.failAfter === "hold") throw new InjectedFailure("injected failure after hold");
  const scratch = mkdtempSync(path.join(tmpdir(), "evidence-correction-"));
  try {
    return await db.transaction(async (txn) => {
      const tx = txn as unknown as Database;
      await tx.execute(sql`select set_config('evidence.migration', ${held.id}, true)`);
      await tx.execute(sql`select 1 from depositions where id = ${dep} for update`);
      // Work that started just before the hold committed could still be reading: refuse until it has finished.
      const [m] = await tx.select({ at: evidenceMigrations.createdAt }).from(evidenceMigrations).where(eq(evidenceMigrations.id, held.id));
      const late = await unfinishedWork(tx, dep, m.at);
      if (late.analyses > 0 || late.caseRuns > 0) throw new Refusal({ documentId: dep, outcome: "busy", detail: `${late.analyses} analyses and ${late.caseRuns} case runs started before the hold are still unfinished.` });
      const body = await correctionBody(tx, dep, opts, scratch, held.id);
      mkdirSync(opts.backupDir, { recursive: true });
      const backup = path.join(opts.backupDir, `${held.id}.json`);
      writeFileSync(backup, JSON.stringify({ migrationId: held.id, afterHash: body.afterHash, ...body.backupData }));
      await tx.update(evidenceMigrations).set({ status: "applied", toParser: body.result.plan!.toParser, plan: body.result.plan, afterHash: body.afterHash, backup, finishedAt: new Date() }).where(eq(evidenceMigrations.id, held.id));
      await tx.update(depositions).set({ evidenceEpoch: sql`${depositions.evidenceEpoch} + 1` }).where(eq(depositions.id, dep));
      return { ...body.result, outcome: "applied" as const, migrationId: held.id, backup };
    }).then(async (r) => {
      // Committed with the hold still set, then released. A job's write that waited on the row lock is refused
      // either way: by the hold (VE001) or, once released, by its stale epoch (VE002, evidence/epoch.ts).
      await releaseApplied(db, held.id);
      return r;
    });
  } catch (e) {
    await releaseHold(db, held.id); // the transaction rolled back: nothing changed, so the hold goes too
    if (e instanceof Refusal) return { ...e.result, migrationId: held.id };
    throw e;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

// Puts back what a correction overwrote, from its backup (inside the caller's transaction). Exchanges that kept
// their ID are updated, never deleted, so what refers to them survives; exchanges the correction added are
// deleted only when nothing refers to them.
async function restore(tx: Database, b: { documentId: number; correction: any; factUnits: unknown[]; facts: unknown[] }) {
  const dep = b.documentId;
  const c = b.correction;
  const keep = (c.exchanges as { id: number }[]).map((e) => e.id);
  const added = (await tx.select({ id: exchanges.id }).from(exchanges).where(and(eq(exchanges.depositionId, dep), notInArray(exchanges.id, keep)))).map((r) => r.id);
  if (added.length) {
    const [r] = await rows<{ n: number }>(tx, sql`select ((select count(*) from candidates where exchange_a = any(${arr(added)}) or exchange_b = any(${arr(added)})) + (select count(*) from statement_cards where exchange_id = any(${arr(added)})) + (select count(*) from claims where exchange_id = any(${arr(added)})) + (select count(*) from facts where exchange_id = any(${arr(added)})))::int n`);
    if (r.n > 0) throw new Error(`${r.n} rows refer to exchanges the correction added; rolling back would delete them. Nothing was changed.`);
  }
  await tx.execute(sql`delete from fact_units where deposition_id = ${dep}`);
  if (b.factUnits.length) await tx.execute(sql`insert into fact_units select * from jsonb_populate_recordset(null::fact_units, ${JSON.stringify(b.factUnits)}::jsonb)`);
  await tx.execute(sql`update exchanges set group_id = -id where deposition_id = ${dep}`);
  if (added.length) await tx.delete(exchanges).where(inArray(exchanges.id, added));
  const existing = new Set((await tx.select({ id: exchanges.id }).from(exchanges).where(eq(exchanges.depositionId, dep))).map((r) => r.id));
  const revive = (e: Record<string, any>): Record<string, any> => ({ ...e, ...(e.createdAt ? { createdAt: new Date(e.createdAt) } : {}) });
  for (const e of c.exchanges) { const { id, ...fields } = revive(e); if (existing.has(id)) await tx.update(exchanges).set(fields).where(eq(exchanges.id, id)); else await tx.insert(exchanges).overridingSystemValue().values(revive(e) as unknown as typeof exchanges.$inferInsert); }
  await tx.delete(exchangeLines).where(eq(exchangeLines.depositionId, dep));
  for (let i = 0; i < c.exchangeLines.length; i += 2000) await tx.insert(exchangeLines).values(c.exchangeLines.slice(i, i + 2000));
  await tx.delete(lineSegments).where(eq(lineSegments.depositionId, dep));
  if (c.lineSegments.length) await tx.insert(lineSegments).values(c.lineSegments);
  for (const { id, ...fields } of c.lines) await tx.update(lines).set(fields).where(eq(lines.id, id));
  for (const g of c.candidateGroups) await tx.update(candidates).set({ groupA: g.groupA, groupB: g.groupB }).where(eq(candidates.id, g.id));
  await tx.update(depositions).set({ parserVersion: c.document.parserVersion, validation: c.document.validation }).where(eq(depositions.id, dep));
  if (b.facts.length) await tx.execute(sql`update facts f set status = o.status, exchange_id = o.exchange_id, warnings = o.warnings from jsonb_populate_recordset(null::facts, ${JSON.stringify(b.facts)}::jsonb) o where f.id = o.id`);
}

// Rolls back an applied correction: hold, then the restore and the release in one transaction. Refuses if the
// document changed since the correction; must end in the exact state before it, or nothing is changed.
export async function rollbackCorrection(db: Database, migrationId: string, opts: { failAfter?: "hold" | "restore" } = {}) {
  const [m] = await db.select().from(evidenceMigrations).where(eq(evidenceMigrations.id, migrationId));
  if (!m || m.kind !== "correction") throw new Error(`No correction ${migrationId}.`);
  if (m.status !== "applied") throw new Error(`Correction ${migrationId} is ${m.status}; only an applied correction can be rolled back.`);
  const b = JSON.parse(readFileSync(m.backup!, "utf8"));
  if (b.migrationId !== migrationId) throw new Error(`The backup ${m.backup} belongs to ${b.migrationId}, not ${migrationId}.`);
  const held = await hold(db, m.depositionId, "rollback", { toParser: m.fromParser, rollbackOf: migrationId });
  if (!("id" in held)) throw new Error(held.detail);
  if (opts.failAfter === "hold") throw new InjectedFailure("injected failure after hold");
  try {
    return await db.transaction(async (txn) => {
      const tx = txn as unknown as Database;
      await tx.execute(sql`select set_config('evidence.migration', ${held.id}, true)`);
      if ((await documentHash(tx, m.depositionId)) !== m.afterHash) throw new Error("The document changed after the correction; rolling back would overwrite that. Nothing was changed.");
      await restore(tx, b);
      if (opts.failAfter === "restore") throw new InjectedFailure("injected failure after restore");
      if ((await documentHash(tx, m.depositionId)) !== m.beforeHash) throw new Error("Rollback didn't restore the exact state before the correction; nothing was changed.");
      await tx.update(evidenceMigrations).set({ status: "rolled_back", finishedAt: new Date() }).where(eq(evidenceMigrations.id, migrationId));
      await tx.update(evidenceMigrations).set({ status: "applied", afterHash: m.beforeHash, finishedAt: new Date() }).where(eq(evidenceMigrations.id, held.id));
      await tx.update(depositions).set({ evidenceEpoch: sql`${depositions.evidenceEpoch} + 1` }).where(eq(depositions.id, m.depositionId));
      return { migrationId, rollbackId: held.id, restored: true };
    }).then(async (r) => {
      await releaseApplied(db, held.id);
      return r;
    });
  } catch (e) {
    await releaseHold(db, held.id);
    throw e;
  }
}

// Policy for findings whose source is superseded (a legacy parse, a source whose text a re-read changes, or
// findings a refused correction lists): quarantine them and their verdicts, changing no evidence row.
export async function quarantineFindings(db: Database, dep: number, reason: string, only?: readonly number[]) {
  return db.transaction(async (txn) => {
    const tx = txn as unknown as Database;
    const [d] = await rows<{ parser: string; hold: string | null }>(tx, sql`select parser_version parser, evidence_hold hold from depositions where id = ${dep} for update`);
    if (d.hold) throw new Error(`The document's evidence is held by ${d.hold}.`);
    const id = newId("quarantine", dep);
    const before = await documentHash(tx, dep);
    const found = await rows<{ verdict: number; finding: number | null; candidate: number; review: string | null; note: string | null; reviewedAt: string | null }>(tx, sql`select v.id::int verdict, f.id::int finding, c.id::int candidate, f.review_state review, f.review_note note, f.reviewed_at::text "reviewedAt" from verdicts v join candidates c on c.id = v.candidate_id left join findings f on f.verdict_id = v.id where (c.deposition_a = ${dep} or c.deposition_b = ${dep}) and ${only ? sql`f.id = any(${arr(only)})` : sql`true`}`);
    await tx.insert(evidenceMigrations).values({ id, depositionId: dep, kind: "quarantine", status: "applied", version: CORRECTION_VERSION, fromParser: d.parser, toParser: d.parser, beforeHash: before, afterHash: before, reason, finishedAt: new Date() });
    const q = [
      ...found.map((s) => ({ migrationId: id, kind: "verdict", rowId: s.verdict, reason: `${reason}; not replayable`, prior: {} })),
      ...found.filter((s) => s.finding !== null).map((s) => ({ migrationId: id, kind: "finding", rowId: s.finding!, reason, prior: { reviewState: s.review, reviewNote: s.note, reviewedAt: s.reviewedAt, parser: d.parser } })),
    ];
    for (let i = 0; i < q.length; i += 500) await tx.insert(evidenceQuarantine).values(q.slice(i, i + 500)).onConflictDoNothing();
    if ((await documentHash(tx, dep)) !== before) throw new Error("Quarantine changed evidence rows; nothing was changed.");
    return { migrationId: id, findings: found.filter((s) => s.finding !== null).length, reviewed: found.filter((s) => s.finding !== null && s.review !== "unreviewed").length, verdicts: found.length };
  });
}

// The standing of findings: current, or quarantined by an applied correction or quarantine, with the review
// they had then. A finding is shown as current only when no applied migration quarantines it.
export type Standing = { state: "current" } | { state: "quarantined"; reason: string; since: string; parser: string | null; priorReview: { state: string; note: string | null; reviewedAt: string | null } };
export async function standingOf(db: Database, findingIds: readonly number[]): Promise<Map<number, Standing>> {
  const out = new Map<number, Standing>(findingIds.map((id) => [id, { state: "current" }]));
  if (!findingIds.length) return out;
  const q = await db
    .selectDistinctOn([evidenceQuarantine.rowId], { id: evidenceQuarantine.rowId, reason: evidenceQuarantine.reason, since: evidenceQuarantine.createdAt, prior: evidenceQuarantine.prior })
    .from(evidenceQuarantine)
    .innerJoin(evidenceMigrations, eq(evidenceMigrations.id, evidenceQuarantine.migrationId))
    .where(and(eq(evidenceQuarantine.kind, "finding"), eq(evidenceMigrations.status, "applied"), inArray(evidenceQuarantine.rowId, [...findingIds])))
    .orderBy(evidenceQuarantine.rowId, evidenceQuarantine.createdAt);
  for (const r of q) {
    const p = r.prior as { reviewState?: string; reviewNote?: string | null; reviewedAt?: string | null; parser?: string };
    out.set(r.id, { state: "quarantined", reason: r.reason, since: r.since.toISOString(), parser: p.parser ?? null, priorReview: { state: p.reviewState ?? "unreviewed", note: p.reviewNote ?? null, reviewedAt: p.reviewedAt ?? null } });
  }
  return out;
}

// SQL: a verdict no applied migration quarantines (replay never copies one that does).
export const verdictNotQuarantined = (verdictId: SQL | unknown) => sql`not exists (select 1 from evidence_quarantine q join evidence_migrations m on m.id = q.migration_id where q.kind = 'verdict' and q.row_id = ${verdictId} and m.status = 'applied')`;
