// The safe evidence correction (server/src/evidence/correction.ts) on the test database. SYNTHETIC archive
// transcript (invented speakers and testimony) in the shape parser revision 9 stored: statement 22 holds an
// answer and the next question, so the current parser splits one exchange into two and renumbers every group
// after it. Also the quarantine as the findings API, the report and replay see it. No model call.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { and, eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { extractFacts } from "../../server/src/claims/facts";
import { syncUnits } from "../../server/src/claims/facts/store";
import { analysisFindings, analysisRoutes, analysisView, findingDetail } from "../../server/src/api/analyses";
import { reportData } from "../../server/src/api/report";
import type { Database } from "../../server/src/db/client";
import { analyses, candidates, cases, depositions, evidenceMigrations, exchangeLines, exchanges, factUnits, facts, findings, lines, orgs, screeningEntries, screeningRuns, verdicts, witnesses } from "../../server/src/db/schema";
import { applyCorrection, correctInPlace, documentHash, integrity, planCorrection, quarantineFindings, releaseHold, rollbackCorrection, standingOf, verdictNotQuarantined, type CorrectionOptions, type Step } from "../../server/src/evidence";
import { readDeposition, saveDeposition } from "../../server/src/ingest";
import { buildExchangeParts } from "../../server/src/ingest/exchanges";
import { speakerSegments } from "../../server/src/ingest/segments";
import { TEXT_ARCHIVE_V1 } from "../../server/src/ingest/text";
import { storeUpload } from "../../server/src/ingest/uploads";
import { candidateSetOf } from "../../server/src/jobs";
import { emptyTables, listen, openTestDatabase, TEST_DATABASE_URL } from "./database";

const run = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `${from + i} ${i % 2 ? "A" : "Q"}: synthetic statement ${from + i} about the harbour crane.`);
const TEXT = ["ARCHIVE-DERIVED TRANSCRIPT EXPORT (SYNTHETIC, SAFE CORRECTION)", ...run(1, 21), "22 A: Yes, it did. Q. And then?", "23 A: It stopped at the pier.", ...run(24, 40)].join("\n");
const SIDE = { status: "verified", reason: null, location: null, evidenceLineIds: [], matchScore: 1 };
const CHECKS = { source: { a: SIDE, b: SIDE }, attribution: { a: { level: "clear", qualifier: null, noRecall: false, approximation: false }, b: { level: "clear", qualifier: null, noRecall: false, approximation: false } }, reasons: [], notCorroborated: [] };
const ZERO = { factUnitsDangling: 0, factUnitsGroupMismatch: 0, factsDangling: 0, screeningDangling: 0, candidateGroupMismatch: 0 };

