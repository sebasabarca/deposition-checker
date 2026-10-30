import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applySheet, parseCsv, ReviewSet } from "../../server/src/eval/reviewSet";

const file = "data/eval/review-set-v1.json";
const set = ReviewSet.parse(JSON.parse(readFileSync(file, "utf8")));
const sheet = (rows: string[]) => ["id,human_classification,human_comparable,human_notes", ...rows].join("\n");

describe("the review set", () => {
  it("has 20 to 40 pairs, no human labels yet, and marks the model's verdict as not ground truth", () => {
    expect(set.pairs.length).toBeGreaterThanOrEqual(20);
    expect(set.pairs.length).toBeLessThanOrEqual(40);
    expect(new Set(set.pairs.map((p) => p.id)).size).toBe(set.pairs.length);
    expect(set.pairs.every((p) => p.modelVerdict.note.includes("not ground truth"))).toBe(true);
  });
  it("holds no testimony", () => {
    expect(readFileSync(file, "utf8")).not.toMatch(/"(text|lines|explanation|statement\w*|keyPhrase\w*)"/);
    if (existsSync("data/eval/review/review-set-v1.csv")) expect(readFileSync(".gitignore", "utf8")).toContain("data/eval/review/");
  });
  it("is never read by retrieval code", () => {
    for (const f of readdirSync("server/src/retrieve")) expect(readFileSync(`server/src/retrieve/${f}`, "utf8")).not.toMatch(/review-?set/i);
  });
});

describe("applySheet", () => {
  const id = set.pairs[0].id;
  it("copies filled-in labels and leaves the rest unlabelled", () => {
    const out = applySheet(set, sheet([`${id},compatible,yes,"same subject, ""different"" year"`]));
    expect(out.pairs[0].human).toEqual({ classification: "compatible", comparable: true, notes: 'same subject, "different" year' });
    expect(out.pairs[1].human.classification).toBeNull();
  });
  it("keeps comparability independent of classification", () => {
    expect(applySheet(set, sheet([`${id},,no,`])).pairs[0].human).toEqual({ classification: null, comparable: false, notes: "" });
  });
  it("refuses a label outside the choices, instead of dropping it", () => {
    expect(() => applySheet(set, sheet([`${id},contradiction,yes,`]))).toThrow();
    expect(() => applySheet(set, sheet([`${id},compatible,maybe,`]))).toThrow(/yes or no/);
  });
  it("reads quoted commas and line breaks", () => {
    expect(parseCsv('a,b\n"1,2","x\ny"\n')).toEqual([["a", "b"], ["1,2", "x\ny"]]);
  });
});
