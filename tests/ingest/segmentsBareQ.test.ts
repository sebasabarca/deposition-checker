// Parser revision 12 (segments-v2): a bare "Q" inside an archive statement starts the examiner's turn. The 11
// confirmed cases are the exact stored lines of the Simpson and Resnick archive transcripts (public record) in
// tests/fixtures/segments-v2-confirmed.json. Also how a packet shows a statement shared by two exchanges.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatPacket, ownedTurns, type Packet, type PacketExchange } from "../../server/src/adjudicate/packet";
import { surnameOf, type SpeakerRole } from "../../server/src/ingest/exchanges";
import { speakerSegments } from "../../server/src/ingest/segments";

type Case = { witness: string; ref: string; text: string; after: { role: SpeakerRole; text: string }[] };
const cases = (JSON.parse(readFileSync("tests/fixtures/segments-v2-confirmed.json", "utf8")) as { cases: Case[] }).cases;
const turns = (text: string, witness = "Dana Reyes") => speakerSegments(text, surnameOf(witness)).map((s) => ({ role: s.role, text: text.slice(s.start, s.end) }));

describe("bare Q (revision 12)", () => {
  it.each(cases.map((c) => [c.ref, c] as const))("%s: the lawyer's question gets its own turn, and the text is intact", (_ref, c) => {
    expect(cases).toHaveLength(11);
    const segs = speakerSegments(c.text, surnameOf(c.witness));
    expect(turns(c.text, c.witness)).toEqual(c.after);
    expect(segs.at(-1)!.role).toBe("attorney");
    expect(segs.map((s) => c.text.slice(s.start, s.end)).join(" ")).toBe(c.text.replace(/\s+/g, " ")); // nothing lost or doubled
  });

  it("never splits a bare A (an English word), a Q inside quotes or parentheses, or a Q not before a capital", () => {
    expect(turns("A: Yes. A man came in.")).toEqual([]);
    expect(turns('A: He said "Yes. Q Did you go?" to me.')).toEqual([]);
    expect(turns("A: I said (no. Q Right?) then.")).toEqual([]);
    expect(turns("A: Yes. Q and then?")).toEqual([]);
  });

  it("labelled turns are read as before, and a bare Q after them still splits", () => {
    expect(turns("Q: Did the crane move? A.Yes, it did.")).toEqual([{ role: "attorney", text: "Q: Did the crane move?" }, { role: "witness", text: "A.Yes, it did." }]);
    expect(turns("A: No. Q And the dog?")).toEqual([{ role: "witness", text: "A: No." }, { role: "attorney", text: "Q And the dog?" }]);
  });
});

describe("a shared statement in a packet (spans-v1)", () => {
  const text = "A: Cocaine, no. Q You've never seen her use it. Correct?";
  const segs = speakerSegments(text, "simpson").map((s, seq) => ({ seq, start: s.start, end: s.end }));

  it("shows each exchange only the turns it owns, as a slice of the stored text", () => {
    expect(ownedTurns(text, segs, { from: 0, to: 0 })).toEqual({ text: "A: Cocaine, no.", span: { first: 1, last: 1, of: 2 } });
    expect(ownedTurns(text, segs, { from: 1, to: 1 })).toEqual({ text: "Q You've never seen her use it. Correct?", span: { first: 2, last: 2, of: 2 } });
    expect(ownedTurns(text, segs, { from: 0, to: 1 })).toEqual({ text }); // owns every turn: the whole statement
    expect(ownedTurns(text, segs, null)).toEqual({ text });
  });

  it("marks the part on its page:line, so the question is never shown inside the answer", () => {
    const side = (session: "A" | "B", lines: PacketExchange["lines"]): PacketExchange => ({ id: `E${session === "A" ? 1 : 2}`, depositionId: 1, groupId: 1, session, takenOn: null, witnessId: 1, partIds: [1], wholeExchange: true, lines, before: [], after: [], gapBefore: false, gapAfter: false });
    const packet: Packet = {
      candidateId: 1, witnessId: 1, witnessName: "Dana Reyes",
      a: side("A", [{ id: 1, page: 1, line: 359, text: "Q: Did you see her use cocaine?", role: "question" }, { id: 2, page: 1, line: 360, role: "answer", ...ownedTurns(text, segs, { from: 0, to: 0 }) }]),
      b: side("B", [{ id: 2, page: 1, line: 360, role: "question", ...ownedTurns(text, segs, { from: 1, to: 1 }) }, { id: 3, page: 1, line: 361, text: "A: Never.", role: "answer" }]),
    };
    const shown = formatPacket(packet);
    expect(shown).toContain("  1:360 (part 1 of 2)  A: Cocaine, no.\n");
    expect(shown).toContain("  1:360 (part 2 of 2)  Q You've never seen her use it. Correct?\n");
    expect(shown).not.toContain("A: Cocaine, no. Q You've");
  });
});
