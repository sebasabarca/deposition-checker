// Figures on screen must add up, and review decisions must never be read from anything but a known value.

import { describe, expect, it } from "vitest";
import { candidateCoverage, ocrPassage, pinpointCitation, progressShare, recentActivity, relativeTime } from "../../client/src/lib/insights";
import { parseStore, reviewOf } from "../../client/src/lib/review";
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
    expect(pinpointCitation(side("45:11-15", "2024-03-12"), side(null, null))).toBe("Webb Dep. 45:11-15 (2024-03-12); compare Webb Dep. (no page:line reference) (date not stated).");
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

describe("review adapter", () => {
  it("ignores unreadable or unknown stored data", () => {
    expect(parseStore("not json")).toEqual({});
    expect(parseStore(null)).toEqual({});
    expect(Object.keys(parseStore(JSON.stringify({ 1: { decision: "confirmed", note: "", decidedAt: "x" }, 2: { decision: "approved" } })))).toEqual(["1"]);
  });

  it("prefers the local decision, then a known server state", () => {
    const store = { 1: { decision: "dismissed" as const, note: "", decidedAt: "x" } };
    expect(reviewOf(1, "confirmed", store)).toBe("dismissed");
    expect(reviewOf(2, "confirmed", store)).toBe("confirmed");
    expect(reviewOf(2, "unreviewed", store)).toBe("unreviewed");
  });
});
