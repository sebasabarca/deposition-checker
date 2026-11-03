// Local embeddings' pure parts on hand-built inputs: representations, windows, pooling, cache keys. The
// model test runs only when the pinned model is already in data/raw/models/; it never downloads.
import { describe, expect, it } from "vitest";
import { cacheKey, centered, decodeVector, encodeVector, meanPool, poolWindows, representationText, stripSpeakerLabels, windowsOf, type CacheKeyParts } from "../../server/src/retrieve/embeddings";
import { loadMiniLM, modelFilesPresent, WINDOW_TOKENS } from "../../server/src/retrieve/minilm";

describe("representations", () => {
  const item = { question: "Q: Where did you park?", answer: "A: Near the north gate.", context: `${"word ".repeat(100)}Q: And then? A: I left.` };
  it("builds each representation, with the last 60 words of context", () => {
    expect(representationText(item, "a")).toBe("A: Near the north gate.");
    expect(representationText(item, "qc").startsWith("Q: Where did you park? word")).toBe(true);
    expect(representationText(item, "qac").split(/\s+/).length).toBe(5 + 5 + 60);
  });
  it("strips speaker labels, not words", () => {
    expect(stripSpeakerLabels("Q: Where did you park? A: Near the gate.")).toBe("Where did you park? Near the gate.");
    expect(stripSpeakerLabels("Ms. Cheney. Okay. Ms. Witness. A car came by.")).toBe("Okay. A car came by.");
    expect(stripSpeakerLabels("JANE DOE: I spoke with Mr. Smith. He left.")).toBe("I spoke with Mr. Smith. He left.");
    expect(stripSpeakerLabels("A car was there.")).toBe("A car was there."); // the article, not a label
    expect(representationText(item, "a", true)).toBe("Near the north gate.");
  });
});

describe("windows", () => {
  const seq = Array.from({ length: 10 }, (_, i) => i);
  it("keeps a short sequence whole", () => expect(windowsOf(seq, 10, 2)).toEqual([seq]));
  it("covers every token with overlapping windows no longer than the limit", () => {
    const ws = windowsOf(seq, 4, 1);
    expect(ws).toEqual([[0, 1, 2, 3], [3, 4, 5, 6], [6, 7, 8, 9]]);
    const ws2 = windowsOf(seq, 4, 2);
    expect(ws2.every((w) => w.length === 4)).toBe(true);
    expect(new Set(ws2.flat())).toEqual(new Set(seq));
    expect(ws2.at(-1)!.at(-1)).toBe(9);
  });
  it("rejects an overlap as large as the window", () => expect(() => windowsOf(seq, 3, 3)).toThrow());
});

describe("pooling", () => {
  it("averages only the masked tokens", () => {
    expect([...meanPool([1, 2, 3, 4, 100, 100], [1, 1, 0], 2)]).toEqual([2, 3]);
  });
  it("weights windows by token count and normalizes", () => {
    const v = poolWindows([Float32Array.from([1, 0]), Float32Array.from([0, 1])], [3, 1]);
    expect(v[0] / v[1]).toBeCloseTo(3);
    expect(Math.hypot(...v)).toBeCloseTo(1);
  });
  it("centers on the corpus mean", () => {
    const [a, b] = centered([Float32Array.from([1, 1]), Float32Array.from([1, -1])]);
    expect([...a]).toEqual([0, 1]);
    expect([...b]).toEqual([0, -1]);
  });
});

describe("cache keys", () => {
  const base: CacheKeyParts = { sourceHash: "h", model: "m", revision: "r", representation: "qac", windowing: "w254o64", text: "t" };
  it("change with every part", () => {
    const keys = new Set([base, { ...base, sourceHash: "h2" }, { ...base, model: "m2" }, { ...base, revision: "r2" }, { ...base, representation: "a" as const }, { ...base, windowing: "x" }, { ...base, text: "t2" }].map(cacheKey));
    expect(keys.size).toBe(7);
    expect(cacheKey(base)).toBe(cacheKey({ ...base }));
  });
  it("round-trips a vector", () => {
    const v = Float32Array.from([0.25, -1.5, 3]);
    expect([...decodeVector(encodeVector(v))]).toEqual([...v]);
  });
});

describe.skipIf(!modelFilesPresent())("the local model (only when already downloaded)", () => {
  it("embeds offline: normalized vectors, long text in several windows, no fetch", async () => {
    const m = await loadMiniLM();
    const { vectors, windows } = await m.embed(["A man is eating food.", "A man is eating a piece of bread.", "word ".repeat(WINDOW_TOKENS * 2)]);
    expect(windows).toEqual([1, 1, 3]);
    expect(Math.hypot(...vectors[0])).toBeCloseTo(1, 5);
    // The published sentence-transformers similarity for this pair is about 0.755.
    expect(vectors[0].reduce((s, x, j) => s + x * vectors[1][j], 0)).toBeCloseTo(0.755, 2);
    expect(m.fetchAttempts()).toBe(0);
  }, 30_000);
});
