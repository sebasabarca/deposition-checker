// Figures on screen must add up, and review decisions must never be read from anything but a known value.

import { describe, expect, it } from "vitest";
import { displayRef, inMarkedRange, nextStep, recentActivity, relativeTime } from "../../client/src/lib/insights";
import type { CaseDetail } from "../../client/src/types";

describe("cited ranges", () => {
  it("tells which lines fall inside a cited range, across a page break", () => {
    expect([inMarkedRange("12:24-13:02", 12, 23), inMarkedRange("12:24-13:02", 12, 25), inMarkedRange("12:24-13:02", 13, 2), inMarkedRange("12:24-13:02", 13, 3)]).toEqual([false, true, true, false]);
    expect(inMarkedRange("", 1, 1)).toBe(false);
  });
});

describe("recent activity", () => {
  it("orders events newest first and respects the limit; an analysis links to its review", () => {
    const detail = {
      case: { id: 1, name: "C", createdAt: "2026-01-01T00:00:00Z", findings: 0 },
      witnesses: [{ id: 2, name: "W", depositions: [] }],
      depositions: [{ id: 3, witnessId: 2, pageCount: 9, createdAt: "2026-01-02T00:00:00Z" }],
      runs: [{ id: 4, name: "Whole case", status: "completed", mode: "live", createdAt: "2026-01-03T00:00:00Z", finishedAt: "2026-01-04T00:00:00Z" }],
    } as unknown as CaseDetail;
    const items = recentActivity([detail], { case: (id) => `c${id}`, caseRun: (id) => `r${id}` }, 2);
    expect(items.map((i) => i.title)).toEqual(["Analysis finished", "Deposition uploaded"]);
    expect(items[0]).toMatchObject({ link: "r4", subject: "C / Whole case" });
  });

  it("words elapsed time", () => {
    const now = Date.parse("2026-01-03T00:00:00Z");
    expect(relativeTime("2026-01-02T23:59:50Z", now)).toBe("Just now");
    expect(relativeTime("2026-01-02T23:30:00Z", now)).toBe("30 min ago");
    expect(relativeTime("2026-01-02T00:00:00Z", now)).toBe("1 day ago");
  });
});

describe("displayRef", () => {
  it("shows unnumbered text by line and leaves page:line alone", () => {
    expect(displayRef("0:12–0:14")).toBe("Lines 12–14");
    expect(displayRef("0:240")).toBe("Line 240");
    expect(displayRef("10:07–10:09")).toBe("10:07–10:09");
    expect(displayRef(null)).toBe(null);
  });
});

describe("nextStep", () => {
  it("asks for the earliest unfinished step of the work", () => {
    const dep = (id: number, witnessId: number, status = "ready") => ({ id, witnessId, status, takenOn: null, error: null, pageCount: 10, needsOcrPages: [], originalFilename: null, fileSha256: "", createdAt: "", scanned: false }) as never;
    const kase = (deps: unknown[], runs: unknown[] = []) => ({ case: { id: 1, name: "Webb", createdAt: "", findings: 0 }, witnesses: [{ id: 7, name: "Marcus Webb", depositions: [] }], depositions: deps, runs }) as never;
    expect(nextStep([], [], []).kind).toBe("first_deposition");
    expect(nextStep([kase([dep(1, 7)])], [], [])).toMatchObject({ kind: "second_session", witness: "Marcus Webb" });
    expect(nextStep([kase([dep(1, 7), dep(2, 7, "processing")])], [], []).kind).toBe("reading");
    expect(nextStep([kase([dep(1, 7), dep(2, 7)])], [], [])).toMatchObject({ kind: "check", caseId: 1, caseName: "Webb" });
    const running = kase([dep(1, 7), dep(2, 7)], [{ id: 9, status: "adjudicating" }]);
    expect(nextStep([running], [{ runId: 9 }], [])).toMatchObject({ kind: "case_running", caseId: 1 }); // one runs at a time: follow it
    const analyzed = kase([dep(1, 7), dep(2, 7)], [{ id: 9, status: "completed" }]);
    expect(nextStep([analyzed], [{ runId: 9 }], [])).toMatchObject({ kind: "decide", count: 1, runId: 9 });
    expect(nextStep([analyzed], [], [{ runId: 9, caseName: "Webb" }])).toMatchObject({ kind: "export", runId: 9 });
    expect(nextStep([analyzed], [], []).kind).toBe("more");
  });
});
