// Verification of directly discovered findings, on hand-built lines shaped like the Hutchinson
// failures. Pure: no model, no database.
import { describe, expect, it } from "vitest";
import type { DiscoveryFinding } from "../../server/src/adjudicate/discoverSchema";
import { evidenceKey, groupDuplicates, verifyDirectFinding, type StoredLine, type StoredSession } from "../../server/src/verify";

let nextId = 1;
const line = (page: number, n: number, text: string, role = "witness", ocrConfidence: number | null = 95): StoredLine => ({ id: nextId++, page, line: n, pdfPage: page + 2, text, role, ocrConfidence });

const june: StoredSession = { label: "A", depositionId: 1, lines: [
  line(5, 21, "the Beast, which was something along the lines of"),
  line(6, 6, "the cab of the Presidential limo and went to grab at the steering"),
  line(10, 2, "When I was in the Eisenhower Building, I believe |saw him. But we never personally"),
  line(10, 3, "spoke about that incident again."),
  line(35, 21, "Ms. Cheney. You described for us three different camps inside the", "attorney"),
  line(35, 22, "White House.", "attorney"),
  line(48, 5, "Q It appears you were having conversations with Ben", "attorney"),
  line(48, 8, "through at least February. Is that right?", "attorney"),
  line(48, 9, "A That's correct."),
  line(50, 1, "Ms. Hutchinson. I did not recall.", "witness"),
  line(60, 1, "P| Can I ask some followup on that?", "unknown"),
  line(61, 1, "Q Did you see him?", "attorney"),
  line(61, 2, "A I think I saw him there."),
  line(62, 1, "A We left at noon, I don't recall."),
] };
const sept: StoredSession = { label: "B", depositionId: 2, lines: [
  line(33, 9, "referencing what happened in the Presidential SUV on January 6th."),
  line(23, 9, "he lost. But we're going to keep trying.", "witness", 78),
  line(40, 1, "Mr. Hunt. You said it was the limo?", "attorney"),
  line(40, 2, "Ms. Hutchinson. I don't recall."),
] };
const sessions = [june, sept] as const;

const finding = (over: Partial<DiscoveryFinding> = {}): DiscoveryFinding => ({
  finding_id: "F1", witness: "Cassidy Hutchinson", session_a: "A", citation_a: "6:06", exact_excerpt_a: "the cab of the Presidential limo", session_b: "B", citation_b: "33:09", exact_excerpt_b: "the Presidential SUV",
  shared_subject: "the vehicle", comparable: "yes", classification: "direct_contradiction", factual_proposition_a: "a", factual_proposition_b: "b", conflict_basis: "c", explanation: "e", alternative_explanation: "", missing_context: "", confidence_rationale: "r", ...over,
});
const verify = (over: Partial<DiscoveryFinding> = {}) => verifyDirectFinding(finding(over), sessions, "Cassidy Hutchinson");

