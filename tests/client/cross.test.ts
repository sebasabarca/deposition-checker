// Comparing one session of each of two witnesses: how the selection reads it and how it is named.
import { describe, expect, it } from "vitest";
import { checkState } from "../../client/src/lib/insights";
import { analysisTitle, findingHeadline } from "../../client/src/lib/labels";

describe("two sessions of different witnesses", () => {
  const deps = [{ id: 10, witnessId: 1, status: "ready" as const, takenOn: "1996-01-23" }, { id: 20, witnessId: 2, status: "ready" as const, takenOn: "1996-02-11" }, { id: 21, witnessId: 2, status: "processing" as const, takenOn: "1996-02-12" }];
  const report = (status: "completed" | "adjudicating") => ({ id: 7, depositionA: 10, depositionB: 20, status, createdAt: "2026-11-03" });
  it("are a cross-witness check, waiting for both to be read", () => {
    expect(checkState([20, 10], deps, [])).toEqual({ kind: "new", a: 20, b: 10, cross: true });
    expect(checkState([10, 21], deps, []).kind).toBe("not_ready");
  });
  it("find the existing comparison of the same two sessions, running or done", () => {
    expect(checkState([10, 20], deps, [report("adjudicating")])).toMatchObject({ kind: "running", cross: true, report: { id: 7 } });
    expect(checkState([20, 10], deps, [report("completed")])).toMatchObject({ kind: "done", cross: true, report: { id: 7 } });
  });
});

describe("cross-witness names", () => {
  it("names a check by its witnesses", () => {
    expect(analysisTitle({ kind: "cross_witness", witnesses: { a: { name: "Simpson" }, b: { name: "Resnick" } } })).toBe("Simpson and Resnick");
    expect(analysisTitle({ kind: "same_witness", witnesses: { a: { name: "Hutchinson" }, b: null } })).toBe("Hutchinson");
  });
  it("calls a lane-confirmed finding a conflict between witnesses, never a self-contradiction", () => {
    expect(findingHeadline({ group: "contradictions", classification: "direct", cross: { witnessA: "A", witnessB: "B" } })).toBe("Potential conflict between witnesses");
    expect(findingHeadline({ group: "contradictions", classification: "direct", cross: null })).toBe("Potential direct contradiction");
    expect(findingHeadline({ group: "needs_context", classification: "insufficient_evidence", cross: { witnessA: "A", witnessB: "B" } })).toBe("Needs context");
  });
});
