// The extraction prompt must not teach the evaluation's answers: none of the hand-authored records'
// dimensions, asserted values or distinctive words may appear in it, so a real-model pilot measures
// extraction, not recall of the prompt's examples.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FACTS_SYSTEM_PROMPT } from "../../server/src/claims/facts";

const expected = JSON.parse(readFileSync("data/eval/facts-expected-v1.json", "utf8")) as { facts: { dimension: string; object: string | null }[] };
const prompt = FACTS_SYSTEM_PROMPT.toLowerCase();

describe("the extraction prompt", () => {
  it("names none of the evaluation's dimensions or asserted values", () => {
    for (const f of expected.facts) {
      expect(prompt, f.dimension).not.toContain(f.dimension);
      if (f.object) expect(prompt, f.object).not.toContain(f.object.toLowerCase());
    }
  });
  it("uses none of the evaluation passages' distinctive words", () => {
    for (const w of ["limo", "suv", "presidential", "gate", "garage", "alley", "dog", "nicole", "simpson", "resnick", "hutchinson", "cocaine", "funeral", "steering"]) expect(prompt, w).not.toMatch(new RegExp(`\\b${w}`));
  });
});
