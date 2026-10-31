import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { clusterFindings, discoverySummary, pairAccuracy, pairAgreement, recovered, type ArmFinding } from "../../experiments/multimodel-contradictions/src/compare";
import { discoveryPrompt, pairPrompt, refOf, type Dataset, type Line, type PairPacket } from "../../experiments/multimodel-contradictions/src/data";
import { costUsd, estimate } from "../../experiments/multimodel-contradictions/src/estimate";
import { canAfford, gateFailure, ledgerOf, type Approval, type Plan } from "../../experiments/multimodel-contradictions/src/gate";
import { parseOutput, RUN_OUTPUT_JSON_SCHEMA, type Finding } from "../../experiments/multimodel-contradictions/src/schemas";
import { parseCitation, verifyFinding } from "../../experiments/multimodel-contradictions/src/verify";

const line = (page: number, n: number, speaker: string, text: string): Line => ({ ref: refOf(page, n), page, line: n, speaker, text });
const dataset: Dataset = { id: "x", kind: "synthetic", witness: "Dana Whitfield", sessions: [
  { label: "A", description: "first", lines: [line(10, 1, "attorney", "Q. Did you lock the dock?"), line(10, 2, "witness", "A. Yes, I locked it myself at nine.")] },
  { label: "B", description: "second", lines: [line(20, 1, "attorney", "Q. Did you lock the dock?"), line(20, 2, "witness", "A. No, somebody else did.")] },
] };
const finding = (over: Partial<Finding> = {}): Finding => ({
  finding_id: "1", witness: "Dana Whitfield", session_a: "A", citation_a: "10:02", exact_excerpt_a: "I locked it myself at nine", session_b: "B", citation_b: "20:02", exact_excerpt_b: "somebody else did",
  shared_subject: "dock", comparable: "yes", classification: "direct_contradiction", factual_proposition_a: "she locked the dock", factual_proposition_b: "someone else locked the dock", conflict_basis: "who", explanation: "e", alternative_explanation: "a", missing_context: "", confidence_rationale: "c", ...over,
});
const item = (arm: string, over: Partial<Finding> = {}): ArmFinding => ({ arm, finding: finding(over), verification: verifyFinding(finding(over), dataset) });

describe("source verification", () => {
  it("verifies an exact excerpt on its cited lines, and records the speaker", () => {
    const v = verifyFinding(finding(), dataset);
    expect(v).toMatchObject({ status: "verified", a: { excerpt: "exact", speaker: "witness" } });
    expect(v.a.propositionOverlap).toBeGreaterThan(0);
  });
  it("calls an excerpt on other lines of the session a wrong reference", () => {
    expect(verifyFinding(finding({ citation_a: "10:01" }), dataset).status).toBe("wrong_reference");
  });
  it("keeps invented text and impossible citations as unsupported", () => {
    expect(verifyFinding(finding({ exact_excerpt_a: "the moon is made of cheese" }), dataset).status).toBe("unsupported");
    expect(verifyFinding(finding({ citation_a: "99:01", exact_excerpt_a: "the moon" }), dataset).status).toBe("unsupported");
    expect(verifyFinding(finding({ citation_a: "99:01" }), dataset).status).toBe("wrong_reference");
    expect(verifyFinding(finding({ citation_a: "page ten" }), dataset).a.citation).toBe("unparsable");
  });
  it("rejects the wrong witness and two sides from one session", () => {
    expect(verifyFinding(finding({ witness: "Someone Else" }), dataset).identity).toContain("wrong_witness");
    expect(verifyFinding(finding({ session_b: "A", citation_b: "10:01", exact_excerpt_b: "Did you lock" }), dataset).identity).toContain("same_session");
  });
  it("shows when a side rests on an attorney's words", () => {
    expect(verifyFinding(finding({ citation_a: "10:01", exact_excerpt_a: "Did you lock the dock" }), dataset).a.speaker).toBe("attorney");
  });
  it("reads citation forms", () => {
    expect(parseCitation("148:05-149:02")).toEqual({ first: [148, 5], last: [149, 2] });
    expect(parseCitation("148:05–07")).toEqual({ first: [148, 5], last: [148, 7] });
  });
});

