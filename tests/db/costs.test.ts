// Recording model calls and totalling their cost, against the test database.
// See tests/db/database.ts for when these run.

import type Anthropic from "@anthropic-ai/sdk";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { jobCost, PRICE_VERSION, recordCall } from "../../server/src/costs";
import type { Database } from "../../server/src/db/client";
import { llmCalls } from "../../server/src/db/schema";
import { emptyTables, openTestDatabase, TEST_DATABASE_URL, violation } from "./database";

const usage = (fields: Partial<Anthropic.Usage> = {}): Anthropic.Usage =>
  ({
    input_tokens: 2_000,
    output_tokens: 500,
    cache_creation_input_tokens: 1_200,
    cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 200 },
    cache_read_input_tokens: 10_000,
    ...fields,
  }) as Anthropic.Usage;

describe.skipIf(!TEST_DATABASE_URL)("recording model calls (Postgres)", () => {
  let pool: Pool;
  let db: Database;

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(() => emptyTables(db));

  it("stores every token count, the cost and its price version exactly", async () => {
    const row = await recordCall(db, { jobId: 7, stage: "adjudication", model: "claude-sonnet-5-5", usage: usage(), attempt: 2, items: 10 });
    const [stored] = await db.select().from(llmCalls);
    expect(stored).toEqual(row);
    expect(stored).toMatchObject({
      jobId: 7,
      stage: "adjudication",
      model: "claude-sonnet-5-5",
      items: 10,
      inputTokens: 2_000,
      outputTokens: 500,
      cacheWrite5mTokens: 1_000,
      cacheWrite1hTokens: 200,
      cacheReadTokens: 10_000,
      batch: false,
      attempt: 2,
      priceVersion: PRICE_VERSION,
      costUsd: 0.0133, // worked out in tests/costs/cost.test.ts
    });
  });

  it("stores a tiny cost without losing precision, and the batch flag", async () => {
    const row = await recordCall(db, {
      jobId: null,
      stage: "claim_tagging",
      model: "claude-haiku-5-5",
      usage: usage({ input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0, cache_creation: null, cache_read_input_tokens: 0 }),
      attempt: 1,
      items: 1,
      batch: true,
    });
    expect(row).toMatchObject({ jobId: null, batch: true, costUsd: 0.00000005 }); // 1 token × $0.10 / 1M, halved
  });

  it("records a call to a model with no price, with its tokens, as unpriced rather than free", async () => {
    const row = await recordCall(db, { jobId: 7, stage: "adjudication", model: "claude-unknown-9", usage: usage(), attempt: 1, items: 10 });
    expect(row).toMatchObject({ inputTokens: 2_000, outputTokens: 500, cacheReadTokens: 10_000, costUsd: null, priceVersion: null });
  });

  it("totals a job by stage, and reports the total as unknown while any call is unpriced", async () => {
    const call = { jobId: 7, attempt: 1, items: 10, usage: usage({ input_tokens: 600, output_tokens: 300, cache_creation_input_tokens: 0, cache_creation: null, cache_read_input_tokens: 0 }) };
    await recordCall(db, { ...call, stage: "adjudication", model: "claude-sonnet-5-5" }); // $0.0042
    await recordCall(db, { ...call, stage: "adjudication", model: "claude-sonnet-5-5" }); // $0.0042
    await recordCall(db, { ...call, stage: "claim_tagging", model: "claude-haiku-5-5" }); // $0.00021
    await recordCall(db, { ...call, jobId: 8, stage: "adjudication", model: "claude-sonnet-5-5" }); // another job

    expect(await jobCost(db, 7)).toEqual({
      calls: 3,
      unpricedCalls: 0,
      pricedUsd: 0.00861,
      totalUsd: 0.00861,
      byStage: {
        adjudication: { calls: 2, unpricedCalls: 0, pricedUsd: 0.0084 },
        claim_tagging: { calls: 1, unpricedCalls: 0, pricedUsd: 0.00021 },
      },
    });

    await recordCall(db, { ...call, stage: "adjudication", model: "claude-unknown-9" });
    expect(await jobCost(db, 7)).toMatchObject({ calls: 4, unpricedCalls: 1, pricedUsd: 0.00861, totalUsd: null });
    expect((await jobCost(db, 7)).byStage.adjudication).toEqual({ calls: 3, unpricedCalls: 1, pricedUsd: 0.0084 });
  });

  it("rejects a cost without a price version, negative tokens, and an attempt or item count below 1", async () => {
    const row = {
      stage: "adjudication" as const,
      model: "claude-sonnet-5-5",
      items: 1,
      inputTokens: 1,
      outputTokens: 1,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      cacheReadTokens: 0,
      attempt: 1,
    };
    expect(await violation(db.insert(llmCalls).values({ ...row, costUsd: 0.1 }))).toBe("llm_calls_priced_check");
    expect(await violation(db.insert(llmCalls).values({ ...row, inputTokens: -1 }))).toBe("llm_calls_tokens_check");
    expect(await violation(db.insert(llmCalls).values({ ...row, attempt: 0 }))).toBe("llm_calls_counts_check");
  });
});
