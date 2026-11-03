// Synthetic edge cases for the transcript formats: ASCII layouts, RTF and DOCX structure, encodings,
// damaged files and unsupported formats. The genuine samples are in transcripts.test.ts.

import { describe, expect, it } from "vitest";
import { decodeText, detectFormat, extractDocx, extractRtf, readDeposition, readTextPages, type DepositionRead } from "../../server/src/ingest";
import { docx, pageBreak, para, rtf, run } from "../fixtures/transcripts/build";

const enc = (s: string) => new TextEncoder().encode(s);
const ref = (r: DepositionRead) => (r.exchanges?.lines ?? []).map((l) => `${l.printedPage}:${l.lineNo} ${l.role} ${l.rawText}`);
const at = (r: DepositionRead, page: number, line: number) => r.exchanges?.lines.find((l) => l.printedPage === page && l.lineNo === line);
const warned = (r: DepositionRead, text: string) => (r.validation.warnings ?? []).some((w) => w.includes(text));
// A 25-line page of an ASCII export with the page number printed at the right above it.
const page = (n: number, rows: string[]) => `${" ".repeat(66)}${n}\n\n${rows.map((r, i) => `${String(i + 1).padStart(10)}    ${r}`).join("\n")}\n\f`;

describe("ASCII transcripts", () => {
  it("reads a right-aligned page number as the page, never as a line", async () => {
    const text = page(7, ["Q.   Where were you?", "A.   At home."]) + page(8, ["Q.   Alone?", "A.   Yes."]);
    const { pages } = readTextPages(text);
    expect(pages.map((p) => [p.printedPage, p.lines.length])).toEqual([[7, 2], [8, 2]]);
  });

  it("restarts line numbers on each page and infers a missing page number, with a warning", async () => {
    const text = page(3, ["Q.   One?", "A.   Yes."]) + `${String(1).padStart(10)}    Q.   Two?\n${String(2).padStart(10)}    A.   No.\n`;
    const r = await readDeposition(enc(text));
    expect(r.pdf!.pages.map((p) => p.printedPage)).toEqual([3, 4]);
    expect(r.validation.inferredPages).toEqual([2]);
    expect(warned(r, "Page 4 has no printed page number")).toBe(true);
  });

  it("warns when line numbers skip or pages go backwards", async () => {
    const r = await readDeposition(enc(page(5, ["Q.   One?"]) + `${" ".repeat(66)}4\n${String(1).padStart(10)}    A.   Yes.\n${String(3).padStart(10)}    Q.   Three?\n`));
    expect(warned(r, "Line numbers skip on page 4")).toBe(true);
    expect(warned(r, "Page numbers don't increase at page 4")).toBe(true);
  });

  it("removes timestamps before, after or at the end of a line number, and keeps the testimony intact", async () => {
    const text = [
      "                                        12",
      "10:15:32   1   Q.   Did you sign it?",
      " 2  10:15:40  A.   I signed it at 10:30 that night.",
      " 3            Q.   Why?                          10:15:45AM",
    ].join("\n");
    const r = await readDeposition(enc(text));
    expect(ref(r)).toEqual(["12:1 attorney Q.   Did you sign it?", "12:2 witness A.   I signed it at 10:30 that night.", "12:3 attorney Q.   Why?"]);
    expect(warned(r, "Timestamps beside the line numbers were removed from 3 lines")).toBe(true);
  });

  it("keeps wrapped testimony and an answer that crosses the page as one answer", async () => {
    const r = await readDeposition(enc(page(1, ["Q.   What happened next?", "A.   I drove to the depot, and", "     then I waited."]) + page(2, ["and then I left.", "Q.   When?"])));
    const answer = r.exchanges!.exchanges.find((e) => e.lines.some((l) => l.index === at(r, 1, 2)!.index))!;
    expect(answer.lines.filter((l) => l.role === "answer").map((l) => r.exchanges!.lines[l.index].rawText)).toEqual(["A.   I drove to the depot, and", "then I waited.", "and then I left."]);
  });

  it("never gives an objection inside an answer to the witness", async () => {
    const r = await readDeposition(enc(page(1, ["Q.   Did you see it?", "A.   I saw part of", "MR. LEE:  Objection, form.", "THE WITNESS:  it, from the door.", "BY MS. ORTIZ:", "Q.   Which door?"])));
    expect(at(r, 1, 3)).toMatchObject({ role: "colloquy", speakerName: "MR. LEE" });
    expect(at(r, 1, 4)!.role).toBe("witness");
    expect(at(r, 1, 5)).toMatchObject({ role: "colloquy", speakerName: "MS. ORTIZ" });
    expect(at(r, 1, 6)!.role).toBe("attorney");
  });

  it("keeps headers, footers, the index and the certificate out of the testimony, and says how many rows", async () => {
    const text = `CASEY REPORTING SERVICES\n${page(2, ["I N D E X", "EXAMINATION BY MR. LEE        5"])}Casey Reporting  (555) 010-0100\n${page(3, ["Q.   Name?", "A.   Avery."])}`;
    const r = await readDeposition(enc(text));
    expect(r.pdf!.pages.map((p) => p.lines.length)).toEqual([2, 2]);
    expect(r.exchanges!.lines.some((l) => l.rawText.includes("Casey Reporting"))).toBe(false);
    expect(warned(r, "1 row has no line number")).toBe(true); // the first header comes before any page
  });

  it("reads Q. / Q: / Q followed by a tab as question markers", async () => {
    const r = await readDeposition(enc(page(1, ["Q.   One?", "A.   Yes.", "Q:   Two?", "A:   No.", "Q\tThree?", "A\tMaybe."])));
    expect(r.exchanges!.lines.map((l) => l.role)).toEqual(["attorney", "witness", "attorney", "witness", "attorney", "witness"]);
  });

  it("keeps Unicode punctuation exactly, and reads Windows-1252 and UTF-16 files with a note", async () => {
    const utf8 = await readDeposition(enc(page(1, ["A.   He said \u201cno\u201d \u2014 then \u2026 nothing."])));
    expect(at(utf8, 1, 1)!.rawText).toBe("A.   He said \u201cno\u201d \u2014 then \u2026 nothing.");
    const ansi = new Uint8Array([...enc(page(1, ["A.   It"])).slice(0, -2), 0x92, 0x73, 0x20, 0x93, 0x66, 0x69, 0x6e, 0x65, 0x94, 0x2e, 0x0a]);
    expect(decodeText(ansi)?.encoding).toBe("windows-1252");
    const read = await readDeposition(ansi);
    expect(at(read, 1, 1)!.rawText).toBe("A.   It\u2019s \u201cfine\u201d.");
    expect(warned(read, "older text encoding")).toBe(true);
    const utf16 = new Uint8Array([0xff, 0xfe, ...Buffer.from(page(1, ["A.   Yes."]), "utf16le")]);
    expect(at(await readDeposition(utf16), 1, 1)!.rawText).toBe("A.   Yes.");
  });

  it("is deterministic: reading the same file twice gives the same result", async () => {
    const data = enc(page(1, ["Q.   One?", "A.   Yes."]));
    expect(JSON.stringify(await readDeposition(data))).toBe(JSON.stringify(await readDeposition(data)));
  });
});

