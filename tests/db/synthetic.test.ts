// The synthetic Webb evaluation through the whole adjudication pipeline (packet, budget, verdict
// storage, Layer 1, Layer 2, checks, score, finding) with a fake model that answers with each case's
// prepared verdict. It checks what code does with a correct verdict and with faulty ones; whether
// Sonnet gives correct verdicts needs a paid run. See tests/db/database.ts for when these run.

import type Anthropic from "@anthropic-ai/sdk";
import { eq, inArray } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adjudicateCandidate, loadPacket, type Adjudicator, type Verdict } from "../../server/src/adjudicate";
import { ensureBudget } from "../../server/src/costs";
import type { Database } from "../../server/src/db/client";
import { exchanges, findings, lines, llmCalls, verdicts } from "../../server/src/db/schema";
import { SYNTHETIC_CASES, WHITFIELD_CASES, WHITFIELD_SUITE } from "../../server/src/eval/synthetic";
import { storeSynthetic } from "../../server/src/eval/syntheticStore";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

const usage = { input_tokens: 1000, output_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null } as unknown as Anthropic.Usage;

const answering = (verdict: Verdict, promptVersion: Adjudicator["promptVersion"] = "adjudicate-v1"): Adjudicator => ({
  model: "claude-sonnet-5-5",
  effort: "medium",
  promptVersion,
  async adjudicate() {
    return { model: "claude-sonnet-5-5", stopReason: "end_turn", usage, text: JSON.stringify(verdict), latencyMs: 1 };
  },
});

// What code makes of each case's prepared (correct) verdict, A + C + S + K + U then caps (rubric v1).
const EXPECTED: Record<string, { evidence: string; attribution: [string, string]; score: number | null; band: string | null; priority: string; caps: string[] }> = {
  // 20 + 10 + 30 + 5 (negation asymmetry; the shared term is only "him") + 25.
  "webb-cho": { evidence: "verified", attribution: ["clear", "clear"], score: 90, band: "high", priority: "high", caps: [] },
  // Times incompatible (21:30-23:00 against 23:30-0:30), so no timing cap. "maybe" qualifies both
  // sides: 12 + 10 + 30 + 5 + 25 - 10 (alternative) - 5 ("Around 10") = 67; cap 70 applies, not binding.
  "webb-sleep": { evidence: "verified", attribution: ["qualified", "qualified"], score: 67, band: "medium", priority: "medium", caps: ["side_qualified_or_uncertain:70"] },
  // Side B qualified ("I think"). 16 + 10 + 30 + 0 + 25 - 10 - 5 ("maybe around 7:30") = 66; cap 70 applies, not binding.
  "webb-home": { evidence: "verified", attribution: ["clear", "qualified"], score: 66, band: "medium", priority: "medium", caps: ["side_qualified_or_uncertain:70"] },
  // "I don't remember exactly" stands for the question. The answer isn't plain, so code's reading is
  // an upper bound (uncertain); Claude's more cautious does_not_recall stands, with no disagreement.
  // 20 + 10 + 30 + 0 + 25 = 85.
  "webb-pizza": { evidence: "verified", attribution: ["clear", "no_recall"], score: 85, band: "high", priority: "low", caps: [] },
  // "might have" qualifies side B, matching Claude, and earns the qualifier check. 20 + 10 + 30 + 5 + 15 = 80.
  "webb-alone": { evidence: "verified", attribution: ["clear", "qualified"], score: 80, band: "high", priority: "low", caps: [] },
  // "No, never." is a plain denial of the question, matching Claude's stance. 20 + 10 + 30 + 0 + 25 = 85.
  "webb-hargrove": { evidence: "verified", attribution: ["clear", "clear"], score: 85, band: "high", priority: "low", caps: [] },
};

