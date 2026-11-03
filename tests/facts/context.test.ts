// Stage 2 units from stored Stage 1 evidence, on SYNTHETIC testimony: answer groups read once, speaker
// segments as their own spans, windows for oversized answers, and source hashes that change with the
// source.
import { describe, expect, it } from "vitest";
import { buildUnits, formatUnit, MAX_UNIT_CHARS, WINDOW_OVERLAP_SPANS } from "../../server/src/claims/facts";
import { doc, part } from "./build";

describe("answer-group units", () => {
  it("reads a long answer's overlapping parts as one unit, each line once, with the question", () => {
    const answers = Array.from({ length: 8 }, (_, i) => `A: answer line ${i + 1} about the harbour.`);
    const first = part(10, 1, 1, ["Q: Tell me about the harbour.", ...answers.slice(0, 6)]);
    // Part 2 repeats the question and the last two answer lines of part 1, as Stage 1 stores them.
    const second = part(11, 1, 1, ["Q: Tell me about the harbour.", ...answers], { partNo: 2 });
    second.members = second.members.filter((_, i) => i === 0 || i >= 5).map((m) => ({ ...m, lineId: 10 * 100 + (m.line - 1) }));
    const [unit, ...rest] = buildUnits(doc([first, second]));
    expect(rest).toEqual([]);
    expect(unit.spans.map((s) => s.position)).toEqual(Array.from({ length: 9 }, (_, i) => `1:${i + 1}`));
    expect(unit.exchangeIds).toEqual([10, 11]);
    expect(unit.testimony).toBe(true);
  });

  it("gives each speaker segment of a line its own span, so the attorney's words are never the witness's", () => {
    const ends = part(20, 1, 1, ["Q: Where were you?", { text: "A: At the office. Q. Who was there?", segments: [{ at: "A: At", role: "witness" }] }]);
    const starts = part(21, 2, 2, [{ text: "A: At the office. Q. Who was there?", role: "question", segments: [{ at: "Q. Who", role: "attorney" }] }, "A: The clerk."]);
    ends.members[1].segments = [{ seq: 0, start: 0, end: 17, role: "witness", name: null }];
    starts.members[0].lineId = ends.members[1].lineId;
    starts.members[0].segments = [{ seq: 1, start: 18, end: 35, role: "attorney", name: null }];
    const [a, b] = buildUnits(doc([ends, starts]));
    expect(a.spans.map((s) => [s.speaker, s.text])).toEqual([["attorney", "Q: Where were you?"], ["witness", "A: At the office."]]);
    expect(b.spans.map((s) => [s.speaker, s.text])).toEqual([["attorney", "Q. Who was there?"], ["witness", "A: The clerk."]]);
    expect(a.spans[1].sourceSpanId).toMatch(/_1_2#0$/);
    expect(b.spans[0].sourceSpanId).toMatch(/_1_2#1$/);
    // The next unit shows the end of the one before as context, which is never citable.
    expect(b.context.map((s) => s.text)).toEqual(a.spans.map((s) => s.text));
    expect(formatUnit(b, 0)).toMatch(/^C1 Q: Q: Where were you\?$/m);
  });

  it("records a group with no witness words as having no testimony", () => {
    const [unit] = buildUnits(doc([part(30, 1, 1, ["Q: Did the crane move?", "MR. QUILL: Objection, form."])]));
    expect(unit.testimony).toBe(false);
  });

  it("cuts an oversized answer into overlapping windows of whole spans, each repeating the question", () => {
    const long = Array.from({ length: 60 }, (_, i) => `A: ${`sentence ${i} about the ledger and the harbour office. `.repeat(8)}`);
    const units = buildUnits(doc([part(40, 1, 1, ["Q: Describe the ledger.", ...long])]));
    expect(units.length).toBeGreaterThan(1);
    for (const u of units) {
      expect(u.spans[0].text).toBe("Q: Describe the ledger.");
      expect(u.spans.reduce((n, s) => n + s.text.length + 1, 0)).toBeLessThanOrEqual(MAX_UNIT_CHARS);
      expect(u.windowCount).toBe(units.length);
    }
    const answerLines = (k: number) => units[k].spans.slice(1).map((s) => s.position);
    expect(answerLines(0).slice(-WINDOW_OVERLAP_SPANS)).toEqual(answerLines(1).slice(0, WINDOW_OVERLAP_SPANS));
    expect(new Set(units.flatMap((_, k) => answerLines(k))).size).toBe(60); // nothing lost
    expect(new Set(units.map((u) => u.unitKey)).size).toBe(units.length);
  });

  it("never cuts a single statement too long for a request: the unit is incomplete, its text whole", () => {
    const [unit] = buildUnits(doc([part(50, 1, 1, ["Q: Tell me everything.", `A: ${"word ".repeat(MAX_UNIT_CHARS / 4)}`])]));
    expect(unit.oversized).toMatch(/kept whole/);
    expect(unit.spans[1].text.length).toBeGreaterThan(MAX_UNIT_CHARS);
  });

  it("keeps unit keys stable and changes the source hash when a speaker changes", () => {
    const build = (speaker: string) => buildUnits(doc([part(60, 1, 1, ["Q: Who called?", { text: "A: The clerk did.", speaker }])]))[0];
    const [x, y] = [build("witness"), build("unknown")];
    expect(x.unitKey).toBe(y.unitKey);
    expect(x.sourceHash).not.toBe(y.sourceHash);
    expect(build("witness").sourceHash).toBe(x.sourceHash);
  });
});
