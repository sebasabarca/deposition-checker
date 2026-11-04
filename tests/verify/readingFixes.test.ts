// Regressions from a pilot on real transcripts (archive text and OCR PDFs): OCR pipes, speaker labels,
// question-negation scope, confirming tags and clause-level hedges. Pure: no database.

import { describe, expect, it } from "vitest";
import { findHedge, matchScore, readAnswer, spoken } from "../../server/src/verify";

describe("OCR pipes", () => {
  it("reads an answer with a stray OCR pipe as the plain answer it is", () => {
    expect(readAnswer("Did you go?", spoken("A |didn't."))).toBe("denies");
    expect(readAnswer("Did you go?", spoken("A. | No."))).toBe("denies");
    expect(readAnswer("Did you go?", "Yes. ¦")).toBe("affirms");
    expect(spoken("A |didn't.")).toBe("I didn't.");
  });

  it("still fails a phrase that isn't in the line", () => {
    expect(matchScore("I went to the warehouse", spoken("A |didn't."))).toBe(0);
  });
});

describe("speaker labels", () => {
  it("strips labels at the start of a line", () => {
    for (const [line, said] of [
      ["A: Yes.", "Yes."],
      ["Q: Did you go?", "Did you go?"],
      ["0: Did you go?", "Did you go?"],
      ["O.J. SIMPSON: No.", "No."],
      ["MS. HUTCHINSON: I did.", "I did."],
      ["Ms. Hutchinson: I did.", "I did."],
      ["Ms. Hutchinson. I did.", "I did."],
      ["THE WITNESS: Yes.", "Yes."],
    ]) expect(spoken(line), line).toBe(said);
  });

  it("never strips an ordinary sentence start", () => {
    for (const line of ["Mr. Smith went home.", "Ms. Hutchinson went to the office.", "And A: is the answer.", "No, I did not.", "I: did not."]) expect(spoken(line), line).toBe(line);
  });
});

describe("question negation scope", () => {
  it("ignores a negation only in the attorney's preamble", () => {
    expect(readAnswer("You said you weren't there. Did he call you that night?", "No.")).toBe("denies");
    expect(readAnswer("You said you weren't there. Did he call you that night?", "Yes.")).toBe("affirms");
  });

  it("keeps a negative interrogative uncertain", () => {
    expect(readAnswer("Didn't he call you?", "No.")).toBe("uncertain");
    expect(readAnswer("Let me ask it again. Isn't it true that Mr. Smith called?", "Yes.")).toBe("uncertain");
    expect(readAnswer("You were not there. Is that right?", "No.")).toBe("uncertain");
  });
});

describe("confirming tags", () => {
  it("reads a plain yes or no to a positive statement with a confirming tag", () => {
    for (const q of ["You went there, correct?", "You went there, right?", "You went there, isn't that right?", "You went there, true?", "You went there. Is that correct?"]) {
      expect(readAnswer(q, "Yes."), q).toBe("affirms");
      expect(readAnswer(q, "That's correct."), q).toBe("affirms");
      expect(readAnswer(q, "No."), q).toBe("denies");
    }
  });

  it("keeps a negative statement with a tag, and mixed or qualified answers, uncertain", () => {
    expect(readAnswer("You didn't go, did you?", "No.")).toBe("uncertain");
    expect(readAnswer("You didn't go, correct?", "Yes.")).toBe("uncertain");
    expect(readAnswer("You went there, didn't you?", "Yes.")).toBe("uncertain");
    expect(readAnswer("You went there, correct?", "Yes. No.")).toBe("uncertain");
    expect(readAnswer("You went there, correct?", "Yes, but only once.")).toBe("uncertain");
  });
});

describe("clause-level hedges", () => {
  it("applies a hedge only to its own clause", () => {
    expect(findHedge("I never went back", "I left at 9, perhaps 9:15, and I never went back.")).toBeNull();
    expect(findHedge("I never went back", "I left at 9 perhaps but I never went back.")).toBeNull();
    expect(findHedge("I left at 9", "I left at 9, perhaps 9:15, and I never went back.")).toBeNull();
    expect(findHedge("9:15", "I left at 9, perhaps 9:15, and I never went back.")).toBe("perhaps");
  });

  it("keeps a disclaimer that governs the next clause", () => {
    expect(findHedge("it has to go to Safra Catz", "I don't know that for a fact, but it has to go to Safra Catz.")).toBe("i don t know that for a fact");
    expect(findHedge("it has to go to Safra Catz", "I'm not sure but it has to go to Safra Catz.")).toBe("i m not sure");
    expect(findHedge("I signed it in March", "I think I signed it in March, and I kept a copy.")).toBe("i think");
  });
});
