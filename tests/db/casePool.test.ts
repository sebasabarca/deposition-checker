// buildCasePool over a stored two-witness, four-session synthetic case (Webb and Whitfield under one case).
// See tests/db/database.ts for when these run.

import { eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../server/src/db/client";
import { depositions, exchangeLines } from "../../server/src/db/schema";
import { WEBB_SUITE, WHITFIELD_SUITE } from "../../server/src/eval/synthetic";
import { storeSessions } from "../../server/src/eval/syntheticStore";
import { pairKey } from "../../server/src/retrieve/frozen";
import { buildCasePool, type CasePoolResult } from "../../server/src/retrieve/casePool";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

describe.skipIf(!TEST_DATABASE_URL)("buildCasePool", () => {
  let db: Database;
  let pool: Pool;
  let caseId: number;
  let first: CasePoolResult;

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
    await emptyTables(db);
    await storeSessions(db, WEBB_SUITE);
    await storeSessions(db, { ...WHITFIELD_SUITE, caseName: WEBB_SUITE.caseName });
    [{ caseId }] = await db.select({ caseId: depositions.caseId }).from(depositions).limit(1);
    first = await buildCasePool(db, pool, caseId);
  }, 120_000);
  afterAll(async () => { await pool?.end(); });

  it("pools four sessions of two witnesses, only across sessions, with cross-witness pairs", () => {
    const r = first;
    expect(r.documents).toHaveLength(4);
    expect(r.documents.every((d) => d.included)).toBe(true);
    expect(new Set(r.items.map((i) => i.witnessId)).size).toBe(2);
    expect(r.items.every((i) => i.exchangeIds.length > 0)).toBe(true);
    const byKey = new Map(r.items.map((i) => [i.key, i]));
    expect(r.pool.candidates.length).toBeGreaterThan(0);
    for (const c of r.pool.candidates) expect(byKey.get(c.a)!.sessionId).not.toBe(byKey.get(c.b)!.sessionId);
    expect(r.pool.candidates.some((c) => byKey.get(c.a)!.witnessId !== byKey.get(c.b)!.witnessId)).toBe(true);
    expect(r.pool.candidates.some((c) => byKey.get(c.a)!.witnessId === byKey.get(c.b)!.witnessId)).toBe(true);
    expect(r.paths.find((p) => p.name === "E_minilm_qac_s")).toBeDefined();
  });

  it("accounts for every candidate exactly once: kept (in one packet or uncovered) or deferred", () => {
    const r = first;
    const kept = r.triage.kept.map((c) => pairKey(c.a, c.b));
    const deferred = r.triage.deferred.map((c) => pairKey(c.a, c.b));
    const all = [...kept, ...deferred];
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(all)).toEqual(new Set(r.pool.candidates.map((c) => pairKey(c.a, c.b))));
    const placed = [...r.packets.packets.flatMap((p) => p.pairs.map(([a, b]) => pairKey(a, b))), ...r.packets.uncovered.map((u) => pairKey(u.a, u.b))];
    expect(placed.length).toBe(new Set(placed).size);
    expect(new Set(placed)).toEqual(new Set(kept));
  });

  it("is deterministic", async () => {
    expect(await buildCasePool(db, pool, caseId)).toEqual(first);
  }, 60_000);

  it("leaves an excluded document out but lists it", async () => {
    const gone = first.documents[3].depositionId;
    await db.update(depositions).set({ excludedReason: "legacy_parse" }).where(eq(depositions.id, gone));
    try {
      const r = await buildCasePool(db, pool, caseId);
      expect(r.documents.find((d) => d.depositionId === gone)).toMatchObject({ included: false, reason: "excluded: legacy_parse" });
      expect(r.items.some((i) => i.depositionId === gone)).toBe(false);
      expect(r.excluded.some((i) => i.depositionId === gone)).toBe(false);
      expect(r.pool.candidates.some((c) => c.a.startsWith(`d${gone}#`) || c.b.startsWith(`d${gone}#`))).toBe(false);
    } finally {
      await db.update(depositions).set({ excludedReason: null }).where(eq(depositions.id, gone));
    }
  }, 60_000);

  it("changes its sourceHash when a stored line's text changes", async () => {
    const [line] = await db.select({ id: exchangeLines.lineId }).from(exchangeLines).where(eq(exchangeLines.exchangeId, first.items[0].exchangeIds[0])).limit(1);
    await db.execute(sql`update lines set raw_text = raw_text || ' edited' where id = ${line.id}`);
    try {
      expect((await buildCasePool(db, pool, caseId)).sourceHash).not.toBe(first.sourceHash);
    } finally {
      await db.execute(sql`update lines set raw_text = left(raw_text, length(raw_text) - 7) where id = ${line.id}`);
    }
    expect((await buildCasePool(db, pool, caseId)).sourceHash).toBe(first.sourceHash);
  }, 60_000);
});
