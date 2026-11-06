// Structured-output schemas and output caps of the compact packet contracts (compactRead.ts, compactPrompt.ts), and
// the encoder that writes what a compact contract would emit for given packet-v1 verdicts (token accounting and test
// stand-ins only: it never stands for what a model would decide under the compact prompt). Pure.

import { z } from "zod";
import { COMPACT_CONTRACTS, FULL_VERDICT, SCREEN_ROWS, type CompactContractId } from "./compactRead";
import { PairVerdict } from "./packetSchema";

const replyOf = (c: CompactContractId) => z.strictObject({ screen: z.array(SCREEN_ROWS[c]), verdicts: z.array(PairVerdict) });
const jsonSchemaOf = (c: CompactContractId) => { const { $schema: _s, ...rest } = z.toJSONSchema(replyOf(c)); return rest; };
export const COMPACT_REPLY_JSON_SCHEMAS = { "packet-c1": jsonSchemaOf("packet-c1"), "packet-c2": jsonSchemaOf("packet-c2"), "packet-c3": jsonSchemaOf("packet-c3") };
export const compactReplySchema = replyOf;

// Enforced output cap per pair: the worst case is a screen row plus a full verdict. The largest packet-v1 verdict
// recorded was 533 tokens (MEASURED, 326 verdicts, experiments/first-analysis/packaging); a screen row's largest
// stand-in in experiments/first-analysis/compact/account.ts was 27 / 61 / 81 tokens (PROJECTED), rounded up; x2 margin.
// Plus a per-request envelope.
export const COMPACT_MAX_V1_VERDICT_TOKENS = 533;
export const COMPACT_OUTPUT_MARGIN = 2;
const ROW_BOUND: Record<CompactContractId, number> = { "packet-c1": 30, "packet-c2": 70, "packet-c3": 100 };
export const COMPACT_MAX_OUTPUT_TOKENS_PER_PAIR: Record<CompactContractId, number> = Object.fromEntries(COMPACT_CONTRACTS.map((c) => [c, Math.ceil((COMPACT_MAX_V1_VERDICT_TOKENS + ROW_BOUND[c]) * COMPACT_OUTPUT_MARGIN)])) as Record<CompactContractId, number>;
export const COMPACT_ENVELOPE_TOKENS = 50;

const words = (s: string | null | undefined, n: number) => (s ?? "").split(/\s+/).filter(Boolean).slice(0, n).join(" ");

// The compact reply carrying the same decisions as these packet-v1 verdicts: false positives become screen rows with
// their reason, everything else a row "verdict" plus the verdict. Evaluation fields are stand-ins of realistic length
// taken from the v1 verdict (c2: the first twelve words of its explanation; c3: the first twelve words of each key phrase).
export function encodeCompact(contract: CompactContractId, v1: readonly PairVerdict[]): { screen: { pairId: string; disposition: string; compared?: string; quoteA?: string; quoteB?: string }[]; verdicts: PairVerdict[] } {
  const screen = v1.map((v) => {
    const disposition = v.outcome === "false_positive" ? (v.falsePositiveReason ?? "both_can_be_true") : FULL_VERDICT;
    if (contract === "packet-c1") return { pairId: v.pairId, disposition };
    if (contract === "packet-c2") return { pairId: v.pairId, compared: words(v.explanation, 12), disposition };
    return { pairId: v.pairId, quoteA: words(v.keyPhraseA, 12), quoteB: words(v.keyPhraseB, 12), disposition };
  });
  return { screen, verdicts: v1.filter((v) => v.outcome !== "false_positive") };
}
