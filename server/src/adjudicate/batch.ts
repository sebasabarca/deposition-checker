// Batched adjudication: several independent candidates in one request, one verdict each. Pure: the
// packet format, how candidates are split into requests, and how a response is checked before any of
// it is stored. A verdict that passes here still goes through the same assess() as a single call.

import { z } from "zod";
import { quoteMatchScore } from "../verify";
import { PROMPTS } from "./prompt";
import type { Packet, PacketExchange, PacketLine } from "./packet";
import { VerdictV3, type Verdict } from "./schema";

export const BATCH_PROMPT_VERSION = "adjudicate-batch-v1";
// Configurable limits. Output: the largest verdict measured was 681 tokens (prompt v2, 18 calls), so
// each candidate gets 1,000, plus an allowance for thinking. The context limit keeps well inside
// the model's 1M window: fitting in a window doesn't mean a long structured response is reliable.
export type BatchLimits = { contextWindow: number; contextSafety: number; tokensPerChar: number; outputPerCandidate: number; outputOverhead: number; maxOutputTokens: number };
export const BATCH_LIMITS: BatchLimits = { contextWindow: 1_000_000, contextSafety: 0.5, tokensPerChar: 0.5, outputPerCandidate: 1_000, outputOverhead: 1_000, maxOutputTokens: 48_000 };

const V3 = PROMPTS["adjudicate-v3"].system;
const V3_INTRO = V3.slice(0, V3.indexOf("\n\nRead carefully:"));
const BATCH_INTRO = `You review sworn deposition testimony for a lawyer. You receive a batch of independent candidates. Each candidate is two exchanges from one witness, taken in two different deposition sessions (A and B), each with a few lines of context around it. For each candidate, decide whether the witness's testimony in one exchange is inconsistent with the other, and describe what you see in fixed categories. You never give a confidence, score, rating or probability: code verifies your citations and calculates any score.

Independence of candidates:
- Evaluate each candidate on its own, as if it were the only one you received.
- Never compare evidence across candidates, and never carry a fact, a date, a name, a context line or a conclusion from one candidate to another, even when they involve the same witness or the same subject.
- A contradiction must be supported by that candidate's two cited exchanges. Do not invent missing testimony, and do not infer a contradiction from unrelated context.
- Qualified testimony stays qualified. Uncertainty does not by itself eliminate a contradiction.
- A possible alternative explanation is not the same as one the evidence supports: keep them distinct with alternativeSupport.
- Return exactly one verdict for every candidate, and none for anything else. If a candidate can't be judged, classify it insufficient_evidence; never omit it.`;
const BATCH_FIELDS = `
- candidateId: the candidate's ID exactly as shown (for example "C1234"). Every other field refers only to that candidate.`;

export const BATCH_SYSTEM_PROMPT = (() => {
  if (!V3.startsWith(V3_INTRO) || !V3.includes("\n\nFields:")) throw new Error("adjudicate-v3 no longer has the expected shape.");
  return BATCH_INTRO + V3.slice(V3_INTRO.length).replace("\n\nFields:", `\n\nFields:${BATCH_FIELDS}`);
})();

export const BatchVerdict = VerdictV3.extend({ candidateId: z.string() });
export const BatchOutput = z.strictObject({ verdicts: z.array(BatchVerdict) });
const { $schema: _unused, ...batchJsonSchema } = z.toJSONSchema(BatchOutput);
export const BATCH_JSON_SCHEMA = batchJsonSchema;

export const candidateRef = (candidateId: number) => `C${candidateId}`;
const ref = (l: PacketLine) => `${l.page}:${String(l.line).padStart(2, "0")}`;
const show = (ls: readonly PacketLine[]) => ls.map((l) => `  ${ref(l)}  ${l.text}`).join("\n");

function formatSide(x: PacketExchange): string {
  return [
    `<session_${x.session.toLowerCase()} deposition="${x.depositionId}">`,
    ...(x.before.length ? [`Context before:\n${show(x.before)}`] : []),
    ...(x.gapBefore ? ["[pages omitted from the transcript here]"] : []),
    `Exchange [${x.id}] (${ref(x.lines[0])} to ${ref(x.lines[x.lines.length - 1])}):\n${show(x.lines)}`,
    ...(x.gapAfter ? ["[pages omitted from the transcript here]"] : []),
    ...(x.after.length ? [`Context after:\n${show(x.after)}`] : []),
    `</session_${x.session.toLowerCase()}>`,
  ].join("\n");
}

