// Reading a compact packet reply (packet-c1/c2/c3, compactPrompt.ts; experimental, off by default). A compact reply
// screens every listed pair, then gives a full packet-v1 verdict only for the pairs it did not dismiss:
//   { "screen": [ { pairId, ...evaluation fields, disposition } ], "verdicts": [ packet-v1 PairVerdict ] }
// This file turns it into the packet-v1 verdict list the rest of the pipeline already reads (verify/packet.ts,
// packetAssess.ts, safeguards, scoring), so nothing downstream changes:
//   - a full verdict is passed through as it is: it is a packet-v1 verdict, verified and scored as today;
//   - a dismissal (disposition = a false-positive reason) becomes a packet-v1 false_positive verdict with no
//     citation, marked `compactDismissal`. It is stored as the pair's verdict and never becomes a finding
//     (packetAssess.ts): a code the model wrote is not verified evidence, so it is never shown as "compatible";
//   - a screen row saying "verdict" adds nothing itself: if its full verdict is missing the pair is missing, and a
//     pair both dismissed and given a full verdict is a duplicate, so the existing completeness handling (recovery
//     request, then incomplete) applies unchanged.
// Pure, and free of runtime imports from packetSchema.ts (which calls it), so there is no import cycle.

import { z } from "zod";
import type { MalformedVerdict, PairVerdict } from "./packetSchema";
import { FALSE_POSITIVE_REASONS } from "./schema";
import type { IssuePacket } from "./packetPrompt";
import { quoteMatchScore } from "../verify/quotes";

export const FULL_VERDICT = "verdict" as const;
export const DISPOSITIONS = [FULL_VERDICT, ...FALSE_POSITIVE_REASONS] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

// The screen row of each contract. Evaluation fields come before the disposition, so they are written first.
export const SCREEN_ROWS = {
  "packet-c1": z.strictObject({ pairId: z.string(), disposition: z.enum(DISPOSITIONS) }),
  // compared: a few words naming the two statements compared, written before the disposition.
  "packet-c2": z.strictObject({ pairId: z.string(), compared: z.string(), disposition: z.enum(DISPOSITIONS) }),
  // quoteA / quoteB: the shortest verbatim words of each exchange the reading rests on (checkable by code).
  "packet-c3": z.strictObject({ pairId: z.string(), quoteA: z.string(), quoteB: z.string(), disposition: z.enum(DISPOSITIONS) }),
} as const;
export type CompactContractId = keyof typeof SCREEN_ROWS;
export const COMPACT_CONTRACTS = Object.keys(SCREEN_ROWS) as CompactContractId[];
type AnyRow = { pairId: string; disposition: Disposition; compared?: string; quoteA?: string; quoteB?: string };

// What a dismissal keeps of the model's row, beside its packet-v1 form.
export type CompactDismissal = { disposition: Exclude<Disposition, typeof FULL_VERDICT>; compared?: string; quoteA?: string; quoteB?: string };
export type DismissalVerdict = PairVerdict & { compactDismissal: CompactDismissal };
export const isCompactDismissal = (v: object): v is DismissalVerdict => "compactDismissal" in v;

// A dismissal as a packet-v1 verdict: false_positive with its reason, nothing cited, nothing inferred. Evidence IDs are
// empty because the row names none; the verdict is never verified or scored (packetAssess.ts returns no finding).
export function dismissalVerdict(row: AnyRow): DismissalVerdict {
  const { pairId, disposition, ...seen } = row;
  if (disposition === FULL_VERDICT) throw new Error("a full-verdict row is not a dismissal");
  return {
    pairId, outcome: "false_positive", evidenceAId: "", evidenceBId: "", keyPhraseA: null, keyPhraseB: null,
    attributionA: "unclear", attributionB: "unclear", stanceA: "unclear", stanceB: "unclear", sameEvent: "uncertain", scopeAligned: "uncertain",
    conflictBasis: "none", conflictSource: "none", falsePositiveReason: disposition, explanation: seen.compared ?? "",
    alternativeExplanation: null, alternativeSupport: null, contextUsed: [], compactDismissal: { disposition, ...seen },
  };
}

const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ");
const pairIdOf = (raw: unknown) => { const id = (raw as { pairId?: unknown } | null)?.pairId; return typeof id === "string" ? id : null; };

