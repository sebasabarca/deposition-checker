// The format adapters against genuine transcript samples and their hand-verified ground truth
// (tests/fixtures/transcripts). The originals aren't in git; a test is skipped when its file is absent.

import { describe, expect, it } from "vitest";
import { available, evaluate, samples } from "../fixtures/transcripts/evaluate";

describe("transcript samples against their ground truth", () => {
  for (const s of samples()) {
    it.skipIf(!available(s))(`${s.id} (${s.kind} ${s.format})`, async () => {
      const e = await evaluate(s);
      expect(e.misses).toEqual([]);
      for (const m of [e.pages, e.lines, e.text, e.speakers, e.exchanges, e.warnings]) expect(m.right).toBe(m.of);
      expect(e.read.validation.status).toBe("ready");
      expect(e.deterministic).toBe(true);
    });
  }

  it("has two independent genuine samples of every format it claims", () => {
    const genuine = samples().filter((s) => s.kind === "genuine");
    expect(new Set(genuine.filter((s) => s.format === "text").map((s) => s.source)).size).toBeGreaterThanOrEqual(2);
  });
});
