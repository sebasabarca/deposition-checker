import { describe, it, expect } from "vitest";
import { scoreFindings } from "../server/src/analyze";
import { parseTranscript } from "../server/src/transcript";
import { TRANSCRIPT_1, TRANSCRIPT_2 } from "../server/src/data/samples";
import type { Candidate } from "../server/src/schema";

const t1 = parseTranscript(TRANSCRIPT_1, "T1");
const t2 = parseTranscript(TRANSCRIPT_2, "T2");

const homeVsOut: Candidate = {
  t1_id: "T1-1",
  t2_id: "T2-1",
  t1_quote: "I was at home all evening.",
  t2_quote:
    "I think I went out briefly to get some groceries, maybe around 7:30, but came right back.",
  proposed_type: "direct",
  explanation: "Home all evening vs went out.",
};

const sleep: Candidate = {
  t1_id: "T1-3",
  t2_id: "T2-4",
  t1_quote: "Around 10, maybe 10:30.",
  t2_quote: "Midnight maybe.",
  proposed_type: "inferential",
  explanation: "Sleep time moved.",
};

const pizzaTimes: Candidate = {
  t1_id: "T1-1",
  t2_id: "T2-1",
  t1_quote: "I ordered pizza around 7pm and watched TV.",
  t2_quote: "maybe around 7:30, but came right back.",
  proposed_type: "false_positive",
  explanation: "Approximate times.",
};

describe("scoreFindings", () => {
  it("gives a verified direct contradiction found in every run high confidence and top priority", () => {
    const [finding] = scoreFindings(
      [[homeVsOut], [homeVsOut], [homeVsOut]],
      t1,
      t2,
    );
    expect(finding.status).toBe("verified");
    expect(finding.band).toBe("high");
    expect(finding.priority).toBe(1);
  });

  it("marks an invented quote as unverified with no confidence score, even if Claude says direct", () => {
    const invented = {
      ...homeVsOut,
      t2_quote: "I drove to the warehouse at 9.",
    };
    const [finding] = scoreFindings(
      [[invented], [invented], [invented]],
      t1,
      t2,
    );
    expect(finding.status).toBe("unverified");
    expect(finding.confidence).toBeNull();
    expect(finding.priority).toBe(5);
  });

  it("detects a real quote cited under the wrong question ID", () => {
    const wrongId = { ...homeVsOut, t1_id: "T1-2" };
    const [finding] = scoreFindings([[wrongId]], t1, t2);
    expect(finding.status).toBe("unverified");
    expect(finding.reasons[0]).toContain("found in T1-1");
  });

  it("lowers confidence when runs disagree on the type", () => {
    const asInferential = {
      ...homeVsOut,
      proposed_type: "inferential" as const,
    };
    const [finding] = scoreFindings(
      [[homeVsOut], [homeVsOut], [asInferential]],
      t1,
      t2,
    );
    expect(finding.runsAgreeing).toBe(2);
    expect(finding.band).toBe("medium");
  });

  it("gives low confidence to a pair found in only one of three runs", () => {
    const [finding] = scoreFindings([[homeVsOut], [], []], t1, t2);
    expect(finding.band).toBe("low");
  });

  it("chooses the more cautious type when runs are tied", () => {
    const asInferential = {
      ...homeVsOut,
      proposed_type: "inferential" as const,
    };
    const [finding] = scoreFindings([[homeVsOut], [asInferential]], t1, t2);
    expect(finding.type).toBe("inferential");
  });

  it("counts a pair reported twice in the same run only once", () => {
    const [finding] = scoreFindings([[homeVsOut, homeVsOut]], t1, t2);
    expect(finding.runsAgreeing).toBe(1);
  });

  it("confirms an inferential contradiction when the times cannot overlap", () => {
    const [finding] = scoreFindings([[sleep], [sleep], [sleep]], t1, t2);
    expect(finding.timeCheck.status).toBe("incompatible");
    expect(finding.confidence).toBe(100);
  });

  it("caps confidence when Claude calls overlapping times a contradiction", () => {
    const wrongLabel = { ...pizzaTimes, proposed_type: "direct" as const };
    const [finding] = scoreFindings(
      [[wrongLabel], [wrongLabel], [wrongLabel]],
      t1,
      t2,
    );
    expect(finding.confidence).toBeLessThanOrEqual(60);
    expect(finding.reasons.join(" ")).toContain("challenges this label");
  });

  it("places false positives below real contradictions", () => {
    const findings = scoreFindings([[pizzaTimes, sleep]], t1, t2);
    expect(findings[0].type).toBe("inferential");
    expect(findings[1].type).toBe("false_positive");
  });
});
