// stretch-v2 rendering in transcript order (render r2): a passage's trailing context that runs past the next, short
// exchange must not be printed before that exchange. Hand-built inputs; no database, model or network.
import { describe, expect, it } from "vitest";
import type { IssuePacket, PacketPassage, PassageLine } from "../../server/src/adjudicate/packetPrompt";
import { formatStretchRequest, STRETCH_RENDER_R1, STRETCH_RENDER_R2 } from "../../server/src/adjudicate/stretchPrompt";

type Line = PacketPassage["lines"][number];
const L = (page: number, n: number, text: string, role: Line["role"] = "context", span?: Line["span"]): Line => ({ id: page * 100 + n, page, line: n, text, role, ...(span ? { span } : {}) });
const ctx = ({ role: _r, ...l }: Line): PassageLine => l;
const passage = (dep: number, group: number, lines: Line[], before: Line[] = [], after: Line[] = [], extra: Partial<PacketPassage> = {}): PacketPassage => ({
  key: `d${dep}#${group}`, id: `E${dep * 100 + group}`, depositionId: dep, groupId: group, witnessId: dep, witnessName: `Witness ${dep}`, session: `s${dep}`, takenOn: null,
  partIds: [dep * 100 + group], wholeExchange: true, lines, before: before.map(ctx), after: after.map(ctx), gapBefore: false, gapAfter: false, ...extra,
});
// The order of every page:line reference inside the stretches, as printed.
const refs = (text: string) => [...text.split("</stretch>")[0].matchAll(/^ {2}(\d+):(\d+)(?: \(part (\d+))?/gm)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)]);
const inOrder = (rs: number[][]) => rs.every((r, i) => i === 0 || r[0] > rs[i - 1][0] || (r[0] === rs[i - 1][0] && (r[1] > rs[i - 1][1] || (r[1] === rs[i - 1][1] && r[2] >= rs[i - 1][2]))));

// Deposition 1: exchange g1 at 1:01-02 whose 5-line after-window (1:03-1:07) runs past the short exchange g2
// (1:03-04); g3 starts on the next page. Deposition 2: one exchange, so the unit has two sides.
const T = {
  q1: L(1, 1, "Q. Where were you that night?", "question"), a1: L(1, 2, "A. At home.", "answer"),
  q2: L(1, 3, "Q. All night?", "question"), a2: L(1, 4, "A. Yes.", "answer"),
  c5: L(1, 5, "MR. SMITH: Objection."), c6: L(1, 6, "Q. Go ahead."), c7: L(1, 7, "THE WITNESS: I stayed in."),
  q3: L(2, 1, "Q. Who was with you?", "question"), a3: L(2, 2, "A. Nobody.", "answer"),
};
const D1 = [
  passage(1, 1, [T.q1, T.a1], [], [T.q2, T.a2, T.c5, T.c6, T.c7]),
  passage(1, 2, [T.q2, T.a2], [T.q1, T.a1], [T.c5, T.c6, T.c7, T.q3, T.a3]),
  passage(1, 3, [T.q3, T.a3], [T.a2, T.c5, T.c6, T.c7], [], { gapAfter: true }),
];
const D2 = [passage(2, 1, [L(9, 1, "Q. Were you home?", "question"), L(9, 2, "A. No, I went out.", "answer")])];
const packet: IssuePacket = { id: "S", passages: [...D1, ...D2], pairs: [{ pairId: "R1", a: "E101", b: "E201" }, { pairId: "R2", a: "E102", b: "E201" }, { pairId: "R3", a: "E103", b: "E201" }] };

