import { describe, expect, it } from "vitest";
import { readAnswer, readRecollection } from "../../server/src/claims";

const Q = "Did you approve the transaction?";

describe("readAnswer", () => {
  it("reads plain affirmatives as affirming", () => {
    for (const a of ["Yes.", "Yes, sir.", "Correct.", "That's right.", "I did.", "Yes, they do.", "Absolutely."]) {
      expect(readAnswer(Q, a), a).toBe("affirms");
    }
  });

  it("reads plain negatives as denying, never as agreement", () => {
    for (const a of ["No.", "No, sir.", "Incorrect.", "I did not.", "Never.", "No. No.", "No, it does not."]) {
      expect(readAnswer(Q, a), a).toBe("denies");
    }
  });

  it("leaves anything else uncertain", () => {
    for (const a of ["Yes, but only in Europe.", "I believe so.", "Not exactly.", "Uh-huh.", "In a narrow sense.", "Yes. No.", ""]) {
      expect(readAnswer(Q, a), a).toBe("uncertain");
    }
  });

  it("reads an explicit denial, with or without an elaboration that keeps denying, as a denial", () => {
    for (const a of ["No, never.", "Never, sir.", "Absolutely not.", "No, I never did.", "No, never. I don't even know where that is.", "No. I'd never heard of him before this whole thing started."]) {
      expect(readAnswer("Have you ever been to the warehouse?", a), a).toBe("denies");
    }
  });

  it("reads an explicit affirmative with a plain elaboration as affirming", () => {
    for (const a of ["Yes, absolutely.", "Of course.", "Yes. I signed it in March."]) expect(readAnswer(Q, a), a).toBe("affirms");
  });

  it("keeps an elaboration that limits, hedges or reverses the answer uncertain", () => {
    for (const a of ["No. Only once, in 2001.", "No. Well, maybe once.", "No, I was alone.", "No. I was there in 2001.", "Yes. But not in March.", "Yes. I didn't read it.", "Yes. I think so.", "No. I don't recall."]) {
      expect(readAnswer("Have you ever been to the warehouse?", a), a).toBe("uncertain");
    }
  });

  it("treats a bare yes or no to a negative or tag question as uncertain", () => {
    expect(readAnswer("You didn't sign it, did you?", "No.")).toBe("uncertain");
    expect(readAnswer("You never met him?", "Yes.")).toBe("uncertain");
    expect(readAnswer("You signed it, right?", "Yes.")).toBe("uncertain");
  });
});

describe("readRecollection", () => {
  it("tells not knowing from not remembering, for a whole answer of nothing else", () => {
    for (const a of ["I don't know.", "I'm not sure.", "Sir, I don't know that."]) expect(readRecollection(a), a).toBe("does_not_know");
    for (const a of ["I don't recall.", "I don't remember.", "I can't recall that."]) expect(readRecollection(a), a).toBe("does_not_recall");
  });

  it("is null for anything more, so it never reads content as a lack of memory", () => {
    for (const a of ["I don't recall seeing the document.", "I don't know. Maybe in May.", "Yes.", "I don't know that for a fact, but it went to Safra."]) {
      expect(readRecollection(a), a).toBeNull();
    }
  });
});
