import { describe, expect, it } from "vitest";
import { readCrossLabelFile, resolveAnchor, wholeAnswer } from "../../server/src/eval/crossLabels";

describe("cross-witness label files", () => {
  it("reads both sets, each side being the named witness's testimony", async () => {
    const simpson = await readCrossLabelFile("data/eval/simpson-resnick-cross-v1.json");
    expect(simpson.comparisons[0].pairs.map((p) => [p.id, p.expected])).toEqual([["CW-001", "conflict_needs_context"], ["CW-002", "conflict_needs_context"], ["NC-001", "no_conflict"], ["NC-002", "no_conflict"]]);
    const synthetic = await readCrossLabelFile("data/eval/synthetic-cross-v1.json");
    expect(synthetic.comparisons.flatMap((c) => c.pairs).map((p) => p.id)).toEqual(["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"]);
  });

  it("keeps the reviewed Simpson set in its four groups, with its exclusions recorded", async () => {
    const v2 = await readCrossLabelFile("data/eval/simpson-resnick-cross-v2.json");
    const group = (e: string) => v2.comparisons[0].pairs.filter((p) => p.expected === e).map((p) => p.id);
    expect(group("conflict")).toEqual([]);
    expect(group("conflict_needs_context")).toEqual(["C01", "C02", "CW-001"]);
    expect(group("no_conflict")).toHaveLength(13);
    expect(group("exploratory")).toEqual(["C04", "C05", "N09", "CW-002"]);
    expect(v2.exclusions?.map((e) => e.id)).toEqual(["C09", "N06"]);
  });

  it("keeps every synthetic version: v1 and v2 unchanged, v3 with its policy and a changelog entry for every change", async () => {
    const [v1, v2, v3] = await Promise.all(["v1", "v2", "v3"].map((v) => readCrossLabelFile(`data/eval/synthetic-cross-${v}.json`)));
    const groups = (f: typeof v3) => f.comparisons.flatMap((c) => c.pairs).reduce<Record<string, string[]>>((g, p) => ({ ...g, [p.expected]: [...(g[p.expected] ?? []), p.id] }), {});
    expect(groups(v1).conflict).toEqual(["c1", "c2", "c4", "c5", "c6", "c7", "c8"]);
    expect(groups(v2).no_conflict).toEqual(["c1", "c2"]);
    expect(groups(v3)).toEqual({ no_conflict: ["c1", "c2", "c3", "c4", "c7"], conflict: ["v3-video", "c5"], conflict_needs_context: ["c6", "c8", "v3-csv", "v3-mfa"] });
    expect(v3.supersedes).toBe("synthetic-cross-v2");
    expect(v3.policy?.[0]).toMatch(/same event or proposition under the same relevant conditions/);
    const before = new Map(v1.comparisons.flatMap((c) => c.pairs).map((p) => [p.id, p.expected]));
    for (const p of v3.comparisons.flatMap((c) => c.pairs)) {
      const changed = before.get(p.id) !== p.expected;
      if (changed) expect(v3.changelog?.some((e) => e.id === p.id && e.to === p.expected), p.id).toBe(true);
    }
  });

  it("resolves an anchor by printed line numbers or by an exact phrase, and never by a near match", () => {
    const lines = [{ id: 10, page: 0, line: 1654, text: "A: Because Nicole was saying she was having a nervous breakdown" }, { id: 11, page: 0, line: 1655, text: "Q: What did you do?" }];
    expect(resolveAnchor({ document: "d", lines: [1654, 1700] }, lines)).toEqual([10]);
    expect(resolveAnchor({ document: "d", phrase: "having a  Nervous breakdown" }, lines)).toEqual([10]);
    expect(resolveAnchor({ document: "d", phrase: "a nervous collapse" }, lines)).toEqual([]);
  });

  it("needs the part in an archive whose count starts again, where a number names several statements", () => {
    const parts = [{ id: 1, page: 1, line: 233, text: "A: first run" }, { id: 2, page: 3, line: 233, text: "A: third run" }];
    expect(resolveAnchor({ document: "d", lines: [233] }, parts)).toEqual([]);
    expect(resolveAnchor({ document: "d", part: 3, lines: [233] }, parts)).toEqual([2]);
  });

  it("finds a quotation that wraps over lines, and grows an anchor to the witness's whole answer", () => {
    const lines = [
      { id: 1, page: 3, line: 23, text: "Q. How did the brakes feel?", role: "attorney" },
      { id: 2, page: 3, line: 24, text: "A. Soft. Pedal went most of the way to the floor", role: "witness" },
      { id: 3, page: 3, line: 25, text: "before it grabbed. I had reported it the week before.", role: "witness" },
      { id: 4, page: 4, line: 1, text: "Q. To whom?", role: "attorney" },
    ];
    expect(resolveAnchor({ document: "d", phrase: "most of the way to the floor before it grabbed" }, lines)).toEqual([2, 3]);
    expect(resolveAnchor({ document: "d", phrase: "Soft. Pedal" }, lines)).toEqual([2]);
    expect(wholeAnswer([2], lines)).toEqual([2, 3]);
    expect(wholeAnswer([1], lines)).toEqual([1]); // a question line stays as it is
  });
});