describe("stretch rendering order", () => {
  it("r1 (the recorded renderer) prints a trailing context window before the next exchange", () => {
    expect(inOrder(refs(formatStretchRequest(packet, STRETCH_RENDER_R1)))).toBe(false);
  });

  it("r2 prints every stretch in transcript order, each line once, with exchanges, labels, speakers and gaps kept", () => {
    const text = formatStretchRequest(packet, STRETCH_RENDER_R2);
    const x1 = text.split("</stretch>")[0];
    expect(inOrder(refs(text))).toBe(true);
    expect(x1).toBe([
      '<stretch id="X1" witness="Witness 1" session="s1" taken_on="not stated">',
      "Exchange [E101] (1:01 to 1:02):\n  1:01  Q. Where were you that night?\n  1:02  A. At home.",
      "Exchange [E102] (1:03 to 1:04):\n  1:03  Q. All night?\n  1:04  A. Yes.",
      "Not citable:\n  1:05  MR. SMITH: Objection.\n  1:06  Q. Go ahead.\n  1:07  THE WITNESS: I stayed in.",
      "Exchange [E103] (2:01 to 2:02):\n  2:01  Q. Who was with you?\n  2:02  A. Nobody.",
      "[pages omitted from the transcript here]",
      "",
    ].join("\n"));
    // Each source line once, with its page:line and speaker text unchanged; units and pairs unchanged.
    for (const l of Object.values(T)) { const r = `  ${l.page}:${String(l.line).padStart(2, "0")}  `; expect(text.split("\n").filter((s) => s.startsWith(r))).toEqual([r + l.text]); }
    expect(text.split("UNIT U1")[1]).toBe(formatStretchRequest(packet, STRETCH_RENDER_R1).split("UNIT U1")[1]);
  });

  it("keeps a question before its answer inside its exchange, across a page break, and a part label on a split line", () => {
    const qa = [L(3, 25, "Q. And then?", "question"), L(4, 1, "A. I left.", "answer", { first: 1, last: 1, of: 2 })];
    const p = { ...packet, passages: [passage(1, 1, qa, [], [L(4, 2, "Q. When?"), L(4, 3, "A. Ten.")]), passage(1, 2, [L(4, 2, "Q. When?", "question")], [], [L(4, 3, "A. Ten.")]), ...D2] };
    const text = formatStretchRequest({ ...p, pairs: [{ pairId: "R1", a: "E101", b: "E201" }, { pairId: "R2", a: "E102", b: "E201" }] });
    expect(text).toContain("Exchange [E101] (3:25 to 4:01 (part 1 of 2)):\n  3:25  Q. And then?\n  4:01 (part 1 of 2)  A. I left.\nExchange [E102] (4:02 to 4:02):\n  4:02  Q. When?\nNot citable:\n  4:03  A. Ten.");
  });

  it("is byte-identical to r1 when r1 had no inversion, gap markers included", () => {
    const p = { ...packet, passages: [passage(1, 1, [T.q1, T.a1], [], [T.q2], { gapBefore: true }), passage(1, 3, [T.q3, T.a3], [T.c7], [], { gapAfter: true }), ...D2], pairs: [{ pairId: "R1", a: "E101", b: "E201" }, { pairId: "R2", a: "E103", b: "E201" }] };
    const r1 = formatStretchRequest(p, STRETCH_RENDER_R1);
    expect(inOrder(refs(r1))).toBe(true);
    expect(formatStretchRequest(p, STRETCH_RENDER_R2)).toBe(r1);
    expect(r1.indexOf("[pages omitted")).toBeLessThan(r1.indexOf("Exchange [E101]"));
    expect(formatStretchRequest(p)).toBe(r1);
  });

  it("drops a split line's whole text from the context once the stretch shows all its parts, and keeps it when a part is unshown", () => {
    const whole = L(5, 2, "A. Yes. Q. And then?");
    const p1 = passage(1, 1, [L(5, 1, "Q. Home?", "question"), { ...whole, text: "A. Yes.", role: "answer", span: { first: 1, last: 1, of: 2 } }], [], [whole]);
    const p2 = passage(1, 2, [{ ...whole, text: "Q. And then?", role: "question", span: { first: 2, last: 2, of: 2 } }, L(5, 3, "A. I left.", "answer")], [whole]);
    const both = formatStretchRequest({ ...packet, passages: [p1, p2, ...D2], pairs: [{ pairId: "R1", a: "E101", b: "E201" }, { pairId: "R2", a: "E102", b: "E201" }] });
    expect(both).toContain("Exchange [E101] (5:01 to 5:02 (part 1 of 2)):\n  5:01  Q. Home?\n  5:02 (part 1 of 2)  A. Yes.\nExchange [E102] (5:02 (part 2 of 2) to 5:03):");
    expect(both).not.toContain("A. Yes. Q. And then?");
    expect(formatStretchRequest({ ...packet, passages: [p1, p2, ...D2], pairs: [{ pairId: "R1", a: "E101", b: "E201" }, { pairId: "R2", a: "E102", b: "E201" }] }, STRETCH_RENDER_R1)).toContain("A. Yes. Q. And then?");
    const one = formatStretchRequest({ ...packet, passages: [p1, ...D2], pairs: [{ pairId: "R1", a: "E101", b: "E201" }] });
    expect(one).toContain("  5:02 (part 1 of 2)  A. Yes.\nNot citable:\n  5:02  A. Yes. Q. And then?");
  });
});
