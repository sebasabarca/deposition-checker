// Speaker labels the reader left unknown though their meaning is certain: a whole-line bracketed note
// at the question-and-answer indent (Hutchinson's "[2:05 p.m.]"), and an archive's full-name label for
// someone other than the witness (Simpson's "ROBERT BAKER:").
import { describe, expect, it } from "vitest";
import { markLine } from "../../server/src/ingest/exchanges";
import { SCANNED_25_V1 } from "../../server/src/ingest/ocr";
import { TEXT_ARCHIVE_V1, TEXT_NUMBERED_V1 } from "../../server/src/ingest/text";

describe("labels that were left unknown", () => {
  it("reads a whole-line bracketed note as a note at any indent", () => {
    expect(markLine("[2:05 p.m.]", 10, SCANNED_25_V1, "hutchinson", true).turn).toBe("parenthetical");
    expect(markLine("(Recess.)", 10, SCANNED_25_V1, "hutchinson", true).turn).toBe("parenthetical");
    expect(markLine("[5:22 p.m.]", null, SCANNED_25_V1, "hutchinson", true).turn).toBe("parenthetical"); // centred: no indent
    expect(markLine("[RRR SENIOR INVESTIGATIVE COUNSEL", 10, SCANNED_25_V1, "hutchinson", true).turn).not.toBe("parenthetical"); // not closed
  });

  it("reads an archive's full-name label as a named speaker other than the witness", () => {
    expect(markLine("ROBERT BAKER: Just wait a second.", 100, TEXT_ARCHIVE_V1, "simpson").turn).toBe("colloquy");
    expect(markLine("O.J. SIMPSON: No.", 100, TEXT_ARCHIVE_V1, "simpson").turn).toBe("A");
    expect(markLine("O.J. SIMPON: No.", 100, TEXT_ARCHIVE_V1, "simpson").turn).toBe("unrecognized"); // close to the witness's name
    expect(markLine("ROBERT BAKER: Just wait a second.", 100, TEXT_ARCHIVE_V1).turn).toBe("unrecognized"); // no known witness
    expect(markLine("ROBERT BAKER: Just wait a second.", 100, TEXT_NUMBERED_V1, "simpson").turn).toBe("unrecognized"); // other formats unchanged
  });
});
