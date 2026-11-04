// The packet adjudication contract (Milestone 2, docs/milestone-2-handoff.md): one reply per evidence
// packet, with exactly one verdict per listed pair. The model classifies and reports categorical
// observations; it never returns a confidence, score, band or probability, and the strict objects reject
// any extra key. The same contract serves both arms of the evaluation: a pairwise request is a packet
// with two passages and one pair, so the arms differ only in grouping.

import { z } from "zod";
import { ALTERNATIVE_SUPPORT, ATTRIBUTIONS, CONFLICT_BASES, CONFLICT_SOURCES, CONTEXT_PURPOSES, FALSE_POSITIVE_REASONS, STANCES } from "./schema";

// Substantive outcomes, then the three abstentions. An abstention is a valid answer, never a failure.
export const SUBSTANTIVE_OUTCOMES = ["direct", "inferential", "false_positive"] as const;
export const ABSTENTIONS = ["insufficient_evidence", "needs_more_context", "unable_to_assess"] as const;
export const PACKET_OUTCOMES = [...SUBSTANTIVE_OUTCOMES, ...ABSTENTIONS] as const;
export type PacketOutcome = (typeof PACKET_OUTCOMES)[number];
export const CONFLICT_OUTCOMES: readonly PacketOutcome[] = ["direct", "inferential"];
export const isAbstention = (o: PacketOutcome) => (ABSTENTIONS as readonly string[]).includes(o);

const TRISTATE = ["yes", "no", "uncertain"] as const;

export const PairVerdict = z.strictObject({
  pairId: z.string(), // as listed in the packet ("R1"); completeness is checked in code
  outcome: z.enum(PACKET_OUTCOMES),
  evidenceAId: z.string(), // the pair's first passage ID; checked in code
  evidenceBId: z.string(),
  keyPhraseA: z.string().nullable(), // verbatim words, checked against the stored lines; null only for an abstention
  keyPhraseB: z.string().nullable(),
  attributionA: z.enum(ATTRIBUTIONS),
  attributionB: z.enum(ATTRIBUTIONS),
  stanceA: z.enum(STANCES),
  stanceB: z.enum(STANCES),
  sameEvent: z.enum(TRISTATE),
  scopeAligned: z.enum(TRISTATE),
  conflictBasis: z.enum(CONFLICT_BASES),
  conflictSource: z.enum(CONFLICT_SOURCES),
  falsePositiveReason: z.enum(FALSE_POSITIVE_REASONS).nullable(),
  explanation: z.string(),
  alternativeExplanation: z.string().nullable(),
  alternativeSupport: z.enum(ALTERNATIVE_SUPPORT).nullable(),
  contextUsed: z.array(z.strictObject({ lines: z.string(), purpose: z.enum(CONTEXT_PURPOSES) })),
});
export type PairVerdict = z.infer<typeof PairVerdict>;

export const PacketReply = z.strictObject({ verdicts: z.array(PairVerdict) });
export type PacketReply = z.infer<typeof PacketReply>;

const { $schema: _unused, ...packetJsonSchema } = z.toJSONSchema(PacketReply);
export const PACKET_REPLY_JSON_SCHEMA = packetJsonSchema;

// Parses a reply's text. A reply that isn't JSON, or breaks the schema, is a failed request: the caller
// counts every listed pair as unanswered, never as an outcome.
export function parsePacketReply(text: string | null): { ok: true; reply: PacketReply } | { ok: false; error: string } {
  if (text === null) return { ok: false, error: "no structured output" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "reply is not JSON" };
  }
  const parsed = PacketReply.safeParse(json);
  return parsed.success ? { ok: true, reply: parsed.data } : { ok: false, error: `schema: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` };
}

// ---------------------------------------------------------------------------------------------------
// packet-v2 (Milestone 2.5). v1 above is unchanged and stays available for comparison.
// v2 separates what v1 folded into "false_positive" or forced into a conflict: compatible testimony,
// a clarification or correction, and testimony that is secondhand or too uncertain to compare. A
// conflict must rest on concrete details from the cited lines (detailsCompared). A cited exchange may
// be the pair's own exchange or one shown next to it (an adjacent exchange of the same deposition):
// code records which, so support from context is never mistaken for the candidate exchange itself.
export const SUBSTANTIVE_OUTCOMES_V2 = ["direct", "inferential", "compatible", "clarification_or_correction", "secondhand_or_uncertain"] as const;
export const PACKET_OUTCOMES_V2 = [...SUBSTANTIVE_OUTCOMES_V2, ...ABSTENTIONS] as const;
export type PacketOutcomeV2 = (typeof PACKET_OUTCOMES_V2)[number];
// Outcomes that surface the pair to a lawyer for review, beyond the two conflict outcomes.
export const REVIEW_OUTCOMES_V2: readonly PacketOutcomeV2[] = ["clarification_or_correction", "secondhand_or_uncertain"];
export const DETAIL_RELATIONS_V2 = ["same", "different", "only_one"] as const;

