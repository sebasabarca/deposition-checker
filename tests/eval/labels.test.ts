import { describe, expect, it } from "vitest";
import { LabelFile, readLabelFile } from "../../server/src/eval";

const pair = {
  a: { document: "p3171", page: 249, line: 13 },
  b: { document: "p3173", page: 51, line: 13 },
  label: "ambiguous",
  retrievalRelevant: true,
  note: "Industry outsourcing vs Oracle's own outsourcing service; may be different subjects.",
};

describe("label file", () => {
  it("the Ellison file is valid and identifies both depositions by SHA-256", async () => {
    const file = await readLabelFile("data/eval/ellison-labels.json");
    expect(Object.keys(file.documents).sort()).toEqual(["p3171", "p3173"]);
    expect(file.synthetic).toBe(false);
  });

  it("accepts a well-formed pair, and rejects unknown documents, same-document pairs, unknown labels and bad page:line", async () => {
    const base = await readLabelFile("data/eval/ellison-labels.json");
    const check = (p: object) => LabelFile.safeParse({ ...base, pairs: [p] }).success;
    expect(check(pair)).toBe(true);
    expect(check({ ...pair, b: { ...pair.b, document: "p9999" } })).toBe(false);
    expect(check({ ...pair, b: { ...pair.a } })).toBe(false);
    expect(check({ ...pair, label: "contradiction" })).toBe(false);
    expect(check({ ...pair, a: { ...pair.a, line: 0 } })).toBe(false);
    expect(check({ ...pair, exchangeId: 376 })).toBe(false); // no database IDs
  });
});
