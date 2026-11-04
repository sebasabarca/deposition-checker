import { describe, expect, it } from "vitest";
import { INSTRUCTION_TOKENS, type EvidencePacket } from "../../server/src/retrieve/grouping";
import { splitPacket } from "../../server/src/retrieve/packetSplit";

const star = (n: number): EvidencePacket => {
  const items = ["c", ...Array.from({ length: n }, (_, i) => `x${String(i).padStart(2, "0")}`)];
  return { id: "star-1", issue: "i", items, pairs: items.slice(1).map((k) => ["c", k] as [string, string]), inputTokens: INSTRUCTION_TOKENS + 100 * items.length };
};
const keysOf = (parts: { pairs: [string, string][] }[]) => parts.flatMap((p) => p.pairs.map(([a, b]) => `${a}|${b}`));

describe("splitPacket", () => {
  it("leaves a packet within the limits unchanged", () => {
    const p = star(8);
    expect(splitPacket(p, () => 100)).toEqual([{ ...p, splitFrom: null, oversize: false }]);
  });

  it("splits by pair count, keeping every pair once and in order, deterministically", () => {
    const p = star(19);
    const parts = splitPacket(p, () => 100);
    expect(parts.map((x) => x.pairs.length)).toEqual([8, 8, 3]);
    expect(parts.map((x) => x.id)).toEqual(["star-1.1", "star-1.2", "star-1.3"]);
    expect(keysOf(parts)).toEqual(keysOf([p]));
    expect(parts.every((x) => x.splitFrom === "star-1" && x.items.includes("c"))).toBe(true);
    expect(splitPacket(p, () => 100)).toEqual(parts);
  });

  it("splits by input tokens, and keeps an oversize pair alone rather than dropping it", () => {
    const p = { ...star(4), inputTokens: 20_000 };
    const tokens = (k: string) => (k === "x02" ? 7_000 : 1_500);
    const parts = splitPacket(p, tokens, { maxPairs: 8, maxInputTokens: 9_000 });
    expect(keysOf(parts)).toEqual(keysOf([p]));
    expect(parts.every((x) => x.inputTokens <= 9_000 || x.pairs.length === 1)).toBe(true);
    const big = parts.find((x) => x.pairs.some(([, b]) => b === "x02"))!;
    expect(big).toMatchObject({ oversize: true, pairs: [["c", "x02"]] });
  });
});
