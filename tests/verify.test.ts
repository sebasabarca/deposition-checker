import { normalize, quoteMatchScore } from "../server/src/verify";
import { describe, it, expect } from "vitest";
import { verifyQuote } from "../server/src/verify";
import type { QAPair } from "../server/src/transcript";

describe("verifyQuote", () => {
  const pairs: QAPair[] = [
    {
      id: "T1-1",
      question: "Where were you on March 1st?",
      answer: "I was at home all evening.",
    },
    {
      id: "T1-2",
      question: "Did you see anyone that night?",
      answer: "No, I did not see anyone.",
    },
  ];
  it("scores 1 for an exact quote with a missing space", () => {
    const score = verifyQuote("I was at home all,evening.", "T1-1", pairs);
    expect(score).toBe(1);
  });
  it("puts an invented quote below the 0.6 evidence gate", () => {
    const score = verifyQuote("I was at the park.", "T1-1", pairs);
    expect(score).toBeLessThan(0.6);
  });
  it("scores 0 for a non-existent ID", () => {
    const score = verifyQuote("I was at home all evening.", "T1-3", pairs);
    expect(score).toBe(0);
  });
  it("scores between 0.5 and 1 for a paraphrase", () => {
    const score = verifyQuote("I was home all night.", "T1-1", pairs);
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThan(1);
  });
});


describe("OCR bars in matching", () => {
  it("reads a bar joined to a word as I, in matching only", () => {
    expect(normalize("I believe |saw him")).toBe("i believe i saw him");
    expect(normalize("And| recall Mr. Meadows")).toBe("and i recall mr meadows");
    expect(quoteMatchScore("I believe I saw him", "When I was there, I believe |saw him.")).toBe(1);
  });
});
