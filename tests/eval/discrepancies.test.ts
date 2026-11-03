// The limo/SUV regression: a real discrepancy, scored as two questions. Discovery fails when no proposal
// points at both passages, whatever its citations' quality; classification is only asked of a found pair.
// The recorded runs keep citations and classifications only, never testimony.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readDiscrepancyFile, scoreDiscrepancies, type DiscrepancyFile, type Proposal } from "../../server/src/eval";

const LABELS = "data/eval/hutchinson-discrepancies-v1.json";
const RUNS = JSON.parse(readFileSync("tests/fixtures/hutchinson-direct-runs.json", "utf8")) as Record<string, { model: string; proposals: Proposal[] }>;
const JUNE = "hutchinson-2022-06-20";
const SEPT = "hutchinson-2022-09-15";
const at = (a: string, b: string, modelClassification = "uncertain_needs_context"): Proposal => ({ a: { document: JUNE, citation: a }, b: { document: SEPT, citation: b }, modelClassification });

describe("limo/SUV discovery (hutchinson-discrepancies-v1)", () => {
  let labels: DiscrepancyFile;
  it("reads the label file", async () => {
    labels = await readDiscrepancyFile(LABELS);
    expect(labels.discrepancies.map((d) => d.id)).toContain("limo-suv");
  });

  it("counts Fable's analysis-16 run as having found it", async () => {
    labels ??= await readDiscrepancyFile(LABELS);
    const s = scoreDiscrepancies(labels, RUNS["fable-analysis-16"].proposals);
    expect(s.discovery).toEqual({ labelled: 1, found: 1, missed: [] });
  });

  it("reports Opus's run as a discovery failure, though every one of its citations verified", async () => {
    labels ??= await readDiscrepancyFile(LABELS);
    const s = scoreDiscrepancies(labels, RUNS["opus-2026-11-03"].proposals);
    expect(RUNS["opus-2026-11-03"].proposals.length).toBeGreaterThan(0);
    expect(s.discovery.missed).toEqual(["limo-suv"]);
    expect(s.results[0].classification.correct).toBeNull(); // nothing found, so nothing to classify
  });

  it("finds it from either session's side and from any labelled passage, and nowhere else", async () => {
    labels ??= await readDiscrepancyFile(LABELS);
    const flipped: Proposal = { a: { document: SEPT, citation: "34:20" }, b: { document: JUNE, citation: "5:21-5:22" }, modelClassification: "direct_contradiction" };
    expect(scoreDiscrepancies(labels, [flipped]).discovery.found).toBe(1);
    expect(scoreDiscrepancies(labels, [at("6:09-6:14", "33:07")]).discovery.found).toBe(0); // June side is a later answer
    expect(scoreDiscrepancies(labels, [at("6:04", "32:20")]).discovery.found).toBe(0); // September side is another remark
    expect(scoreDiscrepancies(labels, [{ ...at("6:04", "33:08"), b: { document: JUNE, citation: "33:08" } }]).discovery.found).toBe(0); // wrong session
  });
});

describe("limo/SUV classification, separate from discovery", () => {
  it("scores what a found pair was called against the label", async () => {
    const labels = await readDiscrepancyFile(LABELS);
    const expected = labels.discrepancies[0].classification.expected;
    const fable = scoreDiscrepancies(labels, RUNS["fable-analysis-16"].proposals).results[0].classification;
    expect(fable.readAs).toEqual(["context_dependent"]);
    expect(fable.correct).toBe(expected === "context_dependent");
    // The label is still a proposal: this flags it until a person decides.
    expect(labels.discrepancies[0].classification.status).toBe("provisional");
  });

  it("reads each model classification as a label class, and never as a correction", () => {
    const file: DiscrepancyFile = { version: 1, set: "t", about: "", documents: { [JUNE]: { sha256: "a".repeat(64), witness: "W", takenOn: "2022-06-20", source: "" }, [SEPT]: { sha256: "b".repeat(64), witness: "W", takenOn: "2022-09-15", source: "" } }, discrepancies: [{ id: "x", topic: "t", a: [{ document: JUNE, from: "6:04", to: "6:08" }], b: [{ document: SEPT, from: "33:07", to: "33:12" }], classification: { expected: "correction", status: "decided", decidedBy: "test", basis: "test" }, note: "" }] };
    const read = (c: string) => scoreDiscrepancies(file, [at("6:05", "33:08", c)]).results[0].classification;
    expect(read("direct_contradiction").readAs).toEqual(["direct_conflict"]);
    expect(read("inferential_contradiction").readAs).toEqual(["direct_conflict"]);
    expect(read("uncertain_needs_context").readAs).toEqual(["context_dependent"]);
    expect(read("compatible").readAs).toEqual(["no_conflict"]);
    expect(read("something_new").readAs).toEqual(["unknown"]);
    for (const c of ["direct_contradiction", "uncertain_needs_context", "compatible"]) expect(read(c).correct).toBe(false); // no prompt can say "correction" yet
  });
});
