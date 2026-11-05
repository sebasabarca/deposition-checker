import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../client/src/lib/api";
import { laneOf } from "../../client/src/lib/caseRuns";
import { filterFindings, NO_FILTERS, prioritySections } from "../../client/src/lib/findingFilters";
import { findingHeadline, formatDate, GROUP_LABEL } from "../../client/src/lib/labels";
import { isQuarantined, priorReviewText, reviewFailure, reviewLock, SHOWN_DECISION_LABEL, shownDecision } from "../../client/src/lib/review";
import type { FindingStanding } from "../../client/src/types";

const QUARANTINED: FindingStanding = {
  state: "quarantined", reason: "Page 12 was split into two pages by the old parser.", since: "2026-11-03T10:00:00Z", parser: "pdf-2",
  priorReview: { state: "confirmed", note: "Ask about the car.", reviewedAt: "2026-10-30T09:00:00Z" },
};
type Row = Parameters<typeof filterFindings>[0][number] & { id: number };
const row = (id: number, over: Partial<Row> = {}): Row => ({
  id, group: "contradictions", priority: "high", evidenceStatus: "verified", reviewState: "unreviewed", standing: { state: "current" }, subject: null, explanation: `finding ${id}`, rank: id,
  a: { ref: "12:3" }, b: { ref: "8:1" }, analysis: { id: 1, caseId: 1 }, title: "Elena Marsh", ...over,
});
// The server keeps the earlier review on the row; a quarantined finding is in its own group whatever its classification.
const setAside = row(9, { group: "quarantined", reviewState: "confirmed", standing: QUARANTINED, rank: 0 });
const rows = [setAside, row(1, { reviewState: "confirmed" }), row(2), row(3, { group: "needs_context", priority: "needs_context" })];

describe("quarantined findings: grouping and exclusion from review", () => {
  it("are kept apart from every review section", () => {
    const { sections, compatible, quarantined } = prioritySections(rows);
    expect(quarantined.map((f) => f.id)).toEqual([9]);
    expect(compatible).toEqual([]);
    expect(sections.flatMap((s) => s.findings.map((f) => f.id))).toEqual([1, 2, 3]);
  });
  it("come last in the list and only match the category filter, never a decision, priority or citation filter", () => {
    const ids = (f: Partial<typeof NO_FILTERS>) => filterFindings(rows, { ...NO_FILTERS, ...f }).map((r) => r.id);
    expect(ids({})).toEqual([1, 2, 3, 9]);
    expect(ids({ group: "quarantined" })).toEqual([9]);
    expect(ids({ decision: "confirmed" })).toEqual([1]);
    expect(ids({ priority: "high" })).toEqual([1, 2]);
    expect(ids({ evidence: "verified" })).toEqual([1, 2, 3]);
  });
  it("never count as decided or kept, whatever the stored review state", () => {
    expect(isQuarantined(setAside)).toBe(true);
    expect(isQuarantined({ standing: QUARANTINED })).toBe(true); // a case-run finding has no group
    expect(isQuarantined(row(1))).toBe(false);
    expect(shownDecision(setAside)).toBe("quarantined");
    expect(SHOWN_DECISION_LABEL[shownDecision(setAside)]).toBe("Needs revalidation");
    expect(rows.filter((f) => shownDecision(f) === "confirmed").map((f) => f.id)).toEqual([1]);
    expect(shownDecision(row(1, { reviewState: "confirmed" }))).toBe("confirmed");
  });
  it("read as needing revalidation, never as a current contradiction", () => {
    expect(findingHeadline({ group: "quarantined", classification: "direct" })).toBe("Needs revalidation");
    expect(GROUP_LABEL.quarantined).toBe("Needs revalidation");
  });
  it("form their own lane in a whole-case run", () => {
    const f = { evidenceStatus: "verified", unscoredReason: null, type: "direct", score: 80, priority: "high" };
    expect(laneOf({ ...f, standing: QUARANTINED })).toBe("quarantined");
    expect(laneOf({ ...f, standing: { state: "current" } })).toBe("contradictions");
  });
});

describe("the earlier review on a quarantined finding", () => {
  it("is in the past tense with its date", () => {
    expect(priorReviewText(QUARANTINED.priorReview)).toBe(`Previously kept on ${formatDate("2026-10-30T09:00:00Z")}.`);
    expect(priorReviewText({ state: "dismissed", note: null, reviewedAt: null })).toBe("Previously dismissed.");
    expect(priorReviewText({ state: "needs_context", note: null, reviewedAt: null })).toBe("Previously marked as needing more context.");
    expect(priorReviewText({ state: "unreviewed", note: null, reviewedAt: null })).toBe("It had not been reviewed.");
  });
});

describe("review controls", () => {
  it("are locked on a quarantined finding and open on a current one", () => {
    expect(reviewLock({ group: "quarantined", standing: QUARANTINED })).toMatch(/needs revalidation/);
    expect(reviewLock({ group: "contradictions", standing: { state: "current" } })).toBeNull();
  });
});

describe("a 409 from the review endpoint", () => {
  afterEach(() => vi.unstubAllGlobals());
  const reply = (status: number, body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));

  it("shows the server's message and locks the controls", async () => {
    reply(409, { error: "This finding needs revalidation: its transcript was re-read.", standing: QUARANTINED });
    const failure = await api.review(9, "confirmed", undefined, { "4": 0, "5": 0 }).then(() => null, reviewFailure);
    expect(failure).toEqual({ message: "This finding needs revalidation: its transcript was re-read.", locked: true });
  });
  it("sends the evidence versions the finding was opened at, and a stale save comes back as a 409 that locks and reloads", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "This finding's transcript was corrected after you opened it, so your review wasn't saved." }), { status: 409, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const failure = await api.review(9, "dismissed", "note", { "4": 2, "5": 0 }).then(() => null, reviewFailure);
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ decision: "dismissed", note: "note", epochs: { "4": 2, "5": 0 } });
    expect(failure).toEqual({ message: "This finding's transcript was corrected after you opened it, so your review wasn't saved.", locked: true });
  });
  it("leaves the controls open for any other failure", async () => {
    reply(500, { error: "Database unavailable." });
    expect(await api.review(1, "confirmed", undefined, { "4": 0, "5": 0 }).then(() => null, reviewFailure)).toEqual({ message: "Database unavailable.", locked: false });
  });
});