describe("RTF transcripts", () => {
  const rows = (lines: string[]) => lines.map((l, i) => `${String(i + 1).padStart(2)}  ${l}\\par`).join("\n");

  it("reads paragraphs, line breaks, escapes and Unicode, and skips tables of fonts, headers and hidden groups", async () => {
    const body = `{\\header SMITH REPORTING\\par}{\\*\\generator Eclipse;}{\\info{\\title Deposition}}` + rows(["Q.  Did you \\'93sign\\'94 it?", "A.  Yes \\u8212? I did\\line", "Q.  Path C:\\\\docs\\{1\\}?"]);
    const text = extractRtf(rtf(body)).text;
    expect(text).toBe(" 1  Q.  Did you \u201csign\u201d it?\n 2  A.  Yes \u2014 I did\n\n 3  Q.  Path C:\\docs{1}?\n");
    const r = await readDeposition(rtf(body));
    expect(r.format).toBe("rtf");
    expect(at(r, 1, 1)!.rawText).toBe("Q.  Did you \u201csign\u201d it?");
    expect(r.exchanges!.lines.some((l) => l.rawText.includes("SMITH"))).toBe(false);
  });

  it("decodes escaped bytes with the document's code page", () => {
    const cyrillic = new TextEncoder().encode(`{\\rtf1\\ansi\\ansicpg1251{\\fonttbl{\\f0 Courier;}}\n 1  A.  \\'c4\\'e0.\\par}`);
    expect(extractRtf(cyrillic).text).toBe(" 1  A.  \u0414\u0430.\n");
  });

  it("starts a new page at \\page and \\pagebb", async () => {
    const r = await readDeposition(rtf(`${rows(["Q.  One?", "A.  Yes."])}\\page\n${rows(["Q.  Two?"])}{\\pard\\pagebb ${rows(["A.  No."])}}`));
    expect(r.pdf!.pages.map((p) => p.lines.length)).toEqual([2, 1, 1]);
  });

  it("recovers page:line from line numbering set as formatting only when unambiguous, with a warning", async () => {
    const numbered = rtf(`Q.  One?\\par A.  Yes.\\par\\page Q.  Two?\\par A.  No.\\par`, "\\linemod1\\lineppage");
    const r = await readDeposition(numbered);
    expect(ref(r)).toEqual(["1:1 attorney Q.  One?", "1:2 witness A.  Yes.", "2:1 attorney Q.  Two?", "2:2 witness A.  No."]);
    expect(warned(r, "line-numbering setting")).toBe(true);
    const wrapped = await readDeposition(rtf(`Q.  ${"Long question ".repeat(8)}?\\par\\page A.  No.\\par`, "\\linemod1\\lineppage"));
    expect(wrapped.validation.layout).toBe("text-unnumbered-v1");
    expect(warned(wrapped, "long enough to wrap")).toBe(true);
  });

  it("warns on a truncated RTF instead of failing", async () => {
    const cut = rtf(rows(["Q.  One?", "A.  Yes."])).slice(0, -1);
    const r = await readDeposition(cut);
    expect(r.validation.status).toBe("ready");
    expect(warned(r, "may be truncated")).toBe(true);
  });
});

