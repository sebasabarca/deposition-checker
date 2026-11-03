// Stage 2 extraction against Postgres, on a SYNTHETIC archive transcript (invented speakers and
// testimony), with a rule-based fake model that reads only what a model is sent. These tests prove the
// pipeline: coverage, persistence, idempotency, retries, staleness and exclusion. They say nothing about
// how well a real model extracts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deleteDeposition } from "../../server/src/api/remove";
import { extractFacts, factCoverage, planFacts, syncUnits, verifiedFacts } from "../../server/src/claims/facts";
import type { ClaimModel } from "../../server/src/claims";
import type { Database } from "../../server/src/db/client";
import { cases, depositions, factUnits, facts, lines, llmCalls, orgs, witnesses } from "../../server/src/db/schema";
import { excludeDocument } from "../../server/src/evidence";
import { readDeposition, saveDeposition } from "../../server/src/ingest";
import { storeUpload } from "../../server/src/ingest/uploads";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

const ARCHIVE = [
  "ARCHIVE-DERIVED TRANSCRIPT EXPORT (SYNTHETIC)",
  "1 Q: Where were you on the night of the storm?",
  "2 A: At the harbour office with the night clerk. Q. Did the crane move?",
  "3 A: No.",
  "4 Q: Do you see that?",
  "5 NORA QUILL: Objection, form.",
  ...Array.from({ length: 30 }, (_, i) => `${i + 6} ${i % 2 ? "A" : "Q"}: synthetic statement ${i + 6} about the ledger.`),
].join("\n");

// One fact per unit from its first witness span, cited with the question line before it as the prompt
// asks, in the group under the unit's key with its opening words; a unit without one gets an empty group.
function ruleModel(opts: { sent?: string[]; fail?: boolean; stopReason?: (text: string) => string } = {}): ClaimModel {
  return {
    model: "claude-haiku-5-5",
    async extract(text) {
      opts.sent?.push(text);
      if (opts.fail) throw new Error("synthetic outage");
      const groups = text.split(/\n\n(?=\[U\d+\])/).map((block) => {
        const unit = Number(block.match(/^\[U(\d+)\]/)![1]);
        const opening = block.split("\n").find((l) => l.startsWith("S1 "))!.replace(/^S1 [^:]+: /, "").split(" ").slice(0, 5).join(" ");
        const answer = block.split("\n").map((l) => l.match(/^S(\d+) A: (.*)$/)).find(Boolean);
        if (!answer) return [`u${unit}`, { opening, facts: [], noFactsReason: "no_answer" }];
        const phrase = answer[2].replace(/^A[:.]\s*/, "").split(" ").slice(0, 5).join(" ").replace(/[.?]$/, "");
        return [`u${unit}`, { opening, noFactsReason: null, facts: [{ kind: "action", spans: Number(answer[1]) > 1 ? [Number(answer[1]) - 1, Number(answer[1])] : [Number(answer[1])], contextSpans: [], evidencePhrase: phrase, subject: "the witness", entities: [], predicate: "said", attribute: null, value: null, valuePhrase: null, factualQuestion: "What did the witness say?", polarity: "positive", epistemicStatus: "asserted", reportedSpeaker: null, hedges: [], correction: false, timeScope: null, locationScope: null, event: { description: null, eventType: null, anchors: [], participants: [], date: null, location: null } }] }];
      });
      return { stopReason: opts.stopReason?.(text) ?? "end_turn", usage: { input_tokens: 100, output_tokens: 50 } as never, text: JSON.stringify(Object.fromEntries(groups)) };
    },
  };
}

