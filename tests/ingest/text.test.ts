// Text transcripts: numbered text keeps its page:line, unnumbered text is accepted and cited by line.
import { describe, expect, it } from "vitest";
import { isText, readTextPages, TEXT_NUMBERED_V1, TEXT_UNNUMBERED_V1, UNNUMBERED_PAGE } from "../../server/src/ingest";
import { readDeposition } from "../../server/src/ingest";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("text transcripts", () => {
  it("tells text from binary", () => {
    expect(isText(bytes("Q. Where were you?\nA. Home."))).toBe(true);
    expect(isText(new Uint8Array([0x51, 0x00, 0x41]))).toBe(false);
    expect(isText(new Uint8Array([0xff, 0xfe, 0xfd]))).toBe(false);
    expect(isText(new Uint8Array())).toBe(false);
  });

  it("keeps the transcript's own page and line numbers, starting a page where the gutter restarts", () => {
    const text = ["Page 11", " 1   Q.  Where were you that morning?", " 2   A.  At the depot.", " 3", "", "Page 12", " 1   Q.  Alone?", " 2   A.  Yes.", "Webb Deposition", " 1   Q.  And then?"].join("\n");
    const { layout, pages } = readTextPages(text);
    expect(layout).toBe(TEXT_NUMBERED_V1);
    expect(pages.map((p) => [p.printedPage, p.lines.length])).toEqual([[11, 3], [12, 2], [13, 1]]);
    expect(pages[0].lines[1]).toMatchObject({ printedPage: 11, lineNo: 2, rawText: "A.  At the depot.", indentX: 0 });
    expect(pages[0].lines[2].rawText).toBe(""); // a numbered blank line is kept, so lines stay contiguous
    expect(pages[1].unnumbered).toEqual(["Webb Deposition"]);
  });

  it("accepts text without numbers and numbers its non-empty lines on page 0", () => {
    const { layout, pages } = readTextPages("Q. Where were you?\n\nA. At home, I think.\nMR. LEE: Objection.\n");
    expect(layout).toBe(TEXT_UNNUMBERED_V1);
    expect(pages).toHaveLength(1);
    expect(pages[0].lines.map((l) => [l.printedPage, l.lineNo, l.rawText])).toEqual([[UNNUMBERED_PAGE, 1, "Q. Where were you?"], [UNNUMBERED_PAGE, 2, "A. At home, I think."], [UNNUMBERED_PAGE, 3, "MR. LEE: Objection."]]);
  });

  it("reads text through the same pipeline as a PDF, into attributed lines and exchanges", async () => {
    const read = await readDeposition(bytes(" 1   Q.  Where were you that morning?\n 2   A.  At the depot on Kerr Street.\n 3   Q.  Alone?\n 4   A.  Yes."), undefined, undefined, "Marcus Webb");
    expect(read.format).toBe("text");
    expect(read.validation).toMatchObject({ status: "ready", layout: "text-numbered-v1", pageCount: 1 });
    expect(read.exchanges!.lines.map((l) => l.role)).toEqual(["attorney", "witness", "attorney", "witness"]);
    expect(read.exchanges!.exchanges.length).toBe(2);
  });

  it("reports empty text as unsupported instead of failing", async () => {
    const read = await readDeposition(bytes("   \n\n"));
    expect(read.validation.status).toBe("unsupported");
  });
});