describe("DOCX transcripts", () => {
  const rows = (lines: string[]) => lines.map((l, i) => para(run(`${String(i + 1).padStart(2)}  ${l}`))).join("");

  it("reads paragraphs in order, leaves headers, deletions and field codes out, and keeps tabs", async () => {
    const body = rows(["Q.  Where?", "A.  Home."]) + para(`${run(" 3  Q.")}<w:r><w:tab/></w:r><w:del><w:r><w:delText>deleted</w:delText></w:r></w:del><w:r><w:instrText>PAGE</w:instrText></w:r>${run("When?")}`);
    const r = await readDeposition(docx(body));
    expect(r.format).toBe("docx");
    expect(ref(r)).toEqual(["1:1 attorney Q.  Where?", "1:2 witness A.  Home.", "1:3 attorney Q.    When?"]);
  });

  it("reads a two-column table of line numbers and testimony as numbered rows", async () => {
    const cell = (t: string) => `<w:tc>${para(run(t))}</w:tc>`;
    const table = `<w:tbl>${[["1", "Q.  Name?"], ["2", "A.  Avery."], ["3", "Q.  Address?"]].map(([n, t]) => `<w:tr>${cell(n)}${cell(t)}</w:tr>`).join("")}</w:tbl>`;
    expect(ref(await readDeposition(docx(table)))).toEqual(["1:1 attorney Q.  Name?", "1:2 witness A.  Avery.", "1:3 attorney Q.  Address?"]);
  });

  it("starts pages at page breaks, page-break-before and next-page section breaks", async () => {
    const body = rows(["Q.  One?"]) + para(pageBreak) + rows(["A.  Two."]) + para(run(" 1  Q.  Three?"), "<w:pageBreakBefore/>") + para(run(" 1  A.  Four."), "") + para("", '<w:sectPr><w:type w:val="nextPage"/></w:sectPr>') + rows(["Q.  Five?"]);
    const r = await readDeposition(docx(body));
    expect(r.pdf!.pages.map((p) => p.lines.map((l) => l.rawText))).toEqual([["Q.  One?"], ["A.  Two."], ["Q.  Three?"], ["A.  Four."], ["Q.  Five?"]]);
  });

  it("recovers page:line from Word line numbering only when unambiguous, with a warning", async () => {
    const plain = (t: string) => para(run(t));
    // A page break run at the start of a paragraph moves that paragraph to the next page.
    const r = await readDeposition(docx(plain("Q.  One?") + plain("A.  Yes.") + para(pageBreak + run("Q.  Two?")) + plain("A.  No."), '<w:lnNumType w:countBy="1" w:restart="newPage"/>'));
    expect(ref(r)).toEqual(["1:1 attorney Q.  One?", "1:2 witness A.  Yes.", "2:1 attorney Q.  Two?", "2:2 witness A.  No."]);
    expect(warned(r, "line-numbering setting")).toBe(true);
    const continuous = await readDeposition(docx(plain("Q.  One?") + para(pageBreak) + plain("A.  Yes."), '<w:lnNumType w:countBy="1" w:restart="continuous"/>'));
    expect(continuous.validation.layout).toBe("text-unnumbered-v1");
    expect(warned(continuous, "doesn't restart on each page")).toBe(true);
  });

  it("reports a damaged or truncated .docx as unsupported, with the reason", async () => {
    const whole = docx(rows(["Q.  One?"]));
    const r = await readDeposition(whole.slice(0, whole.length - 30));
    expect(r.validation.status).toBe("unsupported");
    expect(r.exchanges).toBeNull();
  });
});

