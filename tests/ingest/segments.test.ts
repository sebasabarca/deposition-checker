// Speaker changes inside one archive statement, on REAL statements quoted exactly from the
// Simpson-Resnick archive exports (data/raw/simpson/). A statement is split only at a label the
// archive format makes certain; initials, quoted read-backs and a single label are never split.
import { describe, expect, it } from "vitest";
import { speakerSegments } from "../../server/src/ingest/segments";

const split = (text: string, witnessSurname: string) => speakerSegments(text, witnessSurname).map((s) => [s.role, text.slice(s.start, s.end)]);

describe("speaker segments in an archive statement", () => {
  it("splits a question and its answer on one statement (Resnick, direct, 783 and 978)", () => {
    expect(split("Q: Now, do you remember the car O.J. Simpson drove up in? A.Yes, I do.", "resnick")).toEqual([
      ["attorney", "Q: Now, do you remember the car O.J. Simpson drove up in?"],
      ["witness", "A.Yes, I do."],
    ]);
    expect(split("Q: You may answer. A.Yes, I do.", "resnick")).toEqual([["attorney", "Q: You may answer."], ["witness", "A.Yes, I do."]]);
  });

  it("splits an answer from the next question (Resnick, cross, 189)", () => {
    expect(split("A: Yes, it was. Q. Do you remember which one it was or where it was in relation to your room?", "resnick")).toEqual([
      ["witness", "A: Yes, it was."],
      ["attorney", "Q. Do you remember which one it was or where it was in relation to your room?"],
    ]);
  });

  it("keeps an objection apart from the question or answer around it (Resnick, direct, 268 and 1118)", () => {
    expect(split("Q: Do you know whether Nicole was abusing drugs in the period January through June of 1994? MR. LEONARD: Objection.", "resnick")).toEqual([
      ["attorney", "Q: Do you know whether Nicole was abusing drugs in the period January through June of 1994?"],
      ["colloquy", "MR. LEONARD: Objection."],
    ]);
    expect(split("MR. LEONARD: Objection. A. No. No, he did not. Nicole - he did not come back, he actually - no, he did not come back.", "resnick")).toEqual([
      ["colloquy", "MR. LEONARD: Objection."],
      ["witness", "A. No. No, he did not. Nicole - he did not come back, he actually - no, he did not come back."],
    ]);
  });

  it("reads the witness's own name label and an examiner's line (Simpson, January 23, 218 and 226)", () => {
    expect(split("O.J. SIMPSON: No. BY MR. PETROCELLI: Q: The answer is you were not?", "simpson")).toEqual([
      ["witness", "O.J. SIMPSON: No."],
      ["colloquy", "BY MR. PETROCELLI:"],
      ["attorney", "Q: The answer is you were not?"],
    ]);
    expect(split("ROBERT BAKER: I am instructing you not to-- BY MR. PETROCELLI: Q: Did you take--", "simpson")).toEqual([
      ["colloquy", "ROBERT BAKER: I am instructing you not to--"],
      ["colloquy", "BY MR. PETROCELLI:"],
      ["attorney", "Q: Did you take--"],
    ]);
  });

  it("reads an examiner's label with words after it as the examiner asking (Simpson, February 27, 2385)", () => {
    expect(split("MR. ROBERT BAKER: Don't- BY MR. KELLY: Okay. And that actually wasn't true, then, when you told Lange and Vannatter that you had bought it for Nicole, was it?", "simpson")).toEqual([
      ["colloquy", "MR. ROBERT BAKER: Don't-"],
      ["attorney", "BY MR. KELLY: Okay. And that actually wasn't true, then, when you told Lange and Vannatter that you had bought it for Nicole, was it?"],
    ]);
  });

  it("splits a counsel's remark after an answer (Simpson, February 27, 347)", () => {
    expect(split("A: No. MR. KELLY: Wasn't it? Was it downtown?", "simpson")).toEqual([["witness", "A: No."], ["colloquy", "MR. KELLY: Wasn't it? Was it downtown?"]]);
  });

  it("never splits initials, a full-name label, or a quoted read-back", () => {
    expect(split("A: They were - they had been friends for many, many years. They - besides A.C. Cowlings, probably his second best friend.", "resnick")).toEqual([]);
    expect(split("MR. PHILLIP BAKER: Phil Baker for O.J. Simpson.", "simpson")).toEqual([]);
    expect(split(`DAN LEONARD: And the answer. (Record read as follows: "Q. You mentioned before that he said something about noises. What did he say about noises? "A. He heard something. 'Did you feel an earthquake'--")`, "resnick")).toEqual([]);
  });

  it("keeps a label one or two letters from the witness's name unknown, never the witness", () => {
    expect(split("A: No. O.J. SIMPON: Yes.", "simpson")).toEqual([["witness", "A: No."], ["unknown", "O.J. SIMPON: Yes."]]);
  });

  it("covers the whole statement, in order, with nothing but the spaces between segments left out", () => {
    const text = "O.J. SIMPSON: No. BY MR. PETROCELLI: Q: The answer is you were not?";
    const segments = speakerSegments(text, "simpson");
    expect(segments[0].start).toBe(0);
    expect(segments.at(-1)!.end).toBe(text.length);
    for (let i = 1; i < segments.length; i++) expect(text.slice(segments[i - 1].end, segments[i].start).trim()).toBe("");
  });
});