// The user message. Witnesses and sessions are stated once at the top; every candidate then carries
// its own complete evidence, whole, with nothing summarized and nothing shared between candidates.
export function formatBatch(packets: readonly Packet[]): string {
  const witnesses = new Map(packets.map((p) => [p.witnessId, p.witnessName]));
  const sessions = new Map(packets.flatMap((p) => [p.a, p.b]).map((x) => [x.depositionId, x.takenOn]));
  return [
    "<witnesses>",
    ...[...witnesses].map(([id, name]) => `W${id}: ${name}`),
    "</witnesses>",
    "<sessions>",
    ...[...sessions].map(([id, takenOn]) => `deposition ${id}: taken_on ${takenOn ?? "not stated"}`),
    "</sessions>",
    "",
    ...packets.flatMap((p) => [`<candidate id="${candidateRef(p.candidateId)}" witness="W${p.witnessId}">`, formatSide(p.a), formatSide(p.b), `Compare exchange [${p.a.id}] (session A) with exchange [${p.b.id}] (session B).`, "</candidate>", ""]),
    `Return one verdict for each of these ${packets.length} candidates: ${packets.map((p) => candidateRef(p.candidateId)).join(", ")}.`,
  ].join("\n");
}

export const batchOutputTokens = (n: number, limits: BatchLimits = BATCH_LIMITS) => n * limits.outputPerCandidate + limits.outputOverhead;
const promptChars = BATCH_SYSTEM_PROMPT.length + JSON.stringify(BATCH_JSON_SCHEMA).length;
export const estimateBatchInputTokens = (text: string, limits: BatchLimits = BATCH_LIMITS) => Math.ceil((text.length + promptChars) * limits.tokensPerChar);
export const batchFits = (text: string, n: number, limits: BatchLimits = BATCH_LIMITS) =>
  batchOutputTokens(n, limits) <= limits.maxOutputTokens && estimateBatchInputTokens(text, limits) + batchOutputTokens(n, limits) <= limits.contextWindow * limits.contextSafety;

export type PlannedBatch = { packets: Packet[]; text: string; splitReason: string | null };
export type BatchPlan = { batches: PlannedBatch[]; oversize: { packet: Packet; reason: string }[] };

// Groups candidates in rank order. A group that doesn't fit is closed early and the reason recorded;
// every candidate stays. A single candidate that can't fit fails explicitly: evidence is never cut.
export function planBatches(packets: readonly Packet[], size: number, limits: BatchLimits = BATCH_LIMITS): BatchPlan {
  const plan: BatchPlan = { batches: [], oversize: [] };
  let open: Packet[] = [];
  let splitReason: string | null = null;
  const close = () => {
    if (open.length > 0) plan.batches.push({ packets: open, text: formatBatch(open), splitReason });
    open = [];
    splitReason = null;
  };
  for (const packet of packets) {
    if (!batchFits(formatBatch([packet]), 1, limits)) {
      plan.oversize.push({ packet, reason: `its evidence alone exceeds the request limit (about ${estimateBatchInputTokens(formatBatch([packet]), limits)} input tokens)` });
      continue;
    }
    if (open.length > 0 && !batchFits(formatBatch([...open, packet]), open.length + 1, limits)) {
      splitReason = `closed at ${open.length} of ${size} candidates: the next would exceed the input or output limit`;
      close();
    }
    open.push(packet);
    if (open.length >= size) close();
  }
  close();
  return plan;
}

export type AcceptedVerdict = { packet: Packet; verdict: Verdict; raw: string; suspected: string[] };
export type RejectedVerdict = { packet: Packet; reason: string; raw: string; kind: "invalid" | "wrong_exchange" | "contaminated" };
export type BatchReading = {
  unusable: string | null; // the response can't be read or attributed at all
  accepted: AcceptedVerdict[];
  rejected: RejectedVerdict[];
  missing: number[]; // candidate IDs with no verdict
  duplicates: number[]; // candidate IDs answered more than once: none of the answers is kept
  unknown: string[]; // IDs in the response that aren't in the batch
};

const packetText = (x: PacketExchange) => [...x.before, ...x.lines, ...x.after].map((l) => l.text).join(" ");
const shownRefs = (p: Packet) => new Set([p.a, p.b].flatMap((x) => [...x.before, ...x.lines, ...x.after].map((l) => ref(l))));

// Other candidates' IDs named anywhere in a verdict, and key phrases that belong to another candidate
// and not this one. Either means this verdict drew on evidence it wasn't given.
function contaminationOf(verdict: Verdict, packet: Packet, others: readonly Packet[]): string | null {
  const own = new Set([packet.a.id, packet.b.id, candidateRef(packet.candidateId)]);
  const foreign = new Set(others.flatMap((p) => [p.a.id, p.b.id, candidateRef(p.candidateId)]).filter((id) => !own.has(id)));
  const named = [...JSON.stringify(verdict).matchAll(/\b[EC]\d+\b/g)].map((m) => m[0]).find((id) => foreign.has(id));
  if (named) return `it refers to ${named}, which belongs to another candidate`;
  const check = (phrase: string, mine: string) => {
    if (quoteMatchScore(phrase, mine) >= 0.6) return null;
    const source = others.find((p) => p !== packet && (quoteMatchScore(phrase, packetText(p.a)) >= 0.9 || quoteMatchScore(phrase, packetText(p.b)) >= 0.9));
    return source ? `its key phrase "${phrase.slice(0, 60)}" comes from ${candidateRef(source.candidateId)}` : null;
  };
  return check(verdict.keyPhraseA, packetText(packet.a)) ?? check(verdict.keyPhraseB, packetText(packet.b));
}

