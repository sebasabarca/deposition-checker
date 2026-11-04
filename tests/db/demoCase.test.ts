// The hand-authored demo case (scripts/demo-case-seed.ts) through the real ingestion, verification and
// scoring, read back through the same API helpers the app calls.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analysisFindings, analysisView, caseDetail, findingDetail } from "../../server/src/api";
import type { Database } from "../../server/src/db/client";
import { depositions, orgs } from "../../server/src/db/schema";
import { readUpload } from "../../server/src/ingest/uploads";
import { DEMO_CASE_NAME, DEMO_WITNESSES } from "../../server/src/data/demoCase";
import { demoOriginal, seedDemoCase } from "../../scripts/demo-case-seed";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

const GROUP_OF_INTENT = { contradiction: "contradictions", potential_discrepancy: "contradictions", needs_context: "needs_context", compatible: "compatible" } as const;

describe.skipIf(!TEST_DATABASE_URL)("hand-authored demo case (Postgres)", () => {
  let db: Database;
  let pool: Pool;
  let orgId: number;
  let seeded: Awaited<ReturnType<typeof seedDemoCase>>;
  const uploads = mkdtempSync(path.join(tmpdir(), "demo-uploads-"));

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
    await emptyTables(db);
    [{ id: orgId }] = await db.insert(orgs).values({ name: "Demo reviewer" }).returning({ id: orgs.id });
    seeded = await seedDemoCase(db, orgId, uploads);
  });
  afterAll(async () => {
    rmSync(uploads, { recursive: true, force: true });
    await pool?.end();
  });

  it("stores two witnesses with two ready sessions each, and one completed demo analysis per witness", async () => {
    expect(seeded).toMatchObject({ created: true, findings: 8 });
    const detail = await caseDetail(db, seeded.caseId);
    expect(detail!.case.name).toBe(DEMO_CASE_NAME);
    expect(detail!.witnesses.map((w) => [w.name, w.depositions.length])).toEqual(DEMO_WITNESSES.map((w) => [w.name, 2]));
    expect(detail!.depositions.every((d) => d.status === "ready")).toBe(true);
    for (const id of seeded.analyses) {
      const a = await analysisView(db, id);
      expect(a).toMatchObject({ mode: "demo", status: "completed", kind: "same_witness" });
      expect(a!.cost.calls).toBe(0);
    }
  });

  it("verifies every citation against the stored lines and files each example where it was written to go", async () => {
    const expected = new Map(DEMO_WITNESSES.flatMap((w) => w.findings.map((f) => [f.verdict.explanation, GROUP_OF_INTENT[f.intent]] as const)));
    let checked = 0;
    for (const id of seeded.analyses) {
      const { groups } = await analysisFindings(db, id);
      for (const g of groups) for (const f of g.findings) {
        expect(f.evidenceStatus, f.explanation).toBe("verified");
        expect(f.source).toBe("fixture");
        expect(g.group, f.explanation).toBe(expected.get(f.explanation));
        checked++;
      }
    }
    expect(checked).toBe(8);
  });

  it("shows each finding's two passages from the stored lines, with the cited lines highlighted and labelled as a prepared example", async () => {
    const { groups } = await analysisFindings(db, seeded.analyses[0]);
    const first = groups.flatMap((g) => g.findings)[0];
    const f = (await findingDetail(db, first.id))!;
    expect(f.source.kind).toBe("fixture");
    expect(f.source.label).toMatch(/prepared example .* Not produced by a model/);
    for (const side of [f.a, f.b]) {
      expect(side.verification.status).toBe("verified");
      expect(side.lines.some((l) => l.highlighted)).toBe(true);
      expect(side.range).toMatch(/^\d+:\d+/);
      expect(side.deposition.witness).toBe(DEMO_WITNESSES[0].name);
    }
  });

  it("keeps each session's original text, which opens with a line saying it is invented demo testimony", async () => {
    const rows = await db.select().from(depositions);
    expect(rows).toHaveLength(4);
    for (const d of rows) {
      expect(d.sourceFormat).toBe("text");
      expect(d.originalFilename).toMatch(/-demo\.txt$/);
      const text = new TextDecoder().decode(await readUpload(d.storageKey, uploads));
      expect(text.split("\n")[0]).toMatch(/^Hand-authored demonstration transcript: .* Invented testimony/);
      const w = DEMO_WITNESSES.find((x) => x.sessions.some((s) => s.takenOn === d.takenOn))!;
      const s = w.sessions.find((x) => x.takenOn === d.takenOn)!;
      expect(text).toBe(demoOriginal(w.name, s.takenOn, s.text));
    }
  });

  it("is idempotent: a second run finds the case and adds nothing", async () => {
    const again = await seedDemoCase(db, orgId, uploads);
    expect(again).toEqual({ ...seeded, created: false });
  });
});
