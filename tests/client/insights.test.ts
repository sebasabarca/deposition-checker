// Figures on screen must add up, and review decisions must never be read from anything but a known value.

import { describe, expect, it } from "vitest";
import { candidateCoverage, ocrPassage, pinpointCitation, progressShare, recentActivity, relativeTime, checkState, pairsChecked } from "../../client/src/lib/insights";
import type { CaseDetail, EvidenceLine, EvidenceSide } from "../../client/src/types";

describe("OCR passages", () => {
  const line = (over: Partial<EvidenceLine>): EvidenceLine => ({ id: 1, ref: "1:01", text: "x", role: "answer", highlighted: false, ocrConfidence: null, pdfPage: 1, ...over });

  it("treats a text layer as not OCR, even from a server that omits the field", () => {
    expect(ocrPassage({ before: [], lines: [line({})], after: [] })).toBeNull();
    const { ocrConfidence: _omitted, ...old } = line({});
    expect(ocrPassage({ before: [], lines: [old as EvidenceLine], after: [] })).toBeNull();
  });

  it("counts OCR in the context lines too, and flags below 85 only", () => {
    const side = { before: [line({ ocrConfidence: 84 })], lines: [line({ ocrConfidence: 85, highlighted: true, pdfPage: 7 })], after: [] };
    expect(ocrPassage(side)).toEqual({ lowLines: 1, pages: [7], inferredPages: [] });
  });

  it("names inferred printed pages, and marks the citation only when a cited line is on one", () => {
    const deposition = { id: 1, takenOn: null, originalFilename: null, witness: "Marcus Webb" };
    const context = line({ ocrConfidence: 90, ref: "12:25", pageInferred: true });
    const cited = line({ ocrConfidence: 90, ref: "13:01", highlighted: true });
    const clean = { range: "13:01", deposition, lines: [cited], before: [context], after: [] };
    expect(ocrPassage(clean)?.inferredPages).toEqual(["12"]);
    expect(pinpointCitation(clean, clean)).not.toContain("inferred");
    const flagged = { ...clean, lines: [{ ...cited, pageInferred: true }] };
    expect(pinpointCitation(flagged, clean)).toBe("Webb Dep. 13:01 (date not stated) [page number inferred; verify against the scan]; compare Webb Dep. 13:01 (date not stated).");
  });

  it("opens at the first cited page, not the context", () => {
    const side = { before: [line({ ocrConfidence: 90, pdfPage: 3 })], lines: [line({ ocrConfidence: 90, highlighted: true, pdfPage: 5 }), line({ ocrConfidence: 90, highlighted: true, pdfPage: 4 })], after: [] };
    expect(ocrPassage(side)?.pages).toEqual([4, 5]);
  });
});

describe("candidate coverage", () => {
  it("puts every candidate in exactly one bucket", () => {
    const c = candidateCoverage({ candidates: { selected: 10, deferred: 4 }, adjudicated: 3, replayed: 2, fixture: 1, failed: 1 });
    expect(c).toEqual({ assessed: 6, unassessed: 4, deferred: 4, total: 14 });
    expect(c.assessed + c.unassessed + c.deferred).toBe(c.total);
  });

  it("shows no progress before candidates exist, and full progress when complete", () => {
    expect(progressShare("retrieving", {})).toBe(0);
    expect(progressShare("adjudicating", { candidates: { selected: 4, deferred: 0 }, adjudicated: 1 })).toBe(0.25);
    expect(progressShare("completed", {})).toBe(1);
  });
});

describe("pinpoint citation", () => {
  const side = (range: string | null, takenOn: string | null) => ({ range, deposition: { id: 1, takenOn, originalFilename: null, witness: "Marcus Webb" }, lines: [] }) as Pick<EvidenceSide, "range" | "deposition" | "lines">;
  it("uses only stored references and says when one is missing", () => {
    expect(pinpointCitation(side("45:11-15", "2024-03-12"), side(null, null))).toBe("Webb Dep. 45:11-15 (Mar. 12, 2024); compare Webb Dep. (no page:line reference) (date not stated).");
  });
});

