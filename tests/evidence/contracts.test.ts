// The evidence module's pure contracts: references in each transcript's own scheme, and the stable key,
// text hash and speaker status of an exchange, from its lines alone. Synthetic inputs throughout.
import { describe, expect, it } from "vitest";
import { evidenceFieldsOf, evidenceKeyOf, formatRef, isCitable, schemeOf, sourceLineId, speakerStatusOf, textHashOf, type MemberLine } from "../../server/src/evidence";
import { piecesOf } from "../../server/src/evidence/exchange";

const SHA = "a".repeat(64);
const line = (page: number, l: number, lineRole: string, speakerRole: string, text = `text ${page}:${l}`): MemberLine => ({ page, line: l, text, lineRole, speakerRole });

describe("references keep each transcript's own scheme", () => {
  it("maps every known layout, and nothing unknown to a citable page:line", () => {
    expect(["ellison-doj-v1", "scanned-25-v1", "text-numbered-v1"].map(schemeOf)).toEqual(["page_line", "page_line", "page_line"]);
    expect(schemeOf("text-unnumbered-v1")).toBe("file_line");
    expect(schemeOf("pdf-physical-v1")).toBe("physical_line");
    expect(schemeOf("text-archive-lines-v1")).toBe("archive_statement");
    expect(schemeOf("some-new-layout")).toBe("unrecognized");
    expect(schemeOf(null)).toBe("unrecognized");
    expect(["file_line", "physical_line", "archive_statement", "unrecognized"].map((s) => isCitable(s as never))).toEqual([false, false, false, false]);
  });

  it("formats a position as its scheme, never inventing a page:line", () => {
    expect(formatRef("page_line", 6, 4)).toBe("6:04");
    expect(formatRef("file_line", 0, 12)).toBe("line 12");
    expect(formatRef("physical_line", 3, 7)).toBe("page 3, row 7");
    expect(formatRef("archive_statement", 0, 782)).toBe("statement 782");
    expect(formatRef("archive_statement", 1, 561)).toBe("statement 561");
    expect(formatRef("archive_statement", 2, 5)).toBe("statement 5 (part 2)");
    for (const scheme of ["file_line", "physical_line", "archive_statement", "unrecognized"] as const) expect(formatRef(scheme, 6, 4)).not.toMatch(/^\d+:\d+$/);
  });

  it("identifies a source line by its file and position, not its database row", () => {
    expect(sourceLineId(SHA, 6, 4)).toBe(`src_${"a".repeat(16)}_6_4`);
    expect(sourceLineId(SHA, 6, 4)).not.toBe(sourceLineId("b".repeat(64), 6, 4));
  });
});

describe("an exchange's evidence fields", () => {
  const qa = [line(1, 3, "question", "attorney"), line(1, 4, "answer", "witness"), line(2, 1, "answer", "witness")];

  it("gives the same key to the same file and boundaries, and a new one when either changes", () => {
    expect(evidenceKeyOf(SHA, { page: 1, line: 3 }, { page: 2, line: 1 })).toMatch(/^ex_[0-9a-f]{24}$/);
    expect(evidenceKeyOf(SHA, { page: 1, line: 3 }, { page: 2, line: 1 })).toBe(evidenceKeyOf(SHA, { page: 1, line: 3 }, { page: 2, line: 1 }));
    expect(evidenceKeyOf(SHA, { page: 1, line: 3 }, { page: 2, line: 2 })).not.toBe(evidenceKeyOf(SHA, { page: 1, line: 3 }, { page: 2, line: 1 }));
    expect(evidenceKeyOf("b".repeat(64), { page: 1, line: 3 }, { page: 2, line: 1 })).not.toBe(evidenceKeyOf(SHA, { page: 1, line: 3 }, { page: 2, line: 1 }));
  });

  it("hashes the lines in transcript order, so any change to their text or position shows", () => {
    const f = evidenceFieldsOf(SHA, "qa", qa);
    expect(evidenceFieldsOf(SHA, "qa", [...qa].reverse())).toEqual(f); // order of input doesn't matter
    expect(textHashOf([qa[0], qa[1], { ...qa[2], text: "text 2:1." }])).not.toBe(f.textHash);
    expect(textHashOf([qa[0], qa[1], { ...qa[2], line: 2 }])).not.toBe(f.textHash);
  });

  it("verifies an answer only when every answer line is the witness's and nothing is unattributed", () => {
    expect(speakerStatusOf("qa", qa)).toEqual({ status: "verified", reasons: [] });
    expect(speakerStatusOf("qa", [...qa, line(2, 2, "unknown", "unknown")]).status).toBe("uncertain");
    expect(speakerStatusOf("qa", [qa[0], line(1, 4, "answer", "unknown")]).status).toBe("uncertain");
    expect(speakerStatusOf("qa", [line(1, 1, "unknown", "unknown")]).status).toBe("uncertain"); // text with no speaker may be the witness's
  });

  it("calls an answer invalid only when it is provably not the witness's", () => {
    expect(speakerStatusOf("qa", [qa[0]])).toMatchObject({ status: "invalid", reasons: ["no answer lines"] }); // attorney only
    expect(speakerStatusOf("qa", [qa[0], line(1, 4, "answer", "attorney")]).status).toBe("invalid");
    expect(speakerStatusOf("objection", qa).status).toBe("invalid");
    expect(speakerStatusOf("colloquy", qa).status).toBe("invalid");
  });

  it("refuses an exchange with no lines rather than inventing a key", () => {
    expect(() => evidenceFieldsOf(SHA, "qa", [])).toThrow(/no lines/);
  });
});

describe("an archive statement that holds two turns (Resnick, direct, 783)", () => {
  const text = "Q: Now, do you remember the car O.J. Simpson drove up in? A.Yes, I do.";
  const split = { page: 0, line: 783, text, lineRole: "question", speakerRole: "attorney", segments: [{ role: "attorney", start: 0, end: 57 }, { role: "witness", start: 58, end: 70 }] };

  it("reads its witness segment as the answer and its attorney segment as the question, text untouched", () => {
    expect(piecesOf([split]).map((p) => [p.speaker, p.text, p.answer, p.question])).toEqual([
      ["attorney", "Q: Now, do you remember the car O.J. Simpson drove up in?", false, true],
      ["witness", "A.Yes, I do.", true, false],
    ]);
    expect(speakerStatusOf("qa", [split])).toEqual({ status: "verified", reasons: [] });
    // Without segments the same line is a question with no answer.
    expect(speakerStatusOf("qa", [{ ...split, segments: undefined }]).status).toBe("invalid");
  });

  it("keeps an answer line's attorney segment out of the answer, and an unknown segment uncertain", () => {
    const answerThenQuestion = { page: 0, line: 189, text: "A: Yes, it was. Q. Do you remember which one it was?", lineRole: "answer", speakerRole: "witness", segments: [{ role: "witness", start: 0, end: 15 }, { role: "attorney", start: 16, end: 52 }] };
    expect(piecesOf([answerThenQuestion]).filter((p) => p.answer).map((p) => p.text)).toEqual(["A: Yes, it was."]);
    expect(speakerStatusOf("qa", [answerThenQuestion]).status).toBe("verified");
    const unknown = { ...answerThenQuestion, segments: [{ role: "witness", start: 0, end: 15 }, { role: "unknown", start: 16, end: 52 }] };
    expect(speakerStatusOf("qa", [unknown]).status).toBe("uncertain");
  });

  it("hashes the line's text, not its segments", () => {
    expect(textHashOf([split])).toBe(textHashOf([{ ...split, segments: undefined }]));
  });
});

