import { describe, expect, it } from "vitest";
import { depositionFingerprint, ESTIMATE_TTL_MS, estimateCacheKey, loadEstimate, saveEstimate } from "../../client/src/lib/estimateCache";
import type { CaseRunEstimate } from "../../client/src/types";

const memory = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }; };
const est = (usd: number) => ({ expectedUsd: usd, listedPairs: 10 }) as unknown as CaseRunEstimate;

describe("saved estimates", () => {
  it("returns a saved estimate for the same account, case, choice and depositions", () => {
    const s = memory();
    const key = estimateCacheKey(1, 19, '[null,"packet-v1"]', depositionFingerprint([{ id: 76, status: "ready", fileSha256: "a" }, { id: 78, status: "ready", fileSha256: "b" }]));
    saveEstimate(s, key, est(47.73), 1000);
    expect(loadEstimate(s, key, 2000)?.estimate.expectedUsd).toBe(47.73);
    expect(loadEstimate(s, estimateCacheKey(2, 19, '[null,"packet-v1"]', "x"), 2000)).toBeNull(); // another account
  });
  it("does not reuse an estimate after the depositions change", () => {
    const before = depositionFingerprint([{ id: 76, status: "ready", fileSha256: "a" }, { id: 78, status: "ready", fileSha256: "b" }]);
    expect(depositionFingerprint([{ id: 78, status: "ready", fileSha256: "b" }, { id: 76, status: "ready", fileSha256: "a" }])).toBe(before); // order doesn't matter
    expect(depositionFingerprint([{ id: 76, status: "ready", fileSha256: "a" }, { id: 78, status: "ready", fileSha256: "c" }])).not.toBe(before); // a replaced file
    expect(depositionFingerprint([{ id: 76, status: "ready", fileSha256: "a" }, { id: 78, status: "ready", fileSha256: "b" }, { id: 79, status: "ready", fileSha256: "d" }])).not.toBe(before); // one added
  });
  it("expires after a day, and survives a broken or missing store", () => {
    const s = memory();
    saveEstimate(s, "k", est(1), 0);
    expect(loadEstimate(s, "k", ESTIMATE_TTL_MS + 1)).toBeNull();
    s.m.set("veridict:estimates:v1", "{not json");
    expect(loadEstimate(s, "k", 1)).toBeNull();
    expect(() => saveEstimate({ getItem: () => null, setItem: () => { throw new Error("quota"); } }, "k", est(1), 1)).not.toThrow();
    expect(loadEstimate(null, "k", 1)).toBeNull();
  });
});
