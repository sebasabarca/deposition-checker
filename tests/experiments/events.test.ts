// The event path's pure steps, with hand-built testimony.
import { describe, expect, it } from "vitest";
import { type Dataset, type Line, type Session } from "../../experiments/multimodel-contradictions/src/data";
import { alignPrompt, chunksOf, comparePrompt, coverage, groupLines, parseWith, MapOutput, placeEvents, reachesComparison, readGroups, type PlacedEvent } from "../../experiments/multimodel-contradictions/src/events";
import { readFileSync, readdirSync } from "node:fs";

const page = (p: number, n = 4): Line[] => Array.from({ length: n }, (_, i) => ({ ref: `${p}:0${i + 1}`, page: p, line: i + 1, speaker: "witness", text: `page ${p} line ${i + 1}` }));
const session = (label: "A" | "B", pages: number[]): Session => ({ label, description: `session ${label}`, lines: pages.flatMap((p) => page(p)) });
const d: Dataset = { id: "t", kind: "synthetic", witness: "W", sessions: [session("A", [1, 2, 3]), session("B", [7, 8])] };
const e = (id: string, from: number, to: number, procedural = false): PlacedEvent => ({ id, session: id[0] as "A", name: `event ${id}`, when: "not stated", people: [], from, to, procedural });
const raw = (name: string, first: string, last: string, procedural = false) => ({ name, when: "x", people: [], first, last, procedural });

describe("event path", () => {
  it("chunks overlap by a page and reach the last page", () => {
    const pages = chunksOf(session("A", [1, 2, 3, 4, 5, 6, 7]).lines, 3, 1).map((c) => [...new Set(c.map((l) => l.page))]);
    expect(pages).toEqual([[1, 2, 3], [3, 4, 5], [5, 6, 7]]);
  });

  it("keeps a span from outside its chunk as rejected, and counts a failed chunk", () => {
    const s = d.sessions[0];
    const chunks = [s.lines.slice(0, 4), s.lines.slice(4, 8), s.lines.slice(8)];
    const placed = placeEvents(s, chunks, [{ events: [raw("good", "1:01", "1:03"), raw("outside", "1:01", "2:01"), raw("backwards", "1:03", "1:01")] }, null, { events: [] }]);
    expect(placed.events.map((x) => [x.name, x.from, x.to])).toEqual([["good", 0, 2]]);
    expect(placed.rejected.map((x) => x.name)).toEqual(["outside", "backwards"]);
    expect(placed.failedChunks).toEqual([1]);
  });

  it("counts unplaced lines and their pages, and an event outranks procedure on the same line", () => {
    const c = coverage(d.sessions[0], [e("A1", 0, 3), e("A2", 2, 5, true)]);
    expect(c).toMatchObject({ lines: 12, event: 4, procedural: 2, unplaced: 6, unplacedPages: [2, 3] });
  });

  it("compares only groups with both sessions, and reports everything else", () => {
    const events = [e("A1", 0, 1), e("A2", 2, 3), e("A3", 4, 5), e("A4", 6, 7, true), e("B1", 0, 1)];
    const r = readGroups({ groups: [{ name: "both", a_ids: ["A1"], b_ids: [" B1 "] }, { name: "alone", a_ids: ["A2"], b_ids: [] }, { name: "invented", a_ids: ["Z9"], b_ids: [] }] }, events);
    expect(r.comparable.map((g) => g.name)).toEqual(["both"]);
    expect(r.oneSided.map((g) => g.name)).toEqual(["alone"]);
    expect(r.leftOut).toEqual(["A3"]);
    expect(r.unknownIds).toEqual(["Z9"]);
  });

  it("gives a group its spans with context, merged, and marks gaps", () => {
    const s = d.sessions[0];
    const text = groupLines(s, [e("A1", 0, 0), e("A2", 1, 1), e("A3", 10, 10)], 1);
    expect(text.split("\n[...]\n").map((part) => part.split("\n").length)).toEqual([3, 3]);
  });

  it("knows whether a target reaches one compared group", () => {
    const g = { id: "G1", name: "x", a: [e("A1", 0, 3)], b: [e("B1", 0, 3)] };
    expect(reachesComparison(g, d, { a: ["1:02"], b: ["7:01"] })).toBe(true);
    expect(reachesComparison(g, d, { a: ["2:01"], b: ["7:01"] })).toBe(false);
    expect(comparePrompt(d, g)).toContain("7:04 page 7 line 4");
  });

  it("leaves procedural events out of alignment", () => {
    expect(alignPrompt(d, [e("A1", 0, 1), e("A2", 2, 3, true)])).not.toContain("A2 |");
  });

  it("rejects a confidence number in model output", () => {
    expect(parseWith(MapOutput)(JSON.stringify({ events: [{ ...raw("x", "1:01", "1:02"), confidence: 90 }] })).output).toBeNull();
  });

  // The prompts were written after seeing one real miss: they must stay general, not name its answer.
  it("mentions no detail of the known case in any event prompt", () => {
    const dir = "experiments/multimodel-contradictions/prompts/";
    for (const f of readdirSync(dir).filter((n) => n.startsWith("events-"))) expect(readFileSync(dir + f, "utf8")).not.toMatch(/beast|limo|suv|vehicle|\bcar\b|motorcade|errata/i);
  });
});