describe("format detection", () => {
  it("tells formats by their bytes and refuses proprietary ones with what to ask for", () => {
    expect(detectFormat(enc("%PDF-1.7\n"), "a.txt")).toEqual({ format: "pdf" });
    expect(detectFormat(rtf("x"), "a.rtf")).toEqual({ format: "rtf" });
    expect(detectFormat(docx(""), "a.docx")).toEqual({ format: "docx" });
    expect(detectFormat(enc(" 1  Q.  Hi?"), "a.asc")).toEqual({ format: "text" });
    expect(detectFormat(enc(" 1  Q.  Hi?"), "Smith 2024.ptx")).toMatchObject({ error: expect.stringMatching(/E-Transcript \(\.ptx\).*ASCII/) });
    expect(detectFormat(enc("x"), "a.lef")).toMatchObject({ error: expect.stringMatching(/\.lef/) });
    expect(detectFormat(enc("x"), "a.ptf")).toMatchObject({ error: expect.stringMatching(/\.ptf/) });
    expect(detectFormat(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]), "old.doc")).toMatchObject({ error: expect.stringMatching(/\.doc/) });
    expect(detectFormat(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]))).toMatchObject({ error: expect.stringMatching(/\.docx/) });
    expect(detectFormat(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5]))).toMatchObject({ error: expect.stringMatching(/ZIP/) });
    expect(detectFormat(new Uint8Array([0, 1, 2, 3, 0, 0, 7]))).toMatchObject({ error: expect.stringMatching(/isn't a transcript format/) });
  });

  it("reads a .docx's body only from word/document.xml", () => {
    expect(extractDocx(docx(para(run("Hello")))).text).toBe("Hello");
  });
});
