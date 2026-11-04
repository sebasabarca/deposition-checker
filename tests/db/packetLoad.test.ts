import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolvePassages } from "../../server/src/adjudicate/packetLoad";
import type { FrozenItem } from "../../server/src/retrieve/frozen";
import { candidates, exchangeLines, exchanges, lines } from "../../server/src/db/schema";
import { storeSynthetic } from "../../server/src/eval/syntheticStore";
import type { Database } from "../../server/src/db/client";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";
import type { Pool } from "pg";

describe.skipIf(!TEST_DATABASE_URL)("packet loader (Postgres)", () => {
  let db: Database;
  let pool: Pool;
  let item: FrozenItem;
  let depositionId: number;

  beforeAll(async () => ({ db, pool } = await openTestDatabase()));
  afterAll(async () => pool?.end());
  beforeEach(async () => {
    await emptyTables(db);
    const ids = await storeSynthetic(db);
    const candidateId = ids.get("webb-cho")!;
    const [candidate] = await db.select().from(candidates).where(eq(candidates.id, candidateId));
    depositionId = candidate.depositionA;
    const parts = await db.select({ id: exchanges.id }).from(exchanges).where(and(eq(exchanges.depositionId, depositionId), eq(exchanges.groupId, candidate.groupA)));
    const stored = await db.select({ page: lines.printedPage, line: lines.lineNo }).from(exchangeLines).innerJoin(lines, eq(lines.id, exchangeLines.lineId)).where(eq(exchangeLines.exchangeId, parts[0].id)).orderBy(asc(lines.printedPage), asc(lines.lineNo));
    item = { key: "doc#1", document: "doc", witness: "Marcus Webb", session: "synthetic", groupId: candidate.groupA, positions: stored.map((x) => `${x.page}:${x.line}`), sourceHash: "", question: "", answer: "", context: "" };
  });

  it("uses stored raw text and reports every bad item", async () => {
    const loaded = await resolvePassages(db, [item, { ...item, key: "missing", document: "nope" }, { ...item, key: "position", positions: [...item.positions, "999:99"] }, { ...item, key: "witness", witness: "Someone Else" }], new Map([["doc", depositionId]]));
    const passage = loaded.passages.get(item.key)!;
    // Checked against the stored rows directly, not through loadSide, which the loader itself uses.
    const raw = await db.select({ id: lines.id, text: lines.rawText }).from(lines).where(inArray(lines.id, passage.lines.map((l) => l.id)));
    const byId = new Map(raw.map((r) => [r.id, r.text]));
    expect(passage.lines.length).toBeGreaterThan(0);
    expect(passage.lines.map((l) => l.text)).toEqual(passage.lines.map((l) => byId.get(l.id)));
    const shown = new Set(passage.lines.map((l) => `${l.page}:${l.line}`));
    expect(item.positions.every((p) => shown.has(p))).toBe(true);
    expect(loaded.unresolved).toEqual(expect.arrayContaining([
      { key: "missing", reason: "document not loaded" },
      { key: "position", reason: "1 position not found" },
      { key: "witness", reason: 'witness mismatch: item "Someone Else", stored "Marcus Webb"' },
    ]));
    expect(loaded.passages.size + loaded.unresolved.length).toBe(4);
  });
});