describe("recent activity", () => {
  it("orders events newest first and respects the limit", () => {
    const detail = {
      case: { id: 1, name: "C", createdAt: "2026-01-01T00:00:00Z", findings: 0 },
      witnesses: [{ id: 2, name: "W", depositions: [] }],
      depositions: [{ id: 3, witnessId: 2, pageCount: 9, createdAt: "2026-01-02T00:00:00Z" }],
      analyses: [{ id: 4, witnessId: 2, createdAt: "2026-01-03T00:00:00Z", finishedAt: "2026-01-04T00:00:00Z" }],
    } as unknown as CaseDetail;
    const items = recentActivity([detail], { case: (id) => `c${id}`, analysis: (id) => `a${id}` }, 2);
    expect(items.map((i) => i.title)).toEqual(["Analysis finished", "Deposition uploaded"]);
    expect(items[0].link).toBe("a4");
  });

  it("words elapsed time", () => {
    const now = Date.parse("2026-01-03T00:00:00Z");
    expect(relativeTime("2026-01-02T23:59:50Z", now)).toBe("Just now");
    expect(relativeTime("2026-01-02T23:30:00Z", now)).toBe("30 min ago");
    expect(relativeTime("2026-01-02T00:00:00Z", now)).toBe("1 day ago");
  });
});

describe("the new check panel", () => {
  const deps = [{ id: 1, witnessId: 1, status: "ready" as const }, { id: 2, witnessId: 1, status: "ready" as const }, { id: 3, witnessId: 2, status: "ready" as const }, { id: 4, witnessId: 1, status: "processing" as const }, { id: 5, witnessId: 1, status: "ready" as const }];
  const report = (id: number, depositionA: number, depositionB: number, status: "completed" | "adjudicating" | "failed") => ({ id, depositionA, depositionB, status, createdAt: "2026-11-01" });

  it("asks for exactly two depositions of one witness, both read", () => {
    expect(checkState([], deps, []).kind).toBe("pick");
    expect(checkState([1], deps, []).kind).toBe("pick");
    expect(checkState([1, 2, 5], deps, []).kind).toBe("too_many");
    expect(checkState([1, 3], deps, []).kind).toBe("different_witness");
    expect(checkState([1, 4], deps, []).kind).toBe("not_ready");
  });

  it("offers a new check only for a pair with no report", () => {
    expect(checkState([1, 2], deps, [])).toMatchObject({ kind: "new", a: 1, b: 2 });
    expect(checkState([1, 2], deps, [report(9, 1, 5, "completed")]).kind).toBe("new");
    expect(checkState([1, 2], deps, [report(9, 1, 2, "failed")]).kind).toBe("new");
  });

  it("finds an existing report in either order, and the latest one", () => {
    const s = checkState([2, 1], deps, [report(8, 1, 2, "completed"), report(9, 2, 1, "completed")]);
    expect(s).toMatchObject({ kind: "done", report: { id: 9 } });
  });

  it("prefers a running check over an older report", () => {
    expect(checkState([1, 2], deps, [report(8, 1, 2, "completed"), report(9, 1, 2, "adjudicating")])).toMatchObject({ kind: "running", report: { id: 9 } });
  });

  it("counts a witness's finished session pairs once each", () => {
    expect(pairsChecked([1, 2, 5], [report(8, 1, 2, "completed"), report(9, 2, 1, "completed"), report(10, 1, 5, "failed")])).toEqual({ checked: 1, total: 3 });
  });
});

describe("displayRef", () => {
  it("shows unnumbered text by line and leaves page:line alone", async () => {
    const { displayRef } = await import("../../client/src/lib/insights");
    expect(displayRef("0:12–0:14")).toBe("Lines 12–14");
    expect(displayRef("0:240")).toBe("Line 240");
    expect(displayRef("10:07–10:09")).toBe("10:07–10:09");
    expect(displayRef(null)).toBe(null);
  });
});
