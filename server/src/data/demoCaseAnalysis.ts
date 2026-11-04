// A hand-authored whole-case analysis of the demo case (server/src/data/demoCase.ts), supplied by the
// developer as JSON (schema veredict-demo-analysis/v1): all six session pairs of its four sessions compared
// by hand. No model produced it and no pipeline ran it: its provenance says so and the app shows it.
// Citations are file lines of the sessions' original text; api/caseAnalysis.ts resolves each to the stored
// transcript lines and shows only those. Pure data.
//
// Edited from the supplied JSON (November 4, 2026), with the developer's approval: the summaries of F-001,
// F-002, F-005 and F-006 said the witness "later says" what they said in the earlier (March) session; they
// now name the sessions in order. Nothing else was changed.

import { z } from "zod";

const Citation = z.object({ session_id: z.string(), file: z.string(), line_start: z.number().int().positive(), line_end: z.number().int().positive() }).strict();
export const CaseAnalysisSchema = z.object({
  schema: z.literal("veredict-demo-analysis/v1"),
  case: z.object({ id: z.string(), name: z.string(), synthetic: z.boolean() }).strict(),
  provenance: z.object({
    origin: z.literal("hand_authored_demo"), source_basis: z.string(), authoring_method: z.string(),
    live_model_execution: z.literal(false), model: z.null(), analysis_run_id: z.null(),
  }).strict(),
  execution: z.object({ status: z.literal("not_run"), paid_calls: z.literal(0), cost_usd: z.literal(0), claims_live_analysis: z.literal(false) }).strict(),
  sessions: z.array(z.object({ id: z.string(), witness: z.string(), date: z.string(), source_file: z.string() }).strict()),
  pairwise_coverage: z.array(z.object({ pair_id: z.string(), session_ids: z.tuple([z.string(), z.string()]), relationship: z.enum(["within_witness", "cross_witness"]), status: z.enum(["complete", "deferred", "unprocessed"]), finding_count: z.number().int().nonnegative() }).strict()),
  findings: z.array(z.object({
    id: z.string(), pair_id: z.string(), relationship: z.enum(["within_witness", "cross_witness"]),
    classification: z.enum(["incompatible", "uncertain", "compatible"]), priority: z.enum(["high", "medium", "low"]),
    topic: z.string(), summary: z.string(), source_citations: z.tuple([Citation, Citation]),
  }).strict()),
  coverage: z.object({
    sessions_total: z.number(), witnesses_total: z.number(), unique_pairs_total: z.number(), pairs_complete: z.number(), pairs_deferred: z.number(), pairs_unprocessed: z.number(),
    findings_total: z.number(), findings_by_classification: z.record(z.string(), z.number()), coverage_claim: z.string(),
  }).strict(),
});
export type CaseAnalysis = z.infer<typeof CaseAnalysisSchema>;

// The demo case it belongs to (demoCase.ts names it).
export const CASE_ANALYSIS_FOR = "Sample case: Harbor Street warehouse fire";
// The date each fact-checked finding edit was made, shown with the analysis.
export const CASE_ANALYSIS_EDITS = "F-001, F-002, F-005 and F-006 reworded on November 4, 2026 to name the sessions in date order; their content is unchanged.";

const cite = (session: string, start: number, end: number) => {
  const [, witness, date] = session.match(/^(owen|elena)-(\d{4}-\d{2}-\d{2})$/)!;
  return { session_id: session, file: `transcripts/${witness === "owen" ? "owen-calder" : "elena-marsh"}-${date}-demo.txt`, line_start: start, line_end: end };
};