describe.skipIf(!TEST_DATABASE_URL)("synthetic Webb evaluation (Postgres, fake model)", () => {
  let pool: Pool;
  let db: Database;
  let ids: Map<string, number>;
  let budgetId: number;

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
  });
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    await emptyTables(db);
    ids = await storeSynthetic(db);
    budgetId = await ensureBudget(db, "synthetic", 1);
  });

  const verdictFor = async (caseId: string, change: Partial<Verdict> = {}) => {
    const c = SYNTHETIC_CASES.find((x) => x.id === caseId)!;
    const packet = await loadPacket(db, ids.get(caseId)!);
    return { candidateId: ids.get(caseId)!, packet, verdict: { ...c.verdict, evidenceAId: packet.a.id, evidenceBId: packet.b.id, ...change } as Verdict };
  };

  it("stores the fixtures once, with one candidate per case", async () => {
    expect([...ids.keys()]).toEqual(SYNTHETIC_CASES.map((c) => c.id));
    expect(await storeSynthetic(db)).toEqual(ids);
  });

  for (const c of SYNTHETIC_CASES) {
    it(`${c.id} (${c.kind}): a correct verdict is verified and scored as expected`, async () => {
      const { candidateId, verdict } = await verdictFor(c.id);
      const result = await adjudicateCandidate(db, candidateId, answering(verdict), { budgetId });
      const e = EXPECTED[c.id];
      const { checks, assessment, priority } = result.assessed!;
      expect({
        evidence: checks.source.status,
        attribution: [checks.attribution.a.level, checks.attribution.b.level],
        score: assessment.score,
        band: assessment.band,
        priority,
        caps: assessment.capsApplied.map((x) => `${x.rule}:${x.limit}${x.binding ? "*" : ""}`),
      }).toEqual(e);
    });
  }

  it("shows a bare-answer key phrase with its question, never alone", async () => {
    const { candidateId, packet, verdict } = await verdictFor("webb-hargrove", { keyPhraseA: "No, never." });
    const result = await adjudicateCandidate(db, candidateId, answering(verdict), { budgetId });
    const a = result.assessed!.checks.source.a;
    expect(a.bareAnswer).toBe(true);
    expect(a.proposition).toBe("Have you ever been to the Hargrove Street warehouse?");
    const shown = await db.select({ text: lines.rawText }).from(lines).where(eq(lines.id, a.evidenceLineIds[0]));
    expect(shown[0].text).toMatch(/^Q\. Have you ever been/);
    expect(a.evidenceLineIds).toEqual(packet.a.lines.map((l) => l.id));
  });

  it("keeps a fabricated quotation out of the scored findings", async () => {
    const { candidateId, verdict } = await verdictFor("webb-cho", { keyPhraseB: "I met Daniel Cho at the Portland airport" });
    await adjudicateCandidate(db, candidateId, answering(verdict), { budgetId });
    const [f] = await db.select().from(findings);
    expect(f).toMatchObject({ evidenceStatus: "unsupported", score: null, priority: "low" });
  });

  it("never verifies a fabrication assembled from words in different sentences", async () => {
    // "Daniel Cho" is in B's question and "met" in its answer: v1's matching alone scored this 0.675.
    // Three of its words are in one sentence of A's question, so it is a wrong reference, unscored.
    const { candidateId, verdict } = await verdictFor("webb-cho", { keyPhraseB: "I met Daniel Cho at the warehouse" });
    await adjudicateCandidate(db, candidateId, answering(verdict), { budgetId });
    expect((await db.select().from(findings))[0]).toMatchObject({ evidenceStatus: "wrong_reference", score: null, priority: "low" });
  });

  it("calls a phrase cited from the wrong session a wrong reference", async () => {
    const { candidateId, verdict } = await verdictFor("webb-cho", { keyPhraseA: "I knew of him" });
    await adjudicateCandidate(db, candidateId, answering(verdict), { budgetId });
    expect((await db.select().from(findings))[0]).toMatchObject({ evidenceStatus: "wrong_reference", score: null });
  });

  it("runs a new prompt version beside the old one, and refuses a repeat of the same version", async () => {
    const { candidateId, verdict } = await verdictFor("webb-cho");
    await adjudicateCandidate(db, candidateId, answering(verdict), { budgetId });
    const v2 = await adjudicateCandidate(db, candidateId, answering({ ...verdict, alternativeSupport: null } as Verdict, "adjudicate-v2"), { budgetId });
    expect(v2.status).toBe("valid");
    expect((await db.select().from(verdicts)).map((x) => x.promptVersion).sort()).toEqual(["adjudicate-v1", "adjudicate-v2"]);
    await expect(adjudicateCandidate(db, candidateId, answering(verdict, "adjudicate-v2"), { budgetId })).rejects.toThrow("already has adjudicate-v2 verdict");
  });

  it("keeps an inconsistent verdict as received, unscored for review, with no further call", async () => {
    const { candidateId, verdict } = await verdictFor("webb-cho", { classification: "false_positive", falsePositiveReason: "both_can_be_true", conflictBasis: "value_conflict" });
    const model = answering({ ...verdict, alternativeSupport: null } as Verdict, "adjudicate-v2");
    const result = await adjudicateCandidate(db, candidateId, model, { budgetId });
    expect(result.status).toBe("valid");
    const [v] = await db.select().from(verdicts);
    expect(v.consistencyIssues).toEqual(["false_positive_with_conflict_basis"]);
    expect(JSON.parse(v.raw!)).toMatchObject({ classification: "false_positive", conflictBasis: "value_conflict" });
    const [f] = await db.select().from(findings);
    expect(f).toMatchObject({ type: "false_positive", evidenceStatus: "verified", score: null, band: null, unscoredReason: "inconsistent_verdict", priority: "needs_context" });
    expect(await db.select().from(llmCalls)).toHaveLength(1);
  });

  it("caps a direct call that rests on a recollection failure", async () => {
    const { candidateId, verdict } = await verdictFor("webb-pizza", { classification: "direct", conflictBasis: "explicit_negation", falsePositiveReason: null });
    const result = await adjudicateCandidate(db, candidateId, answering(verdict), { budgetId });
    expect(result.assessed!.assessment.score).toBeLessThanOrEqual(40);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("synthetic Whitfield suite (held out; Postgres, no model)", () => {
  let pool: Pool;
  let db: Database;
  let ids: Map<string, number>;

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
    await emptyTables(db);
    ids = await storeSynthetic(db, WHITFIELD_SUITE);
  });
  afterAll(async () => {
    await pool?.end();
  });

  const text = async (caseId: string) => {
    const p = await loadPacket(db, ids.get(caseId)!);
    const show = (ls: { text: string }[]) => ls.map((l) => l.text).join(" ");
    return { p, a: show(p.a.lines), b: show(p.b.lines), contextA: show([...p.a.before, ...p.a.after]), contextB: show([...p.b.before, ...p.b.after]) };
  };

  it("stores one candidate per case, each a whole question and answer on both sides", async () => {
    expect([...ids.keys()]).toEqual(WHITFIELD_CASES.map((c) => c.id));
    for (const c of WHITFIELD_CASES) {
      const { p } = await text(c.id);
      const parts = await db.select({ flags: exchanges.flags }).from(exchanges).where(inArray(exchanges.id, [...p.a.partIds, ...p.b.partIds]));
      expect(parts.flatMap((x) => x.flags), c.id).toEqual([]);
      for (const s of [p.a, p.b]) expect(s.lines.map((l) => l.role).filter((r, i, all) => all.indexOf(r) === i), `${c.id} ${s.session}`).toEqual(["question", "answer"]);
    }
  });

  it("puts each case's deliberate context where the adjudicator will see it", async () => {
    const log = await text("whit-delivery-log");
    expect(log.b).toContain("I did, after my shift ended.");
    expect(log.contextB).toContain("I wasn't at the depot at all that week"); // misleading: must not be used
    expect((await text("whit-reyes")).contextA).toContain("night shift supervisor"); // resolves "Mr. Reyes"
    expect((await text("whit-fire-location")).contextB).toContain("Tacoma"); // resolves "the loading yard"
    expect((await text("whit-incident-report")).a).toMatch(/review the incident report and sign it\?.*A\. No\./);
  });
});