describe.skipIf(!TEST_DATABASE_URL)("fact extraction (Postgres, synthetic archive)", () => {
  let db: Database;
  let pool: Pool;
  let uploads: string;
  let caseId: number;
  let doc: number;

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
    uploads = mkdtempSync(path.join(tmpdir(), "facts-"));
  });
  afterAll(async () => {
    await pool.end();
    rmSync(uploads, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await emptyTables(db);
    const [org] = await db.insert(orgs).values({ name: "Synthetic" }).returning();
    [{ id: caseId }] = await db.insert(cases).values({ orgId: org.id, name: "Synthetic facts" }).returning();
    const [{ id: witnessId }] = await db.insert(witnesses).values({ caseId, name: "Iris Calloway" }).returning();
    const data = new TextEncoder().encode(ARCHIVE);
    const { fileSha256, storageKey } = await storeUpload(data, uploads);
    const saved = await saveDeposition(db, { caseId, witnessId, takenOn: "2024-05-01", fileSha256, storageKey, read: await readDeposition(data, undefined, undefined, "Iris Calloway") });
    if (!("depositionId" in saved)) throw new Error("not saved");
    doc = saved.depositionId;
  });
  const units = () => db.select().from(factUnits).where(eq(factUnits.depositionId, doc));

  it("plans without writing, then records every answer group before any call, those with no testimony as such", async () => {
    const plan = await planFacts(db, doc);
    expect(plan.units).toBeGreaterThan(10);
    expect(plan.due).toBe(plan.units - 1);
    expect(plan.estimate).toMatchObject({ model: "claude-haiku-5-5", batches: Math.ceil(plan.due / 8) }); // at most 8 units a request
    expect(plan.estimate.worstCaseUsd).toBeGreaterThan(plan.estimate.expectedUsd);
    expect(await units()).toEqual([]);
    await syncUnits(db, doc);
    const rows = await units();
    expect(rows.every((u) => u.status === "pending" || u.status === "no_testimony")).toBe(true);
    expect(rows.filter((u) => u.status === "no_testimony")).toHaveLength(1); // "Do you see that?" and the objection
    expect(await db.$count(llmCalls)).toBe(0);
  });

  it("extracts, records the call and coverage, and keeps the speaker segments apart", async () => {
    const sent: string[] = [];
    const r = await extractFacts(db, doc, ruleModel({ sent }));
    expect(r).toMatchObject({ batches: { sent: 3, failed: 0 }, facts: { rejected: 0 }, stopped: null }); // at most 8 units a request
    expect(r.facts.indexed).toBeGreaterThan(10);
    // Statement 2's witness segment and its attorney segment went to different units.
    expect(sent[0]).toMatch(/S2 A: A: At the harbour office with the night clerk\.\n/);
    expect(sent[0]).toMatch(/\[U\d+\]\n(?:C\d+ [^\n]*\n)*S1 Q: Q\. Did the crane move\?\nS2 A: A: No\./);
    const calls = await db.select().from(llmCalls);
    expect(calls.every((c) => c.stage === "fact_extraction" && c.model === "claude-haiku-5-5")).toBe(true);
    const c = await factCoverage(db, caseId);
    expect(c.documents[0]).toMatchObject({ units: { pending: 0, failed: 0, no_testimony: 1 }, facts: { indexed: r.facts.indexed }, usage: { calls: 3, inputTokens: 300, outputTokens: 150 } });
    expect(c.documents[0].processed.done).toBe(c.documents[0].processed.eligible);
    // The verified index carries the stored source lines, never the model's text.
    const found = await verifiedFacts(db, { caseId });
    const crane = found.find((f) => f.evidencePhrase === "No")!;
    expect(crane.sourceLines.map((l) => l.text)).toEqual(["A: At the harbour office with the night clerk. Q. Did the crane move?", "A: No."]);
  });

  it("costs nothing the second time, and a retry after a failure stores each fact once", async () => {
    await extractFacts(db, doc, ruleModel({ fail: true }));
    expect((await units()).filter((u) => u.status === "failed").length).toBeGreaterThan(10);
    expect(await db.$count(facts)).toBe(0);
    const first = await extractFacts(db, doc, ruleModel());
    const sent: string[] = [];
    const again = await extractFacts(db, doc, ruleModel({ sent }));
    expect(again.batches.sent).toBe(0);
    expect(sent).toEqual([]);
    expect(await db.$count(facts)).toBe(first.facts.indexed);
    // Forcing a unit back to pending re-sends it; its fact is recognized, not stored again.
    const [one] = (await units()).filter((u) => u.status === "extracted");
    await db.update(factUnits).set({ status: "pending" }).where(eq(factUnits.unitKey, one.unitKey));
    const retry = await extractFacts(db, doc, ruleModel());
    expect(retry.facts).toMatchObject({ indexed: 0, duplicates: 1 });
    expect(await db.$count(facts)).toBe(first.facts.indexed);
  });

  it("extracts only the units asked for, leaving the rest pending", async () => {
    const { units: all } = await syncUnits(db, doc);
    const two = new Set(all.filter((u) => u.testimony).slice(0, 2).map((u) => u.unitKey));
    expect((await planFacts(db, doc, two)).due).toBe(2);
    const r = await extractFacts(db, doc, ruleModel(), { only: two });
    expect(r.facts.indexed).toBe(2);
    expect((await units()).filter((u) => u.status === "extracted").map((u) => u.unitKey).sort()).toEqual([...two].sort());
  });

  it("splits a batch cut off at the output limit, and marks a single unit cut off incomplete", async () => {
    const r = await extractFacts(db, doc, ruleModel({ stopReason: (text) => (text.match(/^\[U\d+\]/gm)!.length > 1 ? "max_tokens" : /^S\d+ .*statement 6 /m.test(text) ? "max_tokens" : "end_turn") }));
    expect(r.batches.split).toBeGreaterThan(0);
    const incomplete = (await units()).filter((u) => u.status === "incomplete");
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0].error).toMatch(/kept for another attempt/);
  });

  it("marks facts stale when their source changes, and keeps them out of the verified index", async () => {
    await extractFacts(db, doc, ruleModel());
    const before = (await verifiedFacts(db, { caseId })).length;
    // A corrected speaker on statement 6, a question (as a Stage 1 correction would make it).
    await db.update(lines).set({ speakerRole: "unknown" }).where(and(eq(lines.depositionId, doc), eq(lines.lineNo, 6)));
    expect((await planFacts(db, doc)).staleUnits).toBe(1);
    expect(await db.$count(facts, eq(facts.status, "stale"))).toBe(0); // the plan changed nothing
    expect((await syncUnits(db, doc)).staleUnits).toBe(1);
    expect(await db.$count(facts, eq(facts.status, "stale"))).toBe(1);
    expect((await verifiedFacts(db, { caseId })).length).toBe(before - 1);
    // Re-extracting the changed unit finds the same fact in it, which becomes current again.
    const r = await extractFacts(db, doc, ruleModel());
    expect(r.batches.sent).toBe(1);
    expect(await db.$count(facts, eq(facts.status, "stale"))).toBe(0);
    expect((await verifiedFacts(db, { caseId })).length).toBe(before);
  });

  it("never extracts an excluded copy, and leaves its facts out of the verified index", async () => {
    await extractFacts(db, doc, ruleModel());
    expect((await verifiedFacts(db, { caseId })).length).toBeGreaterThan(0);
    await excludeDocument(db, doc, { reason: "legacy_parse" });
    expect(await verifiedFacts(db, { caseId })).toEqual([]);
    await expect(extractFacts(db, doc, ruleModel())).rejects.toThrow(/excluded/);
    expect((await factCoverage(db, caseId)).excluded).toEqual([{ documentId: doc, reason: "legacy_parse", duplicateOf: null }]);
  });

  it("removes a deleted document's facts with it, and nothing else", async () => {
    await extractFacts(db, doc, ruleModel());
    expect(await deleteDeposition(db, pool, doc, uploads)).toMatchObject({ outcome: "deleted" });
    expect(await db.$count(facts)).toBe(0);
    expect(await db.$count(depositions)).toBe(0);
    expect(await db.$count(llmCalls)).toBe(3); // the calls and their cost stay on record
  });
});