export const DEMO_CASE_ANALYSIS: CaseAnalysis = CaseAnalysisSchema.parse({
  schema: "veredict-demo-analysis/v1",
  case: { id: "harbor-street-synthetic-demo", name: "Harbor Street synthetic demonstration case", synthetic: true },
  provenance: {
    origin: "hand_authored_demo", source_basis: "four uploaded synthetic deposition transcripts", authoring_method: "manual comparison of cited transcript statements",
    live_model_execution: false, model: null, analysis_run_id: null,
  },
  execution: { status: "not_run", paid_calls: 0, cost_usd: 0, claims_live_analysis: false },
  sessions: [
    { id: "owen-2024-08-21", witness: "Owen Calder", date: "2024-08-21", source_file: "transcripts/owen-calder-2024-08-21-demo.txt" },
    { id: "owen-2024-03-12", witness: "Owen Calder", date: "2024-03-12", source_file: "transcripts/owen-calder-2024-03-12-demo.txt" },
    { id: "elena-2024-08-20", witness: "Elena Marsh", date: "2024-08-20", source_file: "transcripts/elena-marsh-2024-08-20-demo.txt" },
    { id: "elena-2024-03-11", witness: "Elena Marsh", date: "2024-03-11", source_file: "transcripts/elena-marsh-2024-03-11-demo.txt" },
  ],
  pairwise_coverage: [
    { pair_id: "owen-2024-03-12__owen-2024-08-21", session_ids: ["owen-2024-03-12", "owen-2024-08-21"], relationship: "within_witness", status: "complete", finding_count: 3 },
    { pair_id: "elena-2024-03-11__elena-2024-08-20", session_ids: ["elena-2024-03-11", "elena-2024-08-20"], relationship: "within_witness", status: "complete", finding_count: 6 },
    { pair_id: "owen-2024-08-21__elena-2024-08-20", session_ids: ["owen-2024-08-21", "elena-2024-08-20"], relationship: "cross_witness", status: "complete", finding_count: 3 },
    { pair_id: "owen-2024-08-21__elena-2024-03-11", session_ids: ["owen-2024-08-21", "elena-2024-03-11"], relationship: "cross_witness", status: "complete", finding_count: 1 },
    { pair_id: "owen-2024-03-12__elena-2024-08-20", session_ids: ["owen-2024-03-12", "elena-2024-08-20"], relationship: "cross_witness", status: "complete", finding_count: 1 },
    { pair_id: "owen-2024-03-12__elena-2024-03-11", session_ids: ["owen-2024-03-12", "elena-2024-03-11"], relationship: "cross_witness", status: "complete", finding_count: 1 },
  ],
  findings: [
    { id: "F-001", pair_id: "owen-2024-03-12__owen-2024-08-21", relationship: "within_witness", classification: "incompatible", priority: "high", topic: "bay four pallets",
      summary: "In March, Owen said bay four was completely empty when he left on October 14; in August, he said he staged new pallets in bay four after dinner.",
      source_citations: [cite("owen-2024-08-21", 6, 7), cite("owen-2024-03-12", 6, 7)] },
    { id: "F-002", pair_id: "owen-2024-03-12__owen-2024-08-21", relationship: "within_witness", classification: "incompatible", priority: "high", topic: "smoking on loading dock",
      summary: "In March, Owen said he does not smoke and did not smoke on the loading dock that night; in August, he said he spent his break on the loading dock having a cigarette.",
      source_citations: [cite("owen-2024-08-21", 9, 10), cite("owen-2024-03-12", 9, 10)] },
    { id: "F-003", pair_id: "owen-2024-03-12__owen-2024-08-21", relationship: "within_witness", classification: "compatible", priority: "low", topic: "fire drill",
      summary: "The statements concern different drills: February versus March 3, so they do not directly conflict.",
      source_citations: [cite("owen-2024-08-21", 12, 13), cite("owen-2024-03-12", 12, 13)] },
    { id: "F-004", pair_id: "elena-2024-03-11__elena-2024-08-20", relationship: "within_witness", classification: "compatible", priority: "low", topic: "night shift headcount",
      summary: "Six people on October 14 is consistent with usually eight people and two call-outs on the fourteenth.",
      source_citations: [cite("elena-2024-08-20", 6, 7), cite("elena-2024-03-11", 6, 7)] },
    { id: "F-005", pair_id: "elena-2024-03-11__elena-2024-08-20", relationship: "within_witness", classification: "incompatible", priority: "high", topic: "valve room",
      summary: "In March, Elena said she never went into the valve room that night; in August, she said she checked the valve room around eleven.",
      source_citations: [cite("elena-2024-08-20", 9, 10), cite("elena-2024-03-11", 9, 10)] },
    { id: "F-006", pair_id: "elena-2024-03-11__elena-2024-08-20", relationship: "within_witness", classification: "incompatible", priority: "high", topic: "location when fire started",
      summary: "In March, Elena said she had already left the building and was in the parking lot when the fire started; in August, she said she saw smoke while still on the floor.",
      source_citations: [cite("elena-2024-08-20", 12, 13), cite("elena-2024-03-11", 12, 13)] },
    { id: "F-007", pair_id: "elena-2024-03-11__elena-2024-08-20", relationship: "within_witness", classification: "incompatible", priority: "high", topic: "evacuation time",
      summary: "Elena gives an evacuation time of twelve thirty in one session and about 1:40 a.m. in the other.",
      source_citations: [cite("elena-2024-08-20", 15, 16), cite("elena-2024-03-11", 15, 16)] },
    { id: "F-008", pair_id: "elena-2024-03-11__elena-2024-08-20", relationship: "within_witness", classification: "uncertain", priority: "medium", topic: "equipment cage keys",
      summary: "One answer says Elena does not know who had the keys; the other expresses belief that Owen had them. This is not a direct factual contradiction because the confidence and question framing differ.",
      source_citations: [cite("elena-2024-08-20", 18, 19), cite("elena-2024-03-11", 18, 19)] },
    { id: "F-009", pair_id: "elena-2024-03-11__elena-2024-08-20", relationship: "within_witness", classification: "compatible", priority: "low", topic: "fire department call",
      summary: "Both sessions say Elena called the fire department after reaching the outside.",
      source_citations: [cite("elena-2024-08-20", 21, 22), cite("elena-2024-03-11", 21, 22)] },
    { id: "F-010", pair_id: "owen-2024-08-21__elena-2024-08-20", relationship: "cross_witness", classification: "uncertain", priority: "medium", topic: "equipment cage keys",
      summary: "Owen says he gave the keys to Elena before leaving; Elena says she does not know who had them. The accounts leave ownership or handoff unresolved.",
      source_citations: [cite("owen-2024-08-21", 15, 16), cite("elena-2024-08-20", 18, 19)] },
    { id: "F-011", pair_id: "owen-2024-08-21__elena-2024-08-20", relationship: "cross_witness", classification: "compatible", priority: "low", topic: "bay four and smoke",
      summary: "Owen's account places pallets in bay four and Elena's account places smoke in bay four; these statements can coexist.",
      source_citations: [cite("owen-2024-08-21", 6, 7), cite("elena-2024-08-20", 12, 13)] },
    { id: "F-012", pair_id: "owen-2024-08-21__elena-2024-08-20", relationship: "cross_witness", classification: "compatible", priority: "low", topic: "night shift roles",
      summary: "Owen identifies as a night forklift operator and Elena identifies as the night shift lead; the roles are consistent.",
      source_citations: [cite("owen-2024-08-21", 3, 4), cite("elena-2024-08-20", 3, 4)] },
    { id: "F-013", pair_id: "owen-2024-08-21__elena-2024-03-11", relationship: "cross_witness", classification: "uncertain", priority: "medium", topic: "keys and usual practice",
      summary: "Owen says he gave Elena the keys; Elena says she believes Owen usually had them on Mondays. This supports a possible handoff but does not establish what happened that night.",
      source_citations: [cite("owen-2024-08-21", 15, 16), cite("elena-2024-03-11", 18, 19)] },
    { id: "F-014", pair_id: "owen-2024-03-12__elena-2024-08-20", relationship: "cross_witness", classification: "compatible", priority: "low", topic: "equipment cage keys",
      summary: "Owen says he had the keys on his belt, while Elena's account does not identify another holder; the statements can coexist.",
      source_citations: [cite("owen-2024-03-12", 15, 16), cite("elena-2024-08-20", 18, 19)] },
    { id: "F-015", pair_id: "owen-2024-03-12__elena-2024-03-11", relationship: "cross_witness", classification: "compatible", priority: "low", topic: "keys and usual practice",
      summary: "Owen says he had the keys; Elena says she believes Owen usually had them on Mondays. The statements are mutually consistent, though the date-specific fact remains limited.",
      source_citations: [cite("owen-2024-03-12", 15, 16), cite("elena-2024-03-11", 18, 19)] },
  ],
  coverage: {
    sessions_total: 4, witnesses_total: 2, unique_pairs_total: 6, pairs_complete: 6, pairs_deferred: 0, pairs_unprocessed: 0, findings_total: 15,
    findings_by_classification: { incompatible: 5, uncertain: 3, compatible: 7 },
    coverage_claim: "All six session pairs were manually compared for this demo fixture; this is comparison coverage, not live model or production-pipeline coverage.",
  },
});
