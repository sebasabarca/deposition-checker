import { describe, expect, it } from "vitest";
import { estimateCost, EXTRACTION_JSON_SCHEMA, formatBatch, PREDICATES, SYSTEM_PROMPT } from "../../server/src/claims";

describe("extraction prompt", () => {
  it("gives every predicate its written meaning, and asks for no confidence", () => {
    for (const [name, meaning] of Object.entries(PREDICATES)) expect(SYSTEM_PROMPT).toContain(`- ${name}: ${meaning}`);
    expect(JSON.stringify(EXTRACTION_JSON_SCHEMA)).not.toMatch(/confidence|score|probability/i);
  });

  it("labels each exchange with its part ID", () => {
    expect(formatBatch([{ id: 7, dialogueText: "Q: Did you?\nA: Yes." }, { id: 9, dialogueText: "Q: When?\nA: In May." }])).toBe(
      "[E7]\nQ: Did you?\nA: Yes.\n\n[E9]\nQ: When?\nA: In May.",
    );
  });

  it("estimates tokens and cost from the batches before any call", () => {
    const batch = [{ id: 1, dialogueText: "x".repeat(3000) }];
    const schemaChars = JSON.stringify(EXTRACTION_JSON_SCHEMA).length;
    const one = estimateCost([batch], schemaChars);
    const two = estimateCost([batch, batch], schemaChars);
    expect(one.inputTokens).toBe(Math.ceil((SYSTEM_PROMPT.length + schemaChars + "[E1]\n".length + 3000) / 3));
    expect(one.outputTokens).toBe(Math.ceil(one.inputTokens * 0.4));
    // Haiku 5.5 at $0.10 / $0.50 per million tokens
    expect(one.costUsd).toBeCloseTo((one.inputTokens * 0.1 + one.outputTokens * 0.5) / 1e6, 6);
    expect(two).toMatchObject({ batches: 2, parts: 2, inputTokens: one.inputTokens * 2 });
    // With a measured output share instead of the 40% planning allowance.
    expect(estimateCost([batch], schemaChars, 1).outputTokens).toBe(one.inputTokens);
  });
});
