// A lower output cap in a whole-case run: the value sent as max_tokens, the budget reservation, the limiter's output
// charge and the stored request are the same number for every request; a reply cut off at the cap is counted and its
// unanswered pairs go to one recovery request at the default cap, so nothing is lost or sent twice. Mock replies only.

import { and, eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packetMaxTokens } from "../../server/src/adjudicate/packetModel";
import { PACKET_MODEL, type IssuePacket } from "../../server/src/adjudicate/packetPrompt";
import { maxRequestCost } from "../../server/src/costs";
import type { Database } from "../../server/src/db/client";
import { adjudicationRequests, budgetReservations, depositions } from "../../server/src/db/schema";
import { mockPacketReply } from "../../server/src/eval/mockPacketModel";
import { WEBB_SUITE } from "../../server/src/eval/synthetic";
import { storeSessions } from "../../server/src/eval/syntheticStore";
import { caseRunReport, caseRunSetOf, createCaseRun, runCaseRun, type CasePacketModel } from "../../server/src/jobs/caseRun";
import { ProviderLimiter, UNLIMITED, type Ticket } from "../../server/src/jobs/limiter";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL } from "./database";

type Reply = Awaited<ReturnType<CasePacketModel["adjudicate"]>>;
const CAP = 1_200;

// The mock provider, recording the max_tokens each request was sent with. cutOff: packets whose first reply stops at
// max_tokens with its last pair missing.
function provider(cutOff = new Set<string>()) {
  const sent: { packet: string; pairs: number; maxOutputTokens: number | undefined }[] = [];
  const model: CasePacketModel = {
    model: PACKET_MODEL, effort: "medium", promptVersion: "packet-v1",
    async adjudicate(packet: IssuePacket, options) {
      const first = !sent.some((s) => s.packet === packet.id);
      sent.push({ packet: packet.id, pairs: packet.pairs.length, maxOutputTokens: options?.maxOutputTokens });
      const cut = first && cutOff.has(packet.id) && packet.pairs.length > 1;
      const m = mockPacketReply(packet, cut ? { drop: [packet.pairs.at(-1)!.pairId] } : {});
      const usage = { input_tokens: m.usage.inputTokens, output_tokens: cut ? options!.maxOutputTokens! : m.usage.outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } as Reply["usage"];
      return { model: PACKET_MODEL, stopReason: cut ? "max_tokens" : "end_turn", usage, text: m.text, latencyMs: 1, requestId: `req-${sent.length}` };
    },
  };
  return { model, sent };
}
// A limiter that records every ticket it admits, in order.
function recordingLimiter() {
  const limiter = new ProviderLimiter({ ...UNLIMITED, maxInFlight: 1, outputTokensPerPair: { "packet-v1": CAP } });
  const tickets: Ticket[] = [];
  const before = limiter.beforeSend.bind(limiter);
  limiter.beforeSend = async (t, signal) => { tickets.push(t); return before(t, signal); };
  return { limiter, tickets };
}

describe.skipIf(!TEST_DATABASE_URL)("whole-case run with a lower output cap", () => {
  let db: Database;
  let pool: Pool;
  let caseId: number;
  const requestsOf = (runId: number) =>
    db.select({ id: adjudicationRequests.id, maxOutputTokens: adjudicationRequests.maxOutputTokens, estimatedInputTokens: adjudicationRequests.estimatedInputTokens, maxCostUsd: adjudicationRequests.maxCostUsd, reserved: budgetReservations.maxUsd, errorKind: adjudicationRequests.errorKind, status: adjudicationRequests.status, candidateIds: adjudicationRequests.candidateIds })
      .from(adjudicationRequests).leftJoin(budgetReservations, eq(budgetReservations.id, adjudicationRequests.reservationId))
      .where(eq(adjudicationRequests.candidateSet, caseRunSetOf(runId))).orderBy(adjudicationRequests.id);

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
    await emptyTables(db);
    await storeSessions(db, WEBB_SUITE);
    [{ caseId }] = await db.select({ caseId: depositions.caseId }).from(depositions).limit(1);
  }, 120_000);
  afterAll(async () => { await pool?.end(); });

  it("sends, reserves, charges and stores the same cap for every request", async () => {
    const p = provider();
    const { limiter, tickets } = recordingLimiter();
    const run = await createCaseRun(db, caseId, { mode: "live", budgetUsd: 50, confirmed: true });
    expect(await runCaseRun(db, pool, run.id, { adjudicator: () => p.model, limiter, minilm: "off", sleep: async () => undefined })).toBe("completed");
    const rows = await requestsOf(run.id);
    expect(rows.length).toBe(p.sent.length);
    expect(rows.length).toBeGreaterThan(1);
    rows.forEach((r, i) => {
      const cap = packetMaxTokens(p.sent[i].pairs, CAP);
      expect(p.sent[i].maxOutputTokens).toBe(cap); // max_tokens as sent
      expect(r.maxOutputTokens).toBe(cap); // the request ledger
      expect(tickets[i].output).toBe(cap); // the limiter's output charge
      const worst = maxRequestCost(PACKET_MODEL, { inputTokens: r.estimatedInputTokens, maxOutputTokens: cap });
      expect(r.maxCostUsd).toBe(worst); // the reservation covers input at the cache-write price plus max_tokens
      expect(r.reserved).toBe(worst);
    });
  }, 120_000);

  it("counts a cut-off reply and recovers its unanswered pair once, at the default cap", async () => {
    const probe = provider();
    const { limiter: l0 } = recordingLimiter();
    const first = await createCaseRun(db, caseId, { mode: "live", budgetUsd: 50, confirmed: true });
    await runCaseRun(db, pool, first.id, { adjudicator: () => probe.model, limiter: l0, minilm: "off", sleep: async () => undefined });
    const multi = probe.sent.find((s) => s.pairs > 1)!.packet;

    const p = provider(new Set([multi]));
    const { limiter } = recordingLimiter();
    const run = await createCaseRun(db, caseId, { mode: "live", budgetUsd: 50, confirmed: true });
    expect(await runCaseRun(db, pool, run.id, { adjudicator: () => p.model, limiter, minilm: "off", sleep: async () => undefined })).toBe("completed");
    const forPacket = p.sent.filter((s) => s.packet === multi);
    expect(forPacket.length).toBe(2);
    expect(forPacket[0].maxOutputTokens).toBe(packetMaxTokens(forPacket[0].pairs, CAP));
    expect(forPacket[1]).toMatchObject({ pairs: 1, maxOutputTokens: packetMaxTokens(1) }); // recovery: default cap
    const rows = await requestsOf(run.id);
    expect(rows.filter((r) => r.errorKind === "cut_off")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "partial")).toHaveLength(1);
    expect(p.sent.length).toBe(probe.sent.length + 1); // one extra request, nothing else re-sent
    const report = (await caseRunReport(db, run.id))!;
    expect(report.coverageState).toBe("complete");
    const dup = await db.execute<{ n: number }>(sql`select count(*)::int as n from (select v.candidate_id from verdicts v join candidates c on c.id = v.candidate_id where c.candidate_set = ${caseRunSetOf(run.id)} group by 1 having count(*) > 1) d`);
    expect(dup.rows[0].n).toBe(0);
    const open = await db.$count(budgetReservations, and(eq(budgetReservations.status, "reserved")));
    expect(open).toBe(0);
  }, 120_000);
});
