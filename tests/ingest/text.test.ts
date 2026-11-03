// Text transcripts: numbered text keeps its page:line, unnumbered text is accepted and cited by line.
import { describe, expect, it } from "vitest";
import { isText, readArchiveRecords, readTextPages, TEXT_NUMBERED_V1, TEXT_UNNUMBERED_V1, UNNUMBERED_PAGE } from "../../server/src/ingest";
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

  it("keeps an answer that runs onto the next page, even after a short page", async () => {
    // Page 19 ends at line 22, as in the Webb transcript; the answer finishes on 20:01.
    const page19 = Array.from({ length: 20 }, (_, i) => `${String(i + 1).padStart(2)}   Q. Question ${i + 1}?`).join("\n");
    const text = `Page 19\n${page19}\n21   Q. Had you met Daniel Cho before November 3rd?\n22   A. No. I'd never heard of him before this whole thing\nPage 20\n 1   started.\n 2   Q. And then?`;
    const read = await readDeposition(bytes(text), undefined, undefined, "Marcus Webb");
    const lines = read.exchanges!.lines;
    expect(lines.find((l) => l.printedPage === 20 && l.lineNo === 1)?.role).toBe("witness");
  });

  it("reports empty text as unsupported instead of failing", async () => {
    const read = await readDeposition(bytes("   \n\n"));
    expect(read.validation.status).toBe("unsupported");
  });
});

describe("archives that number each statement", () => {
  const header = ["ARCHIVE-DERIVED TRANSCRIPT EXPORT", "Source URL: https://example.org/", ""];
  const run = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `${from + i} ${i % 2 ? "A" : "Q"}: statement ${from + i}`);

  it("keeps the archive's own numbers as the line, on page 0, and keeps the header out", () => {
    const read = readArchiveRecords([...header, ...run(1, 40), "continued words", ...run(41, 60)])!;
    expect(read.layout.name).toBe("text-archive-lines-v1");
    expect(read.pages).toHaveLength(1);
    const lines = read.pages[0].lines;
    expect([lines[0].printedPage, lines[0].lineNo, lines.at(-1)!.lineNo]).toEqual([0, 1, 60]);
    expect(lines.find((l) => l.lineNo === 40)!.rawText).toBe("A: statement 40 continued words");
    expect(read.pages[0].footer).toEqual(["ARCHIVE-DERIVED TRANSCRIPT EXPORT", "Source URL: https://example.org/"]);
  });

  it("stores a count that starts again as parts, so each number names one statement in its part", () => {
    const read = readArchiveRecords([...run(1, 50), ...run(1, 32), ...run(1, 45)])!;
    expect(read.pages.map((p) => [p.printedPage, p.lines.length])).toEqual([[1, 50], [2, 32], [3, 45]]);
    expect(read.warnings[0]).toMatch(/starts again 2 times.*"Part P, Line N"/);
  });

  it("isn't used for page-sized numbering, or numbers that go backwards anywhere but to a new start", () => {
    expect(readArchiveRecords(run(1, 25))).toBeNull();
    expect(readArchiveRecords([...run(1, 50), ...run(30, 60)])).toBeNull();
  });
});

