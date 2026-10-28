import { describe, expect, it } from "vitest";
import { proceduralReason } from "../../server/src/retrieve";

describe("proceduralReason", () => {
  it("skips objection-only, exhibit-marking and colloquy exchanges", () => {
    for (const kind of ["objection", "exhibit", "colloquy"] as const) {
      expect(proceduralReason({ kind, questionText: "" })).toBe("not_testimony");
    }
  });

  it("skips questions about the witness's name and address", () => {
    expect(proceduralReason({ kind: "qa", questionText: "Would you state your full name for the record?" })).toBe("name_or_address");
    expect(proceduralReason({ kind: "qa", questionText: "And your business address?" })).toBe("name_or_address");
  });

  it("keeps testimony, including questions that merely mention a name", () => {
    expect(proceduralReason({ kind: "qa", questionText: "Did you approve the SAP acquisition?" })).toBeNull();
    expect(proceduralReason({ kind: "qa", questionText: "What is the name of the product?" })).toBeNull();
  });
});
