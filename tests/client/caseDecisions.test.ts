import { describe, expect, it } from "vitest";
import { parseDecisions, storageKey, withDecision } from "../../client/src/lib/caseDecisions";

describe("case analysis decisions", () => {
  it("sets, replaces and clears a finding's decision and note", () => {
    let all = withDecision({}, "F-001", "confirmed", "Ask about bay four", "2026-11-04T10:00:00Z");
    expect(all["F-001"]).toEqual({ decision: "confirmed", note: "Ask about bay four", at: "2026-11-04T10:00:00Z" });
    all = withDecision(all, "F-001", "dismissed", "", "2026-11-04T11:00:00Z");
    expect(all["F-001"].decision).toBe("dismissed");
    expect(withDecision(all, "F-001", null, "", "x")).toEqual({});
  });
  it("reads back only well-formed entries, and nothing from bad storage", () => {
    const raw = JSON.stringify({ "F-001": { decision: "confirmed", note: "n", at: "t" }, "F-002": { decision: "approved", note: "", at: "t" }, "F-003": { decision: "dismissed" } });
    expect(Object.keys(parseDecisions(raw))).toEqual(["F-001"]);
    expect(parseDecisions("not json")).toEqual({});
    expect(parseDecisions(null)).toEqual({});
  });
  it("keys storage by case", () => expect(storageKey(1)).not.toBe(storageKey(3)));
});