describe.skipIf(!TEST_DATABASE_URL)("safe evidence correction (Postgres, synthetic archive)", () => {
  let db: Database;
  let pool: Pool;
  let uploads: string;
  let backupDir: string;
  let caseId: number;
  let witnessId: number;
  let doc: number;
  let analysisId: number;
  const opts = (o: Partial<CorrectionOptions> = {}): CorrectionOptions => ({ uploadsDir: uploads, backupDir, ...o });

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
    uploads = mkdtempSync(path.join(tmpdir(), "correction-uploads-"));
    backupDir = mkdtempSync(path.join(tmpdir(), "correction-backups-"));
  });
  afterAll(async () => {
    await pool.end();
    rmSync(uploads, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await emptyTables(db);
    await db.execute(sql`truncate evidence_migrations, evidence_quarantine, fact_units, facts, screening_runs, screening_entries cascade`);
    const [org] = await db.insert(orgs).values({ name: "Synthetic" }).returning();
    [{ id: caseId }] = await db.insert(cases).values({ orgId: org.id, name: "Synthetic archive" }).returning();
    [{ id: witnessId }] = await db.insert(witnesses).values({ caseId, name: "Iris Calloway" }).returning();
    // What revision 9 stored: segments, but exchanges built line by line.
    const data = new TextEncoder().encode(TEXT);
    const { fileSha256, storageKey } = await storeUpload(data, uploads);
    const r = await readDeposition(data, undefined, undefined, "Iris Calloway");
    const plain = r.exchanges!.lines.map(({ segments: _s, index: _i, turn: _t, role: _r, speakerName: _n, ...l }) => l);
    const old = buildExchangeParts(plain, TEXT_ARCHIVE_V1, "calloway");
    for (const l of old.lines) { const segs = speakerSegments(l.rawText, "calloway"); if (segs.length) l.segments = segs; }
    const saved = await saveDeposition(db, { caseId, witnessId, takenOn: "2024-05-02", fileSha256, storageKey, read: { ...r, parserVersion: "pdfjs-ellison-doj-v1-r9", exchanges: old } });
    if (!("depositionId" in saved)) throw new Error("not saved");
    doc = saved.depositionId;
    await syncUnits(db, doc); // pending fact units, as Stage 2 keeps them (no model call)
    // A finished analysis the findings belong to (its second session is another synthetic file).
    const other = new TextEncoder().encode(["ARCHIVE-DERIVED TRANSCRIPT EXPORT (SYNTHETIC, OTHER SESSION)", ...run(1, 6)].join("\n"));
    const stored = await storeUpload(other, uploads);
    const second = await saveDeposition(db, { caseId, witnessId, takenOn: "2024-06-02", ...stored, read: await readDeposition(other, undefined, undefined, "Iris Calloway") });
    if (!("depositionId" in second)) throw new Error("not saved");
    [{ id: analysisId }] = await db.insert(analyses).values({ caseId, witnessId, depositionA: doc, depositionB: second.depositionId, mode: "demo", status: "completed", promptVersion: "adjudicate-v1", effort: "medium", maxCandidates: 10, budgetUsd: 1 }).returning();
  });

  const line = async (n: number) => (await db.select().from(lines).where(and(eq(lines.depositionId, doc), eq(lines.lineNo, n))))[0];
  const ref = async (n: number) => { const l = await line(n); return `${l.printedPage}:${l.lineNo}`; };
  const exchangeOf = async (n: number) => {
    const [m] = await db.select({ id: exchangeLines.exchangeId }).from(exchangeLines).where(eq(exchangeLines.lineId, (await line(n)).id));
    return (await db.select().from(exchanges).where(eq(exchanges.id, m.id)))[0];
  };
  const qa = async () => (await db.select().from(exchanges).where(and(eq(exchanges.depositionId, doc), eq(exchanges.kind, "qa")))).sort((a, b) => a.groupId - b.groupId);
  async function findingOn(x: typeof exchanges.$inferSelect, y: typeof exchanges.$inferSelect, reviewState = "unreviewed", packet: object = {}) {
    const [c] = await db.insert(candidates).values({ candidateSet: candidateSetOf(analysisId), witnessId, depositionA: doc, groupA: x.groupId, depositionB: doc, groupB: y.groupId, exchangeA: x.id, exchangeB: y.id, sources: ["direct"], rrfScore: 0, mergedRank: 1, evidence: [] }).returning();
    const [v] = await db.insert(verdicts).values({ candidateId: c.id, model: "fixture", promptVersion: "x", effort: "low", status: "valid", parsed: { explanation: "fixture", sameEvent: "yes" }, packet, origin: "fixture" }).returning();
    const [f] = await db.insert(findings).values({ caseId, candidateId: c.id, verdictId: v.id, type: "direct", evidenceStatus: "verified", attributionA: "clear", attributionB: "clear", score: 80, band: "high", factors: [], caps: [], checks: CHECKS, rubricVersion: "x", priority: "high", reviewState, reviewNote: reviewState === "unreviewed" ? null : "checked by hand", reviewedAt: reviewState === "unreviewed" ? null : new Date("2026-10-01T12:00:00Z") }).returning();
    return { finding: f, verdict: v, candidate: c };
  }
  // The packet record a verdict stores: both exchanges' line IDs.
  const packetFor = async (...xs: (typeof exchanges.$inferSelect)[]) => ({
    sides: await Promise.all(xs.map(async (x, i) => ({ id: `E${x.id}`, session: i ? "B" : "A", depositionId: doc, groupId: x.groupId, partIds: [x.id], wholeExchange: true, gapBefore: false, gapAfter: false, contextLineIds: [],
      lineIds: (await db.select({ id: exchangeLines.lineId }).from(exchangeLines).where(eq(exchangeLines.exchangeId, x.id))).map((r) => r.id) }))),
  });
  async function factOn(exchangeId: number, key: string) {
    const [u] = await db.select().from(factUnits).where(eq(factUnits.depositionId, doc)).limit(1);
    await db.insert(facts).values({ factKey: key, unitKey: u.unitKey, extractorVersion: u.extractorVersion, caseId, witnessId, depositionId: doc, exchangeId, sourceSpanIds: [], lineIds: [], factualDimension: "location", evidencePhrase: "the pier", attributionStatus: "verified", sourceVerification: "verified", status: "indexed", sourceHash: "x", raw: {} });
  }
  const dryThenApply = async (o: Partial<CorrectionOptions>) => {
    const dry = await planCorrection(db, doc, opts(o));
    expect(dry.outcome).toBe("dry_run");
    return { dry, applied: await applyCorrection(db, doc, opts({ ...o, planHash: dry.planHash })) };
  };
  const ledger = async () => (await db.select({ kind: evidenceMigrations.kind, status: evidenceMigrations.status }).from(evidenceMigrations).orderBy(evidenceMigrations.createdAt));
  const holdOf = async () => (await db.select({ hold: depositions.evidenceHold, epoch: depositions.evidenceEpoch }).from(depositions).where(eq(depositions.id, doc)))[0];

  it("correctInPlace alone leaves the defects the rehearsal saw, and integrity() catches each one", async () => {
    await factOn((await exchangeOf(23)).id, "on-the-split-exchange");
    expect(await integrity(db, doc)).toEqual(ZERO);
    await syncUnits(db, doc); // nothing to change before the correction
    const r = await correctInPlace(db, doc, { uploadsDir: uploads, backupDir, execute: true });
    expect(r.outcome).toBe("corrected");
    const after = await integrity(db, doc);
    expect(after.factUnitsDangling).toBeGreaterThan(0);
    expect(after.factUnitsGroupMismatch).toBeGreaterThan(0);
    expect(await db.$count(facts, eq(facts.depositionId, doc))).toBe(0); // the fact went with the cascade, uncounted
  });

  it("the dry run is the whole correction rolled back: nothing changes, and the plan says what would", async () => {
    await factOn((await exchangeOf(23)).id, "on-the-split-exchange");
    const before = await documentHash(db, doc);
    const dry = await planCorrection(db, doc, opts({ expect: { lines: [await ref(22)] } }));
    expect(await documentHash(db, doc)).toBe(before);
    expect(await ledger()).toEqual([]);
    expect(dry).toMatchObject({ outcome: "dry_run", plan: { changedLines: [], regroupedLines: 3, exchanges: { removed: [expect.any(String)], added: [expect.any(String), expect.any(String)] }, facts: { detachedFromReplacedExchanges: 1 } } });
    expect(dry.plan!.units.rekeyed).toBeGreaterThan(0);
  });

  it("applies the reviewed plan: no broken reference, groups reconciled, the fact kept as stale, the hold released and the epoch moved", async () => {
    const splitting = await exchangeOf(23);
    await factOn(splitting.id, "on-the-split-exchange");
    const far = (await qa()).at(-1)!;
    await factOn(far.id, "far-away");
    const { finding: kept } = await findingOn((await qa())[0], far, "dismissed");
    const { applied } = await dryThenApply({ expect: { lines: [await ref(22)] } });
    expect(applied.outcome).toBe("applied");
    expect(applied.integrityAfter).toEqual(ZERO);
    expect(await integrity(db, doc)).toEqual(ZERO);
    expect(await holdOf()).toEqual({ hold: null, epoch: 1 });
    expect(await ledger()).toEqual([{ kind: "correction", status: "applied" }]);
    expect(await db.select({ key: facts.factKey, status: facts.status, exchangeId: facts.exchangeId, warnings: facts.warnings }).from(facts).orderBy(facts.factKey)).toEqual([
      { key: "far-away", status: "indexed", exchangeId: far.id, warnings: [] },
      { key: "on-the-split-exchange", status: "stale", exchangeId: null, warnings: ["exchange_replaced_by_parser_correction"] },
    ]);
    expect((await standingOf(db, [kept.id])).get(kept.id)).toEqual({ state: "current" });
    const [c] = await db.select().from(candidates);
    expect(c.groupB).toBe((await db.select().from(exchanges).where(eq(exchanges.id, far.id)))[0].groupId);
  });

  it("rejects a difference nobody expected, and executing without an expectation or a plan hash", async () => {
    const before = await documentHash(db, doc);
    expect(await planCorrection(db, doc, opts({ expect: { lines: [await ref(30)] } }))).toMatchObject({ outcome: "unexpected_difference" });
    expect(await applyCorrection(db, doc, opts({ planHash: "x" }))).toMatchObject({ outcome: "no_expectation" });
    expect(await applyCorrection(db, doc, opts({ expect: { lines: [] } }))).toMatchObject({ outcome: "plan_changed" });
    expect(await documentHash(db, doc)).toBe(before);
    expect(await ledger()).toEqual([]);
  });

  it("a changed speaker role: findings quarantined with reviews kept, stale verdicts not replayable, candidates flagged, and the API shows it", async () => {
    // Revision 9 also stored statement 5's speaker as unknown; the correction gives it back to the attorney.
    await db.update(lines).set({ speakerRole: "unknown" }).where(eq(lines.id, (await line(5)).id));
    const all = await qa();
    const changed = await exchangeOf(5);
    const confirmed = await findingOn(changed, all[5], "confirmed", await packetFor(changed, all[5]));
    // A verdict on two untouched exchanges whose packet SHOWED statement 5 as context: stale too.
    const ctx = await findingOn(all[6], all[7], "unreviewed", { sides: [{ depositionId: doc, partIds: [all[6].id], lineIds: [], contextLineIds: [(await line(5)).id] }] });
    const untouched = await findingOn(all[7], all[8], "confirmed", await packetFor(all[7], all[8]));
    const { applied } = await dryThenApply({ expect: { lines: [await ref(5), await ref(22)] } });
    expect(applied.outcome).toBe("applied");
    const ids = (xs: number[]) => [...xs].sort((a, b) => a - b);
    expect(applied.plan!.quarantine).toEqual({ findings: ids([confirmed.finding.id, ctx.finding.id]), reviewedFindings: 1, verdicts: ids([confirmed.verdict.id, ctx.verdict.id]), candidates: [confirmed.candidate.id] });
    const standing = await standingOf(db, [confirmed.finding.id, untouched.finding.id]);
    expect(standing.get(confirmed.finding.id)).toMatchObject({ state: "quarantined", parser: "pdfjs-ellison-doj-v1-r9", priorReview: { state: "confirmed", note: "checked by hand" } });
    expect(standing.get(untouched.finding.id)).toEqual({ state: "current" });
    // The person's decision is unchanged on the row.
    expect((await db.select().from(findings).where(eq(findings.id, confirmed.finding.id)))[0]).toMatchObject({ reviewState: "confirmed", reviewNote: "checked by hand" });
    // Replay never copies a quarantined verdict.
    const replayable = (await db.select({ id: verdicts.id }).from(verdicts).where(verdictNotQuarantined(verdicts.id))).map((r) => r.id);
    expect(replayable).toEqual([untouched.verdict.id]);

    // The findings API: its own group, never counted as decided; detail and list carry the standing.
    const list = await analysisFindings(db, analysisId);
    expect(list.groups.find((g) => g.group === "quarantined")!.findings.map((f) => f.id).sort()).toEqual(ids([confirmed.finding.id, ctx.finding.id]));
    expect(list.groups.filter((g) => g.group !== "quarantined").flatMap((g) => g.findings.map((f) => f.id))).toEqual([untouched.finding.id]);
    const view = (await analysisView(db, analysisId))!;
    expect(view.findings).toMatchObject({ total: 3, decided: 1, groups: { quarantined: 2 } });
    expect(await findingDetail(db, confirmed.finding.id)).toMatchObject({ group: "quarantined", groupLabel: "Needs revalidation", standing: { state: "quarantined" }, reviewState: "confirmed" });
    // The report keeps only the current confirmed finding.
    const report = (await reportData(db, caseId, [analysisId], true))!;
    expect(report).toMatchObject({ kept: 1, entries: [{ id: untouched.finding.id }] });
    // An ordinary review of a quarantined finding is refused, changing nothing.
    const app = express().use(express.json()).use("/api", analysisRoutes({ db, pool, boss: undefined as never }));
    const server = await listen(app);
    try {
      const patch = (id: number) => fetch(`${server.url}/api/findings/${id}/review`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "dismissed" }) });
      const refused = await patch(confirmed.finding.id);
      expect(refused.status).toBe(409);
      expect((await refused.json()).standing).toMatchObject({ state: "quarantined" });
      expect((await db.select().from(findings).where(eq(findings.id, confirmed.finding.id)))[0].reviewState).toBe("confirmed");
      expect((await patch(untouched.finding.id)).status).toBe(200);
    } finally { await server.close(); }
  });

  it.each(["probe", "facts", "correct", "units", "quarantine", "verify"] as Step[])("a failure after %s leaves the exact state before, releases the hold, and a retry succeeds", async (step) => {
    await factOn((await exchangeOf(23)).id, "on-the-split-exchange");
    const before = await documentHash(db, doc);
    const o = { expect: { lines: [await ref(22)] } };
    const dry = await planCorrection(db, doc, opts(o));
    await expect(applyCorrection(db, doc, opts({ ...o, planHash: dry.planHash, failAfter: step }))).rejects.toThrow(`injected failure after ${step}`);
    expect(await documentHash(db, doc)).toBe(before);
    expect(await holdOf()).toEqual({ hold: null, epoch: 0 });
    expect(await ledger()).toEqual([{ kind: "correction", status: "abandoned" }]);
    expect(await applyCorrection(db, doc, opts({ ...o, planHash: dry.planHash }))).toMatchObject({ outcome: "applied" });
  });

  it("interrupted after the hold (the process died): the hold stays, writes fail safely, and an explicit release recovers", async () => {
    const o = { expect: { lines: [await ref(22)] } };
    const dry = await planCorrection(db, doc, opts(o));
    await expect(applyCorrection(db, doc, opts({ ...o, planHash: dry.planHash, failAfter: "hold" }))).rejects.toThrow("after hold");
    const { hold } = await holdOf();
    expect(hold).toMatch(/^correction-/);
    expect(await planCorrection(db, doc, opts(o))).toMatchObject({ outcome: "busy" });
    await expect(db.update(lines).set({ speakerName: "x" }).where(eq(lines.id, (await line(3)).id))).rejects.toMatchObject({ cause: { code: "VE001" } });
    expect(await releaseHold(db, hold!)).toEqual({ migrationId: hold, released: true });
    expect(await holdOf()).toEqual({ hold: null, epoch: 0 });
    await expect(releaseHold(db, hold!)).rejects.toThrow("nothing to release");
    expect(await applyCorrection(db, doc, opts({ ...o, planHash: dry.planHash }))).toMatchObject({ outcome: "applied" });
  });

  it("a duplicate attempt is refused, a changed plan is refused, and a fresh dry run afterwards finds nothing to do", async () => {
    const o = { expect: { lines: [await ref(22)] } };
    const old = await planCorrection(db, doc, opts(o));
    await factOn((await exchangeOf(23)).id, "late"); // the data changed between dry run and execute
    expect(await applyCorrection(db, doc, opts({ ...o, planHash: old.planHash }))).toMatchObject({ outcome: "plan_changed" });
    expect(await holdOf()).toEqual({ hold: null, epoch: 0 });
    const { dry, applied } = await dryThenApply(o);
    expect(applied.outcome).toBe("applied");
    expect(await applyCorrection(db, doc, opts({ ...o, planHash: dry.planHash }))).toMatchObject({ outcome: "already_applied", migrationId: applied.migrationId });
    const again = await planCorrection(db, doc, opts());
    expect(again).toMatchObject({ outcome: "dry_run", plan: { changedLines: [], regroupedLines: 0, exchanges: { removed: [], added: [] }, units: { rekeyed: 0, reset: 0 }, quarantine: { findings: [], verdicts: [], candidates: [] } } });
  });

  it("rollback restores the exact state before; a failure inside it changes nothing; it refuses once the document changed", async () => {
    await factOn((await exchangeOf(23)).id, "on-the-split-exchange");
    await db.update(lines).set({ speakerRole: "unknown" }).where(eq(lines.id, (await line(5)).id));
    const { finding } = await findingOn(await exchangeOf(5), (await qa())[5], "confirmed");
    const before = await documentHash(db, doc);
    const { applied } = await dryThenApply({ expect: { lines: [await ref(5), await ref(22)] } });
    const after = await documentHash(db, doc);
    expect(after).not.toBe(before);
    await expect(rollbackCorrection(db, applied.migrationId!, { failAfter: "restore" })).rejects.toThrow("after restore");
    expect(await documentHash(db, doc)).toBe(after);
    expect((await holdOf()).hold).toBeNull();
    await expect(rollbackCorrection(db, applied.migrationId!)).resolves.toMatchObject({ restored: true });
    expect(await documentHash(db, doc)).toBe(before);
    expect(await holdOf()).toEqual({ hold: null, epoch: 2 });
    expect((await standingOf(db, [finding.id])).get(finding.id)).toEqual({ state: "current" });
    expect(await ledger()).toEqual([{ kind: "correction", status: "rolled_back" }, { kind: "rollback", status: "abandoned" }, { kind: "rollback", status: "applied" }]);
    await expect(rollbackCorrection(db, applied.migrationId!)).rejects.toThrow("rolled_back");
    // Applied again, then changed by something else: rolling back would overwrite that, so it refuses.
    const second = await dryThenApply({ expect: { lines: [await ref(5), await ref(22)] } });
    await db.update(lines).set({ speakerName: "someone" }).where(eq(lines.id, (await line(30)).id));
    const changed = await documentHash(db, doc);
    await expect(rollbackCorrection(db, second.applied.migrationId!)).rejects.toThrow("changed after the correction");
    expect(await documentHash(db, doc)).toBe(changed);
    expect((await holdOf()).hold).toBeNull();
  });

  it("refuses before writing when references are already broken, or a screening entry names a replaced exchange", async () => {
    const before = await documentHash(db, doc);
    const [u] = await db.select().from(factUnits).where(eq(factUnits.depositionId, doc)).limit(1);
    await db.update(factUnits).set({ exchangeIds: [999_999] }).where(eq(factUnits.unitKey, u.unitKey));
    expect(await planCorrection(db, doc, opts())).toMatchObject({ outcome: "integrity_failed_before", integrityBefore: { factUnitsDangling: 1 } });
    await db.update(factUnits).set({ exchangeIds: u.exchangeIds, groupId: u.groupId + 1000 }).where(eq(factUnits.unitKey, u.unitKey));
    expect(await planCorrection(db, doc, opts())).toMatchObject({ outcome: "integrity_failed_before", integrityBefore: { factUnitsGroupMismatch: 1 } });
    await db.update(factUnits).set({ groupId: u.groupId }).where(eq(factUnits.unitKey, u.unitKey));
    expect(await documentHash(db, doc)).toBe(before);
    const [runRow] = await db.insert(screeningRuns).values({ corpus: "t", packetSetName: "t", packetSetSha256: "x", poolSha256: "x", itemsSha256: "x", strategy: "t", strategyVersion: "1", contract: "1", budget: 1, settings: {}, poolPairs: 1, uncovered: [], caseId }).returning();
    await db.insert(screeningEntries).values({ runId: runRow.id, packetId: "p1", rank: 1, screenStatus: "prioritized", reason: "t", priority: 1, signals: {}, sessions: [], witnesses: [], items: [], pairs: [], exchangeIds: [(await exchangeOf(23)).id], documentIds: [doc] });
    expect(await planCorrection(db, doc, opts({ expect: { lines: [await ref(22)] } }))).toMatchObject({ outcome: "blocked" });
  });

  // A defect appearing while the correction runs (a trigger standing in for a writer nobody accounted for) is
  // caught by the final verification, and nothing is written.
  const copyUnit = (ids: string, group: string) => `insert into fact_units (unit_key, extractor_version, case_id, witness_id, deposition_id, group_id, window_no, window_count, exchange_ids, source_hash, parser_version)
    select 'zz-defect', extractor_version, case_id, witness_id, deposition_id, ${group}, window_no, window_count, ${ids}, source_hash, parser_version from fact_units where unit_key = (select min(unit_key) from fact_units)`;
  it.each([
    ["a dangling exchange reference", "fact_units", copyUnit("array[999999]::bigint[]", "group_id"), "factUnitsDangling"],
    ["a misaligned group number", "fact_units", copyUnit("exchange_ids", "group_id + 1000"), "factUnitsGroupMismatch"],
    ["a deleted fact", "exchanges", "delete from facts", "factsDeleted"],
  ])("%s introduced during the correction fails verification and rolls everything back", async (_name, table, body, key) => {
    await factOn((await qa())[0].id, "kept");
    const before = await documentHash(db, doc);
    await db.execute(sql.raw(`create or replace function test_defect() returns trigger language plpgsql as $$ begin
      if current_setting('test.defect', true) is distinct from '1' then perform set_config('test.defect', '1', true); ${body}; end if; return null; end $$`));
    await db.execute(sql.raw(`create trigger test_defect after insert or update on ${table} for each statement execute function test_defect()`));
    try {
      const r = await planCorrection(db, doc, opts({ expect: { lines: [await ref(22)] } }));
      expect(r.outcome).toBe("verification_failed");
      expect(JSON.parse(r.detail!)).toHaveProperty(key);
    } finally { await db.execute(sql.raw(`drop trigger test_defect on ${table}`)); }
    expect(await documentHash(db, doc)).toBe(before);
  });

  it("passes correctInPlace's refusal through when a finding's exchange would change its lines", async () => {
    await findingOn((await qa())[0], await exchangeOf(23), "confirmed");
    const before = await documentHash(db, doc);
    expect(await planCorrection(db, doc, opts({ expect: { lines: [await ref(22)] } }))).toMatchObject({ outcome: "refused_by_correction", correction: { outcome: "needs_versioned_migration" } });
    expect(await documentHash(db, doc)).toBe(before);
  });

  it("a superseded parse: findings and verdicts quarantined, reviews kept, no evidence row changed; a listed subset only", async () => {
    const all = await qa();
    const a = await findingOn(all[0], all[1], "confirmed");
    const b = await findingOn(all[2], all[3]);
    const before = await documentHash(db, doc);
    expect(await quarantineFindings(db, doc, "superseded parse", [b.finding.id])).toMatchObject({ findings: 1, reviewed: 0, verdicts: 1 });
    expect((await standingOf(db, [a.finding.id])).get(a.finding.id)).toEqual({ state: "current" });
    expect(await quarantineFindings(db, doc, "superseded parse (legacy_parse)")).toMatchObject({ findings: 2, reviewed: 1, verdicts: 2 });
    expect(await documentHash(db, doc)).toBe(before);
    expect((await standingOf(db, [a.finding.id])).get(a.finding.id)).toMatchObject({ state: "quarantined", reason: "superseded parse (legacy_parse)", parser: "pdfjs-ellison-doj-v1-r9", priorReview: { state: "confirmed" } });
    expect((await db.select().from(depositions).where(eq(depositions.id, doc)))[0].parserVersion).toBe("pdfjs-ellison-doj-v1-r9");
  });

  // ---------- worker coordination around a correction ----------
  it("a writer already running delays the hold until it commits, and what it wrote shows up as a changed plan", async () => {
    const o = { expect: { lines: [await ref(22)] } };
    const dry = await planCorrection(db, doc, opts(o));
    const writer = await pool.connect();
    try {
      await writer.query("begin");
      const [u] = await db.select().from(factUnits).where(eq(factUnits.depositionId, doc)).limit(1);
      await writer.query("update fact_units set error = 'written by a worker' where unit_key = $1", [u.unitKey]); // takes its key-share lock
      let settled = false;
      const applying = applyCorrection(db, doc, opts({ ...o, planHash: dry.planHash })).finally(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 400));
      expect(settled).toBe(false); // the hold waits for the writer
      await writer.query("commit");
      expect(await applying).toMatchObject({ outcome: "plan_changed" });
    } finally { writer.release(); }
    expect((await holdOf()).hold).toBeNull();
  });

  it("a writer that starts while the correction runs waits for it, then is refused instead of writing stale data", async () => {
    const o = { expect: { lines: [await ref(22)] } };
    const dry = await planCorrection(db, doc, opts(o));
    const far = (await qa()).at(-1)!;
    let late: Promise<string> | null = null;
    const onStep = async (s: Step) => {
      if (s !== "units") return;
      // A separate connection, as another worker: its insert waits on the correction's lock on the deposition.
      late = pool.query("insert into facts (fact_key, unit_key, extractor_version, case_id, witness_id, deposition_id, exchange_id, source_span_ids, line_ids, attribution_status, source_verification, status, source_hash, raw) select 'late', unit_key, extractor_version, case_id, witness_id, deposition_id, $1, '{}', '{}', 'verified', 'verified', 'rejected', 'x', '{}' from fact_units where deposition_id = $2 limit 1", [far.id, doc])
        .then(() => "accepted", (e) => (e.code === "VE001" ? "VE001" : String(e)));
      await new Promise((r) => setTimeout(r, 200));
    };
    expect(await applyCorrection(db, doc, opts({ ...o, planHash: dry.planHash, onStep }))).toMatchObject({ outcome: "applied" });
    expect(await late).toBe("VE001");
    expect(await db.$count(facts, eq(facts.factKey, "late"))).toBe(0);
    expect(await integrity(db, doc)).toEqual(ZERO);
  });

  it("fact extraction refuses held evidence, and never saves a reading whose source changed while the model read it", async () => {
    const reply = { stopReason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } as never, text: "{}" }; // unusable: every unit "failed"
    const model = (during?: () => Promise<unknown>) => ({ model: "claude-haiku-5-5", async extract() { await during?.(); return reply; } });
    await db.update(depositions).set({ evidenceHold: "correction-test" }).where(eq(depositions.id, doc));
    await expect(extractFacts(db, doc, model(), { maxBatches: 1 })).rejects.toThrow("held by correction-test");
    await db.update(depositions).set({ evidenceHold: null }).where(eq(depositions.id, doc));
    // The source changes while the model reads (as a correction would): nothing from that reading is saved.
    const r = await extractFacts(db, doc, model(() => db.execute(sql`update fact_units set source_hash = 'changed' where deposition_id = ${doc}`)), { maxBatches: 1 });
    const attempts = async () => Number((await db.execute(sql`select coalesce(sum(attempts), 0)::int n from fact_units where deposition_id = ${doc}`)).rows[0].n);
    expect(r.sourceChangedUnits).toBeGreaterThan(0);
    expect(await attempts()).toBe(0); // no unit outcome was saved
    // Unchanged source: the same reading is saved.
    const again = await extractFacts(db, doc, model(), { maxBatches: 1 });
    expect(again.sourceChangedUnits).toBe(0);
    expect(await attempts()).toBeGreaterThan(0);
  });
});
