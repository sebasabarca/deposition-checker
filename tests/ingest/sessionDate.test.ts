import { describe, expect, it } from "vitest";
import type { PageExtraction } from "../../server/src/ingest/pdf";
import { findSessionDate } from "../../server/src/ingest/sessionDate";

const page = (printedPage: number, rows: string[]): PageExtraction => ({
  pdfPage: printedPage || 1,
  hasText: true,
  printedPage,
  footer: [],
  unnumbered: [],
  lines: rows.map((rawText, i) => ({ pdfPage: printedPage || 1, printedPage, lineNo: i + 1, lineFromPosition: i + 1, indentX: 0, rawText })),
});

describe("findSessionDate", () => {
  it("reads the date under the cover's session heading", () => {
    expect(findSessionDate([page(1, ["SELECT COMMITTEE", "DEPOSITION OF: CASSIDY HUTCHINSON", "", "Monday, June 20, 2022"])])).toEqual({ date: "2022-06-20", ref: "1:4", text: "Monday, June 20, 2022" });
    expect(findSessionDate([page(1, ["CROSS-EXAMINATION OF DR. SOARES", "HELD SEPTEMBER 5, 2014"])])?.date).toBe("2014-09-05");
    expect(findSessionDate([page(1, ["Deposition taken on 3/7/2024 at 9:00 a.m."])])?.date).toBe("2024-03-07");
  });

  it("ignores documents and later pages, where the dates belong to exhibits", () => {
    expect(findSessionDate([page(1, ["DEPOSITION OF MARCUS WEBB", "an e-mail dated April 6, 1995"])])).toBeNull();
    expect(findSessionDate([page(114, ["Q. Is this the deposition exhibit?", "December 1, 1996 e-mail from you to Mr. Nehru."])])).toBeNull();
    expect(findSessionDate([page(1, ["IN THE UNITED STATES DISTRICT COURT", "", "", "", "", "June 20, 2022"])])).toBeNull(); // nothing names the session
  });

  it("looks only at the first lines of text without page numbers, and rejects impossible dates", () => {
    expect(findSessionDate([page(0, ["Deposition of Mara Voss", "January 14, 2025"])])?.ref).toBe("0:2");
    expect(findSessionDate([page(0, [...Array(80).fill("A. Yes."), "Deposition taken January 14, 2025"])])).toBeNull();
    expect(findSessionDate([page(1, ["Deposition taken February 30, 2024"])])).toBeNull();
  });
});