// Page:line references in the explanation that this candidate never showed but another did. Only
// suspected: "10:15" may be a time of day, so this is recorded for review and rejects nothing.
function suspectedReferences(verdict: Verdict, packet: Packet, others: readonly Packet[]): string[] {
  const mine = shownRefs(packet);
  const theirs = new Set(others.filter((p) => p !== packet).flatMap((p) => [...shownRefs(p)]));
  return [...verdict.explanation.matchAll(/\b\d{1,3}:\d{2}\b/g)].map((m) => m[0]).filter((r) => !mine.has(r) && theirs.has(r));
}

// A verdict the model filled in without reasoning. Pure.
export const MIN_EXPLANATION_CHARS = 40;
export const isDegenerate = (v: { explanation: string }) => v.explanation.trim().length < MIN_EXPLANATION_CHARS || /^(placeholder|todo|n\/a|tbd)\b/i.test(v.explanation.trim());

// Reads a batch response. One bad verdict never costs the good ones; only a response that can't be
// parsed or attributed is unusable. Nothing is invented for a missing candidate.
export function readBatch(packets: readonly Packet[], stopReason: string | null, text: string | null): BatchReading {
  const reading: BatchReading = { unusable: null, accepted: [], rejected: [], missing: [], duplicates: [], unknown: [] };
  // A cut-off response is incomplete JSON, and salvaging fragments of one is not safe attribution.
  if (stopReason === "refusal") return unusable(reading, packets, "the model refused");
  if (stopReason === "max_tokens") return unusable(reading, packets, "cut off at max_tokens");
  if (text === null) return unusable(reading, packets, `no structured output (stop reason ${stopReason})`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return unusable(reading, packets, "the output is not JSON");
  }
  const items = (json as { verdicts?: unknown })?.verdicts;
  if (!Array.isArray(items)) return unusable(reading, packets, "the output has no verdicts array");

  const byRef = new Map(packets.map((p) => [candidateRef(p.candidateId), p]));
  const groups = new Map<string, unknown[]>();
  for (const item of items) {
    const id = (item as { candidateId?: unknown })?.candidateId;
    if (typeof id !== "string" || !byRef.has(id)) {
      reading.unknown.push(typeof id === "string" ? id : "(no candidateId)");
      continue;
    }
    groups.set(id, [...(groups.get(id) ?? []), item]);
  }
  for (const packet of packets) {
    const answers = groups.get(candidateRef(packet.candidateId));
    if (!answers) {
      reading.missing.push(packet.candidateId);
      continue;
    }
    if (answers.length > 1) {
      reading.duplicates.push(packet.candidateId);
      continue;
    }
    const raw = JSON.stringify(answers[0]);
    const parsed = BatchVerdict.safeParse(answers[0]);
    if (!parsed.success) {
      reading.rejected.push({ packet, raw, kind: "invalid", reason: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ").slice(0, 2000) });
      continue;
    }
    const { candidateId: _id, ...verdict } = parsed.data;
    // Valid JSON is not an adjudication: a live batch returned "placeholder" as a direct verdict's explanation.
    if (isDegenerate(verdict)) {
      reading.rejected.push({ packet, raw, kind: "invalid", reason: `the explanation is not a real one: "${verdict.explanation.slice(0, 60)}"` });
      continue;
    }
    const contaminated = contaminationOf(verdict, packet, packets);
    if (contaminated) {
      reading.rejected.push({ packet, raw, kind: "contaminated", reason: `cross-candidate reference: ${contaminated}` });
      continue;
    }
    if (verdict.evidenceAId !== packet.a.id || verdict.evidenceBId !== packet.b.id) {
      reading.rejected.push({ packet, raw, kind: "wrong_exchange", reason: `it cites ${verdict.evidenceAId} and ${verdict.evidenceBId}, not ${packet.a.id} and ${packet.b.id}` });
      continue;
    }
    reading.accepted.push({ packet, verdict, raw, suspected: suspectedReferences(verdict, packet, packets) });
  }
  return reading;
}

function unusable(reading: BatchReading, packets: readonly Packet[], reason: string): BatchReading {
  return { ...reading, unusable: reason, missing: packets.map((p) => p.candidateId) };
}
