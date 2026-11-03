import { describe, expect, it } from "vitest";
import { coverageNotes, pageRuns } from "../../server/src/api/present";
import { hasCoverageGaps, sessionCoverage } from "../../server/src/verify";

const run = (page: number, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ({ page, line: from + i }));
const VALIDATION = { pageCount: 6, blankPages: [], failedPages: [], needsOcrPages: [], layout: "scanned-25-v1" };

describe("sessionCoverage", () => {
  it("reports nothing missing for unbroken page:line testimony", () => {
    const c = sessionCoverage([...run(1, 1, 25), ...run(2, 1, 25)], VALIDATION);
    expect(c).toMatchObject({ linesSent: 50, gaps: [], lineSkips: [], numbered: true });
    expect(hasCoverageGaps(c)).toBe(false);
  });

  it("names whole printed pages missing between stored lines, as in September's 27:14 to 30:12", () => {
    const c = sessionCoverage([...run(27, 1, 14), ...run(30, 12, 25)], { ...VALIDATION, blankPages: [28, 29] });
    expect(c.gaps).toEqual([{ after: "27:14", before: "30:12", missingPages: [28, 29] }]);
    expect(c.blankPages).toEqual([28, 29]);
    expect(hasCoverageGaps(c)).toBe(true);
  });

  it("keeps skipped line numbers within a page apart, since they may only be blank lines", () => {
    const c = sessionCoverage([...run(1, 1, 7), ...run(1, 11, 25), ...run(2, 2, 25)], VALIDATION);
    expect(c.gaps).toEqual([]);
    expect(c.lineSkips).toEqual([{ after: "1:07", before: "1:11", missingPages: [] }, { after: "1:25", before: "2:02", missingPages: [] }]);
    expect(hasCoverageGaps(c)).toBe(false);
  });

  it("lists failed and unread pages, whose text was never stored", () => {
    const c = sessionCoverage(run(1, 1, 25), { ...VALIDATION, failedPages: [4], needsOcrPages: [2, 4] });
    expect(c.unreadPages).toEqual([2, 4]);
    expect(hasCoverageGaps(c)).toBe(true);
  });

  it("can't read gaps from references the reader numbered itself", () => {
    const c = sessionCoverage([{ page: 0, line: 1 }, { page: 0, line: 5 }], { ...VALIDATION, layout: "text-unnumbered-v1" });
    expect(c).toMatchObject({ numbered: false, gaps: [], lineSkips: [] });
  });
});

describe("coverage wording", () => {
  it("joins pages into runs", () => {
    expect(pageRuns([29, 28, 31, 5])).toBe("5, 28–29, 31");
  });
  it("says which testimony the check never received", () => {
    expect(coverageNotes({ blankPages: [28, 29], unreadPages: [], gaps: [{ after: "27:14", before: "30:12", missingPages: [28, 29] }] })).toEqual([
      "PDF pages 28–29 have no text, so nothing on them was checked.",
      "Transcript pages 28–29 are missing, between 27:14 and 30:12.",
    ]);
    expect(coverageNotes({ blankPages: [], unreadPages: [3], gaps: [] })).toEqual(["PDF page 3 couldn't be read, so it was not checked."]);
  });
  it("says nothing when code knows of nothing missing", () => {
    expect(coverageNotes({ blankPages: [], unreadPages: [], gaps: [] })).toEqual([]);
  });
});