describe("the prompts", () => {
  const packet: PairPacket = { pairId: "R01", kind: "synthetic", witness: "W", a: { label: "A", description: "first", range: "10:01–10:02", before: [], lines: dataset.sessions[0].lines, after: [] }, b: { label: "B", description: "second", range: "20:01–20:02", before: [], lines: dataset.sessions[1].lines, after: [line(20, 3, "attorney", "Q. Next.")] } };
  it("carry testimony and citations, and nothing from earlier analysis", () => {
    for (const text of [discoveryPrompt(dataset), pairPrompt(packet)]) {
      expect(text).toContain("10:02 A. Yes, I locked it myself at nine.");
      expect(text).not.toMatch(/MODEL_|AI-PROPOSED|human_classification|statement card|topic map|false_positive|\{\{/);
    }
    expect(pairPrompt(packet)).toContain("[context] 20:03 Q. Next.");
  });
  it("shared instructions set no quota and ask for no number", () => {
    const system = readFileSync("experiments/multimodel-contradictions/prompts/system.md", "utf8");
    expect(system).toContain("no expected number of findings");
    expect(JSON.stringify(RUN_OUTPUT_JSON_SCHEMA)).not.toMatch(/"score"|"probability"|"confidence"|minLength/);
  });
});

describe("output validation", () => {
  const ok = { summary: { completion_status: "complete", limitations: [] }, findings: [finding()] };
  it("accepts an empty result, and records anything else as a failure", () => {
    expect(parseOutput(JSON.stringify({ ...ok, findings: [] })).error).toBeNull();
    expect(parseOutput("prose").error).toBe("not JSON");
    expect(parseOutput(null).error).toBe("no output");
    expect(parseOutput(JSON.stringify({ ...ok, findings: [{ ...finding(), confidence: 0.9 }] })).error).toBeTruthy();
  });
});

describe("the gate", () => {
  const plan: Plan = { arm: "C", experiment: "discovery", kind: "synthetic", calls: 1, worstCaseUsd: 0.5, fits: true };
  const approval: Approval = { approvedBy: "x", approvedOn: "d", allowExternalCalls: true, syntheticOnly: true, realTranscriptAuthorized: false, experiments: ["discovery", "probe"], arms: { C: { maxCalls: 2, maxUsd: 1 } } };
  const env = { EXPERIMENT_ALLOW_EXTERNAL: "true" };
  it("opens only when everything agrees", () => {
    expect(gateFailure(plan, approval, env, true)).toBeNull();
  });
  it("blocks by default, and on each missing permission", () => {
    expect(gateFailure(plan, approval, env, false)).toContain("dry run");
    expect(gateFailure(plan, approval, {}, true)).toContain("EXPERIMENT_ALLOW_EXTERNAL");
    expect(gateFailure(plan, null, env, true)).toContain("approval");
    expect(gateFailure({ ...plan, arm: "B" }, approval, env, true)).toContain("isn't approved");
    expect(gateFailure({ ...plan, calls: 3 }, approval, env, true)).toContain("calls exceed");
    expect(gateFailure({ ...plan, worstCaseUsd: 2 }, approval, env, true)).toContain("worst case");
  });
  it("never sends real testimony without its own authorization, and never truncates", () => {
    expect(gateFailure({ ...plan, kind: "real" }, approval, env, true)).toContain("real testimony");
    expect(gateFailure({ ...plan, kind: "real" }, { ...approval, syntheticOnly: false }, env, true)).toContain("real testimony");
    expect(gateFailure({ ...plan, fits: false }, approval, env, true)).toContain("doesn't fit");
  });
  it("refuses an experiment that wasn't approved, such as the pair benchmark", () => {
    expect(gateFailure({ ...plan, experiment: "pairs" }, approval, env, true)).toContain("isn't approved");
  });
  it("adds spending across runs, counting failed calls at their worst case", () => {
    const runs = [{ arm: "C", calls: 1, costUsd: 0.1, uncertainUsd: 0 }, { arm: "C", calls: 1, costUsd: 0, uncertainUsd: 0.3 }, { arm: "B", calls: 5, costUsd: 9, uncertainUsd: 0 }];
    expect(ledgerOf(runs, "C")).toEqual({ calls: 2, costUsd: 0.1, uncertainUsd: 0.3 });
  });
  it("stops before a call that could cross the cap", () => {
    expect(canAfford(0.5, 0.5, 1)).toBe(true);
    expect(canAfford(0.6, 0.5, 1)).toBe(false);
  });
});

describe("estimates", () => {
  const arm = { label: "x", provider: "x", kind: "external", contextTokens: 1000, contextVerified: true, maxOutputTokens: 500, rates: { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 } };
  it("reports fit and a worst case above the expected cost", () => {
    const e = estimate(arm, [3000], { charsPerToken: 3, expectedOutput: 100, maxOutput: 400 });
    expect(e).toMatchObject({ calls: 1, largestInputTokens: 1000, fits: false });
    expect(e.worstCaseUsd).toBeGreaterThan(e.expectedUsd);
    expect(estimate(arm, [300], { charsPerToken: 3, expectedOutput: 100, maxOutput: 400 }).fits).toBe(true);
  });
  it("a free arm costs nothing", () => {
    expect(costUsd({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, { input: 1e6, output: 1e6 })).toBe(0);
  });
});

describe("comparison", () => {
  it("merges findings citing the same lines, in either session order, and counts unique ones", () => {
    const flipped = item("B", { session_a: "B", citation_a: "20:02", exact_excerpt_a: "somebody else did", session_b: "A", citation_b: "10:02", exact_excerpt_b: "I locked it myself at nine" });
    const other = item("C", { citation_a: "10:01", exact_excerpt_a: "Did you lock", citation_b: "20:01", exact_excerpt_b: "Did you lock" });
    expect(clusterFindings([item("A"), flipped, other]).map((c) => c.arms)).toEqual([["A", "B"], ["C"]]);
    expect(discoverySummary([item("A"), flipped, other])).toMatchObject({ distinctProposed: 2, sharedByAtLeastTwoArms: 1, perArm: { C: { unique: 1 } } });
  });
  it("counts a known target only when both sides are found and it is called a conflict", () => {
    const target = { id: "t", a: ["10:01", "10:02"], b: ["20:01", "20:02"] };
    expect(recovered([target], [item("A")])).toEqual(["t"]);
    expect(recovered([target], [item("A", { classification: "compatible" })])).toEqual([]);
  });
  it("reports agreement without any labels", () => {
    const rows = [{ pairId: "R1", arm: "A", classification: "compatible", comparable: "no", citationStatus: "verified" }, { pairId: "R1", arm: "B", classification: "direct_contradiction", comparable: "no", citationStatus: "verified" }];
    expect(pairAgreement(rows)["A-B"]).toEqual({ pairs: 1, classification: 0, comparable: 1, disagreements: ["R1"] });
  });
  it("scores only against human-approved labels, and refuses AI-proposed ones", () => {
    const rows = [{ pairId: "R1", arm: "A", classification: "direct_contradiction", comparable: "yes", citationStatus: "verified" }];
    expect(() => pairAccuracy(rows, [{ pairId: "R1", classification: "compatible", comparable: "no", reviewer: "x", aiProposed: true }])).toThrow("not ground truth");
    expect(() => pairAccuracy(rows, [{ pairId: "R1", classification: "compatible", comparable: "no", reviewer: " ", aiProposed: false }])).toThrow();
    expect(pairAccuracy(rows, [{ pairId: "R1", classification: "compatible", comparable: "no", reviewer: "SA", aiProposed: false }]).A).toMatchObject({ correct: 0, falsePositives: 1 });
  });
});
