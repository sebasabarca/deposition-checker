// The hand-authored whole-case analysis resolved against the stored demo case (api/caseAnalysis.ts).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { caseAnalysisReport, caseAnalysisView, questionAndAnswer } from "../../server/src/api/caseAnalysis";
import { renderReport } from "../../server/src/api/report";
import type { Database } from "../../server/src/db/client";
import { cases, orgs } from "../../server/src/db/schema";
import { DEMO_CASE_ANALYSIS } from "../../server/src/data/demoCaseAnalysis";
import { seedDemoCase } from "../../scripts/demo-case-seed";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

describe("questionAndAnswer", () => {
  const file = ["header", "", "Q: Where were you?", "A: In the  lot.", "", "Q: Next?"];
  it("reads a cited question and answer, normalizing spaces", () => expect(questionAndAnswer(file, 3, 4)).toEqual({ question: "Where were you?", answer: "In the lot." }));
  it("names the problem when the lines are not one exchange or not in the file", () => {
    expect(questionAndAnswer(file, 1, 2)).toEqual({ error: "lines 1–2 are not one question and its answer" });
    expect(questionAndAnswer(file, 6, 9)).toMatchObject({ error: expect.stringMatching(/not in the file/) });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("whole-case analysis of the demo case (Postgres)", () => {
  let db: Database;
  let pool: Pool;
  let caseId: number;
  let orgId: number;
  const uploads = mkdtempSync(path.join(tmpdir(), "case-analysis-"));

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
    await emptyTables(db);
    [{ id: orgId }] = await db.insert(orgs).values({ name: "Demo" }).returning({ id: orgs.id });
    caseId = (await seedDemoCase(db, orgId, uploads)).caseId;
  });
  afterAll(async () => {
    rmSync(uploads, { recursive: true, force: true });
    await pool?.end();
  });

  it("resolves every citation of all 15 findings to stored lines, across both witnesses", async () => {
    const v = (await caseAnalysisView(db, caseId, uploads))!;
    expect(v.findings).toHaveLength(15);
    expect(v.unverified).toBe(0);
    expect(v.sessions.every((s) => s.depositionId !== null)).toBe(true);
    expect(v.pairs.map((p) => p.relationship).sort()).toEqual(["cross_witness", "cross_witness", "cross_witness", "cross_witness", "within_witness", "within_witness"]);
    for (const f of v.findings) for (const c of f.citations) {
      expect(c.status, `${f.id} ${c.sessionId}: ${c.reason}`).toBe("verified");
      expect(c.range).toMatch(/^\d+:\d{2}–\d+:\d{2}$/);
      expect(c.lines.some((l) => l.highlighted)).toBe(true);
    }
  });

  it("shows the stored lines of the cited exchange, the witness's own answer highlighted", async () => {
    const v = (await caseAnalysisView(db, caseId, uploads))!;
    const valve = v.findings.find((f) => f.id === "F-005")!;
    const [aug, march] = valve.citations;
    expect([aug.witness, aug.date, march.date]).toEqual(["Elena Marsh", "2024-08-20", "2024-03-11"]);
    expect(march.lines.filter((l) => l.highlighted).map((l) => l.text).join(" ")).toMatch(/never went into the valve room/);
    expect(aug.lines.filter((l) => l.highlighted).map((l) => l.text).join(" ")).toMatch(/checked the valve room around eleven/);
    const cross = v.findings.find((f) => f.id === "F-010")!;
    expect(cross.citations.map((c) => c.witness)).toEqual(["Owen Calder", "Elena Marsh"]);
  });

  it("keeps the provenance: hand-authored, no model, nothing run or paid", async () => {
    const v = (await caseAnalysisView(db, caseId, uploads))!;
    expect(v.provenance).toMatchObject({ origin: "hand_authored_demo", live_model_execution: false, model: null });
    expect(v.execution).toEqual({ status: "not_run", paid_calls: 0, cost_usd: 0, claims_live_analysis: false });
  });

  it("returns a citation that doesn't match the stored transcript as unverified, with its reason", async () => {
    const broken = structuredClone(DEMO_CASE_ANALYSIS);
    broken.findings[0].source_citations[0] = { ...broken.findings[0].source_citations[0], line_start: 1, line_end: 2 };
    const v = (await caseAnalysisView(db, caseId, uploads, broken))!;
    expect(v.unverified).toBe(1);
    expect(v.findings[0].citations[0]).toMatchObject({ status: "unverified", reason: "lines 1–2 are not one question and its answer", lines: [] });
  });

  it("builds the report from the kept findings only, labelled as hand-written, with the reviewer's note", async () => {
    const r = (await caseAnalysisReport(db, caseId, [
      { id: "F-005", decision: "confirmed", note: "Ask about the valve room.", at: "2026-11-04T10:00:00Z" },
      { id: "F-008", decision: "needs_context", note: "", at: "2026-11-04T10:01:00Z" },
      { id: "F-999", decision: "confirmed", note: "unknown id, ignored", at: "2026-11-04T10:02:00Z" },
    ], uploads))!;
    expect(r).toMatchObject({ kept: 1, context: 1, authorship: "hand", gaps: [] });
    expect(r.covered).toHaveLength(6);
    const e = r.entries[0] as unknown as { reviewNote: string; a: { deposition: { takenOn: string }; lines: { highlighted: boolean; text: string }[] }; b: { deposition: { takenOn: string } } };
    expect(e.reviewNote).toBe("Ask about the valve room.");
    expect([e.a.deposition.takenOn, e.b.deposition.takenOn]).toEqual(["2024-03-11", "2024-08-20"]);
    expect(e.a.lines.filter((l) => l.highlighted).map((l) => l.text).join(" ")).toMatch(/never went into the valve room/);
    const chunks: Buffer[] = [];
    await new Promise<void>((done) => { const doc = renderReport(r); doc.on("data", (c: Buffer) => chunks.push(c)); doc.on("end", () => done()); });
    expect(Buffer.concat(chunks).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("gives no analysis for another case", async () => {
    const [other] = await db.insert(cases).values({ orgId, name: "Another case" }).returning({ id: cases.id });
    expect(await caseAnalysisView(db, other.id, uploads)).toBeNull();
  });
});
