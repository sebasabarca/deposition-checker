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
