import { describe, it, expect } from "vitest";
import { parseTranscript } from "../server/src/transcript";
import { TRANSCRIPT_1 } from "../server/src/data/samples";

describe("parseTranscript", () => {
  it("splits the March deposition into 6 numbered Q&A pairs", () => {
    const pairs = parseTranscript(TRANSCRIPT_1, "T1");
    expect(pairs).toHaveLength(6);
    expect(pairs[0].id).toBe("T1-1");
    expect(pairs[0].answers).toContain("at home all evening");
  });

  it("returns an empty list when the text has no questions", () => {
    expect(parseTranscript("Just some text", "T1")).toEqual([]);
  });
});