export const PairVerdictV2 = z.strictObject({
  pairId: z.string(),
  outcome: z.enum(PACKET_OUTCOMES_V2),
  evidenceAId: z.string(), // the exchange cited for side A: its own exchange, or one shown adjacent to it
  evidenceBId: z.string(),
  keyPhraseA: z.string().nullable(), // verbatim; null only for an abstention
  keyPhraseB: z.string().nullable(),
  attributionA: z.enum(ATTRIBUTIONS),
  attributionB: z.enum(ATTRIBUTIONS),
  stanceA: z.enum(STANCES),
  stanceB: z.enum(STANCES),
  sameEvent: z.enum(TRISTATE),
  scopeAligned: z.enum(TRISTATE),
  // Each concrete detail compared, quoted from each side's cited lines ("" when only one side states it).
  detailsCompared: z.array(z.strictObject({ detail: z.string(), sideA: z.string(), sideB: z.string(), relation: z.enum(DETAIL_RELATIONS_V2) })),
  conflictBasis: z.enum(CONFLICT_BASES),
  conflictSource: z.enum(CONFLICT_SOURCES),
  explanation: z.string(),
  alternativeExplanation: z.string().nullable(),
  alternativeSupport: z.enum(ALTERNATIVE_SUPPORT).nullable(),
  contextUsed: z.array(z.strictObject({ lines: z.string(), purpose: z.enum(CONTEXT_PURPOSES) })),
});
export type PairVerdictV2 = z.infer<typeof PairVerdictV2>;
export const PacketReplyV2 = z.strictObject({ verdicts: z.array(PairVerdictV2) });
export type PacketReplyV2 = z.infer<typeof PacketReplyV2>;
const { $schema: _unusedV2, ...packetJsonSchemaV2 } = z.toJSONSchema(PacketReplyV2);
export const PACKET_REPLY_V2_JSON_SCHEMA = packetJsonSchemaV2;

export function parsePacketReplyV2(text: string | null): { ok: true; reply: PacketReplyV2 } | { ok: false; error: string } {
  if (text === null) return { ok: false, error: "no structured output" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "reply is not JSON" };
  }
  const parsed = PacketReplyV2.safeParse(json);
  return parsed.success ? { ok: true, reply: parsed.data } : { ok: false, error: `schema: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` };
}

// ---------------------------------------------------------------------------------------------------
// packet-v3 (Milestone 2.5, second round). v1 and v2 above are unchanged.
// v2's main citation failure was a phrase quoted from a neighbouring exchange under the passage's own ID.
// v3 attaches an exchange ID to every quote: each side lists up to three citations, each naming the exchange
// whose lines hold that exact quote (a question in one exchange and its answer in the next are two
// citations), and each compared detail points at the quote it rests on. The first citation of a side is
// its key statement, read by Layer 1 and 2 like v1/v2's key phrase.
const CitationV3 = z.strictObject({ exchangeId: z.string(), quote: z.string() });
const SideV3 = z.strictObject({
  citations: z.array(CitationV3), // 0 only for an abstention with nothing to cite; at most 3 (checked in code)
  attribution: z.enum(ATTRIBUTIONS),
  stance: z.enum(STANCES),
});
export const PairVerdictV3 = z.strictObject({
  pairId: z.string(),
  outcome: z.enum(PACKET_OUTCOMES_V2),
  sideA: SideV3,
  sideB: SideV3,
  sameEvent: z.enum(TRISTATE),
  scopeAligned: z.enum(TRISTATE),
  // Each compared detail with the exact words from each side's citations ("" when only one side states it).
  details: z.array(z.strictObject({ detail: z.string(), sideA: z.string(), sideB: z.string(), relation: z.enum(DETAIL_RELATIONS_V2) })),
  conflictBasis: z.enum(CONFLICT_BASES),
  explanation: z.string(),
  alternativeExplanation: z.string().nullable(),
  alternativeSupport: z.enum(ALTERNATIVE_SUPPORT).nullable(),
});
export type PairVerdictV3 = z.infer<typeof PairVerdictV3>;
export const PacketReplyV3 = z.strictObject({ verdicts: z.array(PairVerdictV3) });
const { $schema: _unusedV3, ...packetJsonSchemaV3 } = z.toJSONSchema(PacketReplyV3);
export const PACKET_REPLY_V3_JSON_SCHEMA = packetJsonSchemaV3;
export const MAX_CITATIONS_PER_SIDE = 3;

// Lenient reading of any version's reply: the valid verdicts are kept and each malformed one is reported
// (with its pairId when it has one), so one bad entry never sinks the others. A reply that isn't JSON, or
// has no verdicts array, fails as a whole. Nothing is repaired or rewritten.
export type MalformedVerdict = { index: number; pairId: string | null; error: string };
export function parseVerdictsLenient<T>(text: string | null, item: z.ZodType<T>): { ok: true; verdicts: T[]; malformed: MalformedVerdict[] } | { ok: false; error: string } {
  if (text === null) return { ok: false, error: "no structured output" };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "reply is not JSON" };
  }
  const list = (json as { verdicts?: unknown } | null)?.verdicts;
  if (!Array.isArray(list)) return { ok: false, error: "schema: no verdicts array" };
  const extra = Object.keys(json as object).filter((k) => k !== "verdicts");
  if (extra.length) return { ok: false, error: `schema: unexpected keys ${extra.join(", ")}` };
  const verdicts: T[] = [];
  const malformed: MalformedVerdict[] = [];
  list.forEach((raw, index) => {
    const parsed = item.safeParse(raw);
    if (parsed.success) verdicts.push(parsed.data);
    else {
      const id = (raw as { pairId?: unknown } | null)?.pairId;
      malformed.push({ index, pairId: typeof id === "string" ? id : null, error: parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ") });
    }
  });
  return { ok: true, verdicts, malformed };
}
export const VERDICT_SCHEMAS = { "packet-v1": PairVerdict, "packet-v2": PairVerdictV2, "packet-v3": PairVerdictV3 } as const;