describe("direct finding verification", () => {
  it("accepts a finding only when both sides are the witness's, at the cited lines", () => {
    const c = verify();
    expect(c).toMatchObject({ evidenceStatus: "verified", lane: "contradictions", a: { quote: "exact", speaker: "witness", level: "clear" } });
  });

  it("holds a finding from unnumbered text at needs context, however clear it is", () => {
    const text: StoredSession = { label: "B", depositionId: 3, lines: [line(0, 240, "referencing what happened in the Presidential SUV on January 6th.")] };
    const c = verifyDirectFinding(finding({ citation_b: "0:240" }), [june, text], "Cassidy Hutchinson");
    expect(c).toMatchObject({ evidenceStatus: "verified", lane: "needs_context" });
    expect(c.reasons.join(" ")).toMatch(/not an official citation/);
  });

  it("holds a finding from a PDF without printed line numbers at needs context", () => {
    const c = verifyDirectFinding(finding(), [june, { ...sept, physicalLines: true }], "Cassidy Hutchinson");
    expect(c).toMatchObject({ evidenceStatus: "verified", lane: "needs_context", b: { physicalLines: true }, a: { physicalLines: false } });
    expect(c.reasons.join(" ")).toMatch(/counts the lines on the page and is not an official line number/);
  });

  it("rejects an invented quotation, and never repairs it", () => {
    const c = verify({ exact_excerpt_b: "the Presidential motorcade was stopped" });
    expect(c.evidenceStatus).toBe("unsupported");
    expect(c.lane).toBe("unverified");
  });

  it("calls a real quotation at the wrong line a wrong reference", () => {
    const c = verify({ citation_b: "23:09" });
    expect(c.evidenceStatus).toBe("wrong_reference");
    expect(c.lane).toBe("unverified");
  });

  it("rejects citations that don't resolve or don't parse", () => {
    expect(verify({ citation_a: "999:01" }).a.resolved).toBe(false);
    expect(verify({ citation_a: "page six" }).lane).toBe("unverified");
    expect(verify({ citation_a: "6:09-6:02" }).a.resolved).toBe(false);
  });

  // June 35:21: a committee member's words, once stored as the witness's.
  it("won't accept an attorney's words as the witness's assertion", () => {
    const c = verify({ citation_a: "35:21-35:22", exact_excerpt_a: "three different camps inside the White House" });
    expect(c.a.speaker).toBe("attorney_only");
    expect(c.evidenceStatus).toBe("verified"); // the quotation is real: the speaker is what fails
    expect(c.lane).toBe("unverified");
  });

  it("accepts an attorney's proposition the witness plainly adopted", () => {
    const c = verify({ citation_a: "48:05-48:09", exact_excerpt_a: "you were having conversations with Ben" });
    expect(c.a.speaker).toBe("adopted");
    expect(c.lane).toBe("contradictions");
  });

  it("sends an unidentified speaker to a person, never to testimony", () => {
    const c = verify({ citation_a: "60:01", exact_excerpt_a: "Can I ask some followup on that?" });
    expect(c.a.speaker).toBe("unknown");
    expect(c.lane).toBe("needs_context");
  });

  it("keeps a hedge and a lack of recollection in view", () => {
    expect(verify({ citation_a: "61:02", exact_excerpt_a: "I think I saw him there" }).a).toMatchObject({ level: "qualified", qualifier: expect.any(String) });
    const noRecall = verify({ citation_a: "40:02", session_a: "B", session_b: "A", citation_b: "6:06", exact_excerpt_a: "I don't recall", exact_excerpt_b: "the cab of the Presidential limo" });
    expect(noRecall.a.noRecall).toBe(true);
    expect(noRecall.lane).toBe("needs_context");
  });

  it("marks reported speech", () => {
    const told = { ...june, lines: [line(70, 1, "A Mark told me that he had left.")] };
    expect(verifyDirectFinding(finding({ citation_a: "70:01", exact_excerpt_a: "Mark told me that he had left" }), [told, sept], "Cassidy Hutchinson").a.reportedSpeech).toBe(true);
  });

  it("flags OCR it doubts, and sends the finding to a person, however exact the match", () => {
    const c = verify({ citation_b: "23:09", exact_excerpt_b: "he lost. But we're going to keep trying." });
    expect(c.b.quote).toBe("exact");
    expect(c.b.ocr).toEqual({ read: true, minConfidence: 78, lowLines: ["23:09"] });
    expect(c.lane).toBe("needs_context");
  });

  it("matches through an OCR bar, leaving the stored line as read", () => {
    expect(verify({ citation_a: "10:02-10:03", exact_excerpt_a: "I believe I saw him. But we never personally spoke about that incident again." }).a.quote).toBe("exact");
    expect(june.lines[2].text).toContain("|saw");
  });

  it("keeps model doubt out of the contradictions lane", () => {
    expect(verify({ classification: "uncertain_needs_context" }).lane).toBe("needs_context");
    expect(verify({ comparable: "uncertain" }).lane).toBe("needs_context");
    expect(verify({ classification: "compatible" }).lane).toBe("compatible");
  });

  it("rejects a finding for another witness, or within one session", () => {
    expect(verify({ witness: "Someone Else" }).lane).toBe("unverified");
    expect(verify({ session_b: "A", citation_b: "6:06", exact_excerpt_b: "Presidential limo" }).lane).toBe("unverified");
  });
});

describe("deduplication", () => {
  const f = (a: number[], b: number[], lane: "contradictions" | "needs_context" = "contradictions", swap = false) => {
    const [x, y] = [{ depositionId: 1, lineIds: a }, { depositionId: 2, lineIds: b }];
    return swap ? { a: y, b: x, lane } : { a: x, b: y, lane };
  };

  it("treats A–B and B–A as one pair, with one key", () => {
    expect(groupDuplicates([f([1, 2], [8, 9]), f([1, 2], [8, 9], "contradictions", true)])).toHaveLength(1);
    expect(evidenceKey({ depositionId: 1, lineIds: [2, 1] }, { depositionId: 2, lineIds: [9] })).toBe(evidenceKey({ depositionId: 2, lineIds: [9] }, { depositionId: 1, lineIds: [1, 2] }));
  });

  it("merges overlapping excerpts of one assertion, and keeps every original", () => {
    const groups = groupDuplicates([f([1, 2, 3], [8, 9]), f([2, 3], [9])]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });

  it("keeps findings apart when only one side overlaps", () => {
    expect(groupDuplicates([f([1, 2], [8]), f([1, 2], [20])])).toHaveLength(2);
    expect(groupDuplicates([f([1], [8]), f([2], [8])])).toHaveLength(2);
  });

  it("shows the most cautious copy", () => {
    expect(groupDuplicates([f([1, 2], [8]), f([1, 2], [8], "needs_context")])[0][0].lane).toBe("needs_context");
  });

  it("gives the same groups in any order, and again on its own output", () => {
    const items = [f([1, 2], [8]), f([2, 3], [8, 9]), f([30], [40]), f([31], [41], "needs_context")];
    const once = groupDuplicates(items);
    expect(groupDuplicates([...items].reverse())).toEqual(once);
    expect(groupDuplicates(once.flat())).toEqual(once);
  });
});