// A parsed JSON reply in the compact shape -> packet-v1 verdicts (lenient: each bad row or verdict is reported, the
// rest kept), or null when the JSON is not a compact reply (so the caller reads it as packet-v1). `verdictItem` is
// the packet-v1 verdict schema, passed in by the caller; `contract` is the run's contract, and only its row shape is
// accepted (a c1 row without quotes inside a c3 reply is malformed).
export function readCompactReply(json: unknown, verdictItem: z.ZodType<PairVerdict>, contract: CompactContractId): { ok: true; verdicts: PairVerdict[]; malformed: MalformedVerdict[] } | { ok: false; error: string } | null {
  if (typeof json !== "object" || json === null || !("screen" in json)) return null;
  const { screen, verdicts: full, ...extra } = json as { screen: unknown; verdicts?: unknown };
  if (!Array.isArray(screen) || !Array.isArray(full)) return { ok: false, error: "schema: compact reply needs screen and verdicts arrays" };
  if (Object.keys(extra).length) return { ok: false, error: `schema: unexpected keys ${Object.keys(extra).join(", ")}` };
  const verdicts: PairVerdict[] = [];
  const malformed: MalformedVerdict[] = [];
  screen.forEach((raw, index) => {
    const row = (SCREEN_ROWS[contract] as z.ZodType<AnyRow>).safeParse(raw);
    if (!row.success) malformed.push({ index, pairId: pairIdOf(raw), error: `screen: ${issues(row.error)}` });
    else if (row.data.disposition !== FULL_VERDICT) verdicts.push(dismissalVerdict(row.data));
  });
  full.forEach((raw, index) => {
    const v = verdictItem.safeParse(raw);
    if (v.success) verdicts.push(v.data);
    else malformed.push({ index: screen.length + index, pairId: pairIdOf(raw), error: issues(v.error) });
  });
  // A pair both dismissed in the screen and given a full verdict (the model wrote the verdict "when in doubt" but left
  // the dismissal code): the full verdict is kept and the dismissal dropped, since only the full verdict carries
  // citations that code verifies. Two full verdicts, or two dismissals, for one pair stay duplicates.
  const judged = new Set(verdicts.filter((v) => !isCompactDismissal(v)).map((v) => v.pairId));
  return { ok: true, verdicts: verdicts.filter((v) => !(isCompactDismissal(v) && judged.has(v.pairId))), malformed };
}

// packet-c3's guard against lazy dismissal, checked by code: a dismissal's quoteA and quoteB must be words of the
// pair's own exchanges (A and B; every content word present, verify/quotes.ts). A dismissal whose quote is not
// found is not accepted: it is reported as malformed, so the pair goes through the existing recovery request and,
// failing that, stays unanswered (counted), never silently dismissed.
export const DISMISSAL_QUOTE_MIN_SCORE = 0.9;
export function checkDismissalQuotes<T extends { ok: true; verdicts: PairVerdict[]; malformed: MalformedVerdict[] }>(parsed: T, packet: IssuePacket): T {
  const passage = new Map(packet.passages.map((p) => [p.id, p.lines.map((l) => l.text).join(" ")]));
  const sides = new Map(packet.pairs.map((p) => [p.pairId, [passage.get(p.a) ?? "", passage.get(p.b) ?? ""] as const]));
  const verdicts: PairVerdict[] = [];
  const malformed = [...parsed.malformed];
  for (const v of parsed.verdicts) {
    const d = isCompactDismissal(v) ? v.compactDismissal : null;
    const ex = sides.get(v.pairId);
    if (!d || d.quoteA === undefined || !ex) { verdicts.push(v); continue; }
    const bad = ([["A", d.quoteA, ex[0]], ["B", d.quoteB ?? "", ex[1]]] as const).filter(([, q, text]) => !q.trim() || quoteMatchScore(q, text) < DISMISSAL_QUOTE_MIN_SCORE);
    if (bad.length) malformed.push({ index: -1, pairId: v.pairId, error: `dismissal quote${bad.length > 1 ? "s" : ""} not found in exchange ${bad.map(([s]) => s).join(" and ")}` });
    else verdicts.push(v);
  }
  return { ...parsed, verdicts, malformed };
}
