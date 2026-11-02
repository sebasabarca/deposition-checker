// Batch arms must differ from the Fable arm only in model, output cap and price.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { anthropicParams } from "../../experiments/multimodel-contradictions/src/providers";

const { arms } = JSON.parse(readFileSync("experiments/multimodel-contradictions/config/arms.json", "utf8"));
const req = { system: "s", user: "u", maxTokens: 10 };

describe("batch arms", () => {
  it("send the same request as the Fable arm, apart from the model", () => {
    for (const id of ["G", "H", "J"]) expect({ ...anthropicParams(arms[id], req), model: "" }).toEqual({ ...anthropicParams(arms.F, req), model: "" });
  });
  it("use the same prompt addition and charge half the list price", () => {
    expect(arms.G.systemExtra).toBe(arms.F.systemExtra);
    expect(arms.H.systemExtra).toBe(arms.F.systemExtra);
    expect(arms.G.rates).toEqual({ input: 1, cacheRead: 0.05, cacheWrite: 1.25, output: 5 });
    expect(arms.H.rates).toEqual({ input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 });
  });
});
