// Excluded copies (legacy parses and duplicates), on SYNTHETIC archive transcripts (invented speakers and
// testimony): they keep every row, but the evidence index, new analyses and retrieval leave them out, and
// the same file stored twice in a case is never counted as two depositions.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { analysisRoutes, depositionRoutes } from "../../server/src/api";
import { deleteCase, deleteDeposition } from "../../server/src/api/remove";
import type { Database } from "../../server/src/db/client";
import { cases, depositionSessions, depositions, exchanges, orgs, witnesses } from "../../server/src/db/schema";
import { evidenceCoverage, excludeDocument, getEvidence, parserAudit, searchEvidence } from "../../server/src/evidence";
import { readDeposition, saveDeposition } from "../../server/src/ingest";
import { storeUpload } from "../../server/src/ingest/uploads";
import { emptyTables, listen, openTestDatabase, TEST_DATABASE_URL } from "./database";

const statements = (topic: string) => ["ARCHIVE-DERIVED TRANSCRIPT EXPORT (SYNTHETIC)", ...Array.from({ length: 30 }, (_, i) => `${i + 1} ${i % 2 ? "A" : "Q"}: synthetic statement ${i + 1} about the ${topic}.`)].join("\n");

describe.skipIf(!TEST_DATABASE_URL)("excluded copies (Postgres, synthetic archives)", () => {
  let db: Database;
  let pool: Pool;
  let uploads: string;
  let api: { url: string; close: () => Promise<void> };
  let caseId: number;
  let active: number;
  let copy: number;
  let legacy: number;

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
    uploads = mkdtempSync(path.join(tmpdir(), "exclusion-"));
    const app = express();
    app.use(express.json());
    app.use("/api", analysisRoutes({ db, pool, boss: {} as PgBoss })); // refused before any job is queued
    app.use("/api", depositionRoutes({ db, pool, boss: {} as PgBoss })); // only the date edit is used
    api = await listen(app);
  });
  afterAll(async () => {
    await api.close();
    await pool.end();
    rmSync(uploads, { recursive: true, force: true });
  });

  async function store(text: string, witnessId: number, parserVersion?: string) {
    const data = new TextEncoder().encode(text);
    const { fileSha256, storageKey } = await storeUpload(data, uploads);
    const read = await readDeposition(data, undefined, undefined, "Iris Calloway");
    const saved = await saveDeposition(db, { caseId, witnessId, takenOn: "2024-05-01", fileSha256, storageKey, read: parserVersion ? { ...read, parserVersion } : read });
    if (!("depositionId" in saved)) throw new Error("not saved");
    return saved.depositionId;
  }

  beforeEach(async () => {
    await emptyTables(db);
    const [org] = await db.insert(orgs).values({ name: "Synthetic" }).returning();
    [{ id: caseId }] = await db.insert(cases).values({ orgId: org.id, name: "Synthetic copies" }).returning();
    const [{ id: witnessId }] = await db.insert(witnesses).values({ caseId, name: "Iris Calloway" }).returning();
    active = await store(statements("harbour crane"), witnessId);
    copy = await store(statements("harbour crane"), witnessId, "pdfjs-ellison-doj-v1-r9"); // the same file, stored again by an older parser
    legacy = await store(statements("night ledger"), witnessId, "pdfjs-ellison-doj-v1-r1");
  });

  it("reports the same file stored twice until one copy is marked a duplicate", async () => {
    expect((await evidenceCoverage(db, caseId)).unmarkedDuplicates).toEqual([[active, copy]]);
    await excludeDocument(db, copy, { reason: "duplicate", duplicateOf: active });
    await excludeDocument(db, legacy, { reason: "legacy_parse" });
    const c = await evidenceCoverage(db, caseId);
    expect(c.unmarkedDuplicates).toEqual([]);
    expect(c.documents.map((d) => d.documentId)).toEqual([active]);
    expect(c.totals.documents).toBe(1);
    expect(c.excluded).toEqual([{ documentId: copy, witness: "Iris Calloway", reason: "duplicate", duplicateOf: active }, { documentId: legacy, witness: "Iris Calloway", reason: "legacy_parse", duplicateOf: null }]);
    expect((await parserAudit(db, { caseId })).map((d) => d.action.split(":")[0])).toEqual(["current", "excluded", "excluded"]);
  });

  it("excludes a misfiled document, keeping its rows and leaving it out of search and coverage", async () => {
    await excludeDocument(db, legacy, { reason: "misfiled" });
    const c = await evidenceCoverage(db, caseId);
    expect(c.excluded).toEqual([{ documentId: legacy, witness: "Iris Calloway", reason: "misfiled", duplicateOf: null }]);
    expect(await searchEvidence(db, "ledger", { caseId })).toMatchObject({ matched: 0 });
    expect(await db.$count(exchanges, eq(exchanges.depositionId, legacy))).toBeGreaterThan(0);
    expect((await parserAudit(db, { caseId })).find((d) => d.documentId === legacy)?.action).toMatch(/^excluded: misfiled/);
  });

  it("refuses a duplicate that isn't the same file in the case, or that points at an excluded copy", async () => {
    await expect(excludeDocument(db, copy, { reason: "duplicate", duplicateOf: legacy })).rejects.toThrow(/isn't the same file/);
    await excludeDocument(db, active, { reason: "duplicate", duplicateOf: copy });
    await expect(excludeDocument(db, copy, { reason: "duplicate", duplicateOf: active })).rejects.toThrow(/already excluded|itself excluded/);
  });

  it("finds each passage once, in the copy that counts, and keeps the excluded copies' rows", async () => {
    await excludeDocument(db, copy, { reason: "duplicate", duplicateOf: active });
    await excludeDocument(db, legacy, { reason: "legacy_parse" });
    const found = await searchEvidence(db, "crane", { caseId });
    expect(new Set(found.results.map((r) => r.exchange.documentId))).toEqual(new Set([active]));
    expect(await searchEvidence(db, "ledger", { caseId })).toMatchObject({ matched: 0 });
    // The two copies share evidence keys; only the active copy answers, never an "ambiguous" error.
    const key = found.results[0].exchange.id!;
    expect((await getEvidence(db, key, caseId))!.documentId).toBe(active);
    expect(await db.$count(exchanges, eq(exchanges.depositionId, copy))).toBeGreaterThan(0);
    expect(await db.$count(exchanges, eq(exchanges.depositionId, legacy))).toBeGreaterThan(0);
  });

  it("refuses to start or estimate a new analysis on an excluded copy", async () => {
    await excludeDocument(db, legacy, { reason: "legacy_parse" });
    const start = await fetch(`${api.url}/api/cases/${caseId}/analyses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ depositionA: active, depositionB: legacy }) });
    expect(start.status).toBe(409);
    expect(await start.json()).toMatchObject({ code: "deposition_excluded", error: expect.stringContaining(`Deposition ${legacy}`) });
    const estimate = await fetch(`${api.url}/api/cases/${caseId}/estimate?a=${active}&b=${legacy}`);
    expect(estimate.status).toBe(409);
  });

  it("records a saved date as confirmed on a read file, and forgets it when the date is cleared", async () => {
    const patch = async (takenOn: string | null) => (await (await fetch(`${api.url}/api/depositions/${active}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ takenOn }) })).json()).deposition;
    expect(await patch("2024-05-02")).toMatchObject({ takenOn: "2024-05-02", dateConfirmed: "2024-05-02" });
    expect(await patch(null)).toMatchObject({ takenOn: null, dateConfirmed: null });
  });

  it("deletes a case whose files were re-read, though a re-read leaves an empty session behind", async () => {
    const [{ witnessId }] = await db.select({ witnessId: depositions.witnessId }).from(depositions).where(eq(depositions.id, active));
    await store(statements("harbour crane"), witnessId); // the same file read again: an insert that becomes an update
    const sessions = await db.select({ id: depositionSessions.id }).from(depositionSessions).where(eq(depositionSessions.caseId, caseId));
    const used = new Set((await db.select({ s: depositions.sessionId }).from(depositions).where(eq(depositions.caseId, caseId))).map((d) => d.s));
    expect(sessions.some((x) => !used.has(x.id))).toBe(true); // the leftover the delete used to trip on
    expect(await deleteCase(db, pool, caseId, uploads)).toMatchObject({ outcome: "deleted", depositions: 3 });
    expect(await db.$count(cases, eq(cases.id, caseId))).toBe(0);
    expect(await db.$count(depositionSessions, eq(depositionSessions.caseId, caseId))).toBe(0);
    expect(await db.$count(witnesses, eq(witnesses.caseId, caseId))).toBe(0);
  });

  it("makes the duplicate the copy that counts when the active copy is deleted", async () => {
    await excludeDocument(db, copy, { reason: "duplicate", duplicateOf: active });
    expect(await deleteDeposition(db, pool, active, uploads)).toMatchObject({ outcome: "deleted" });
    expect((await db.select().from(depositions).where(eq(depositions.id, copy)))[0]).toMatchObject({ excludedReason: null, duplicateOf: null });
  });
});
