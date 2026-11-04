import type { IssuePacket } from "../adjudicate/packetPrompt";
import type { PacketOutcome } from "../adjudicate/packetSchema";
import { callCost, type CallTokens } from "../costs";
import type { FrozenPair } from "../retrieve/frozen";
import type { EvidencePacket } from "../retrieve/grouping";
import { kindOf, targetClassOf, type PairKind, type TargetClass } from "./retrievalEval";

export type Label = { id: string; kind: PairKind; targetClass: TargetClass | null };
export type PilotSample = {
  corpus: string; evidence: "real" | "synthetic"; seed: number; quota: number;
  packetIds: string[]; reasons: Record<string, "target" | "control" | "exploratory" | "random">;
  labelledCovered: string[]; labelledNotInSample: string[]; labelledInNoPacket: string[];
};

const joins = (p: FrozenPair, a: string, b: string) => (p.left.includes(a) && p.right.includes(b)) || (p.left.includes(b) && p.right.includes(a));

export function labelFor(pairs: FrozenPair[], a: string, b: string): Label | null {
  const p = pairs.find((x) => joins(x, a, b));
  return p ? { id: p.id, kind: kindOf(p.category), targetClass: targetClassOf(p.category) } : null;
}

function mulberry32(seed: number) {
  let x = seed >>> 0;
  return () => { x = (x + 0x6d2b79f5) | 0; let t = Math.imul(x ^ (x >>> 15), 1 | x); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function selectPilotSample(input: { corpus: string; evidence: "real" | "synthetic"; packets: EvidencePacket[]; labels: FrozenPair[]; quota: number; seed: number }): PilotSample {
  const { corpus, evidence, packets, labels, quota, seed } = input;
  const packetLabels = (packet: EvidencePacket) => new Set(packet.pairs.flatMap(([a, b]) => labels.filter((p) => joins(p, a, b)).map((p) => p.id)));
  const byPacket = new Map(packets.map((p) => [p.id, packetLabels(p)]));
  const selected = new Set<string>();
  const reasons: PilotSample["reasons"] = {};
  const covered = new Set<string>();
  for (const kind of ["target", "control", "exploratory"] as const) {
    while (selected.size < quota) {
      const choices = packets.filter((p) => !selected.has(p.id) && kind === (p.pairs.flatMap(([a, b]) => labels.filter((l) => joins(l, a, b))).find((l) => kindOf(l.category) === kind) ? kind : "none"));
      const ranked = choices.map((p) => ({ p, n: [...byPacket.get(p.id)!].filter((id) => !covered.has(id)).filter((id) => kindOf(labels.find((l) => l.id === id)!.category) === kind).length })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n || a.p.id.localeCompare(b.p.id));
      const next = ranked[0]?.p;
      if (!next) break;
      selected.add(next.id); reasons[next.id] = kind; for (const id of byPacket.get(next.id)!) covered.add(id);
    }
  }
  const random = packets.filter((p) => !selected.has(p.id) && byPacket.get(p.id)!.size === 0);
  const rand = mulberry32(seed);
  for (let i = random.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [random[i], random[j]] = [random[j], random[i]]; }
  for (const p of random) { if (selected.size >= quota) break; selected.add(p.id); reasons[p.id] = "random"; }
  const selectedIds = packets.filter((p) => selected.has(p.id)).map((p) => p.id);
  const inAny = new Set([...byPacket.values()].flatMap((x) => [...x]));
  const coveredIds = labels.filter((p) => selectedIds.some((id) => byPacket.get(id)!.has(p.id))).map((p) => p.id);
  return { corpus, evidence, seed, quota, packetIds: selectedIds, reasons, labelledCovered: coveredIds, labelledNotInSample: labels.filter((p) => !coveredIds.includes(p.id)).map((p) => p.id), labelledInNoPacket: labels.filter((p) => !inAny.has(p.id)).map((p) => p.id) };
}

export type PairResult = { corpus: string; evidence: "real" | "synthetic"; packetId: string; a: string; b: string; pairStatus: "answered" | "missing" | "duplicate" | "request_failed"; outcome: PacketOutcome | null; sourceStatus: "verified" | "approximate" | "not_cited" | "wrong_reference" | "wrong_pair_reference" | "unsupported" | null; citationsValid: boolean; attributionErrors: number; consistencyIssues: number };
// Pair-level counts; a labelled pair is scored once, from its best row (a side can hold several items).
export type EvidenceScore = {
  total: number; buckets: Record<string, number>; identifiedTargets: number;
  // Identified with no attribution error and no consistency issue in the model's own verdict.
  identifiedClean: string[];
  identifiedTargetsByClass: Record<TargetClass, string[]>; flaggedWithoutValidCitations: string[]; missedTargets: Record<string, string[]>;
  flaggedControls: string[]; controlsNotFlagged: string[];
  abstentions: Record<string, number>; unanswered: Record<string, number>;
  validCitationRate: { citedPairs: number; validPairs: number }; attributionErrors: number; consistencyIssues: number;
  unlabelled: Record<string, number>; exploratory: Record<string, number>; unknown: Record<string, number>;
};
export type ArmReport = { evidence: Record<"real" | "synthetic" | "combined", EvidenceScore>; identifiedTargets: number };

const CONFLICT = new Set(["direct", "inferential"]);
const ABSTAIN = new Set(["insufficient_evidence", "needs_more_context", "unable_to_assess"]);
const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
// How a target's rows rank: identified with valid citations, flagged without them, then each kind of miss.
const targetRank = (r: PairResult) => (r.pairStatus !== "answered" ? 0 : CONFLICT.has(r.outcome!) ? (r.citationsValid ? 3 : 2) : 1);

const empty = (): EvidenceScore => ({ total: 0, buckets: {}, identifiedTargets: 0, identifiedClean: [], identifiedTargetsByClass: { direct: [], needs_context: [], unclassified: [] }, flaggedWithoutValidCitations: [], missedTargets: {}, flaggedControls: [], controlsNotFlagged: [], abstentions: {}, unanswered: {}, validCitationRate: { citedPairs: 0, validPairs: 0 }, attributionErrors: 0, consistencyIssues: 0, unlabelled: {}, exploratory: {}, unknown: {} });

function scoreRows(rows: PairResult[], labels: FrozenPair[]) {
  const out = empty();
  out.total = rows.length;
  const targets = new Map<string, { label: Label; best: PairResult }>();
  const controls = new Map<string, boolean>();
  for (const r of rows) {
    const key = r.pairStatus === "answered" ? r.outcome! : r.pairStatus;
    bump(out.buckets, key);
    if (r.pairStatus !== "answered") bump(out.unanswered, r.pairStatus);
    else if (ABSTAIN.has(r.outcome!)) bump(out.abstentions, r.outcome!);
    if (r.sourceStatus !== null && r.sourceStatus !== "not_cited") out.validCitationRate.citedPairs++;
    if (r.citationsValid) out.validCitationRate.validPairs++;
    out.attributionErrors += r.attributionErrors;
    out.consistencyIssues += r.consistencyIssues;
    const label = labelFor(labels, r.a, r.b);
    // Unlabelled evidence is unknown: counted by outcome, never scored as a false positive.
    if (!label) { bump(out.unlabelled, key); continue; }
    if (label.kind === "exploratory" || label.kind === "unknown") { bump(out[label.kind], key); continue; }
    if (label.kind === "control") { controls.set(label.id, (controls.get(label.id) ?? false) || (r.pairStatus === "answered" && CONFLICT.has(r.outcome!))); continue; }
    const seen = targets.get(label.id);
    if (!seen || targetRank(r) > targetRank(seen.best)) targets.set(label.id, { label, best: r });
  }
  for (const { label, best } of targets.values()) {
    const rank = targetRank(best);
    if (rank === 3) {
      out.identifiedTargets++;
      out.identifiedTargetsByClass[label.targetClass!].push(label.id);
      if (best.attributionErrors === 0 && best.consistencyIssues === 0) out.identifiedClean.push(label.id);
    }
    else if (rank === 2) out.flaggedWithoutValidCitations.push(label.id);
    else (out.missedTargets[best.pairStatus === "answered" ? best.outcome! : best.pairStatus] ??= []).push(`${label.id}:${label.targetClass}`);
  }
  for (const [id, flagged] of controls) (flagged ? out.flaggedControls : out.controlsNotFlagged).push(id);
  return out;
}
export function scoreArm(arm: "pairwise" | "packet", rows: PairResult[], labels: FrozenPair[]) {
  void arm;
  const real = scoreRows(rows.filter((r) => r.evidence === "real"), labels); const synthetic = scoreRows(rows.filter((r) => r.evidence === "synthetic"), labels); const combined = scoreRows(rows, labels);
  return { evidence: { real, synthetic, combined }, identifiedTargets: combined.identifiedTargets } satisfies ArmReport;
}

export function costOf(arm: "pairwise" | "packet", usages: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }[], model: string, identifiedTargets: number) {
  const tokens: CallTokens = { input: usages.reduce((n, x) => n + x.inputTokens, 0), output: usages.reduce((n, x) => n + x.outputTokens, 0), cacheRead: usages.reduce((n, x) => n + (x.cacheReadTokens ?? 0), 0), cacheWrite5m: usages.reduce((n, x) => n + (x.cacheWriteTokens ?? 0), 0), cacheWrite1h: 0 };
  const cost = callCost(model, tokens); const costUsd = cost?.costUsd ?? null; return { arm, ...tokens, totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite5m + tokens.cacheWrite1h, costUsd, priceVersion: cost?.priceVersion ?? null, costPerIdentifiedTarget: identifiedTargets && costUsd !== null ? costUsd / identifiedTargets : null };
}

export function estimateRequestCost(input: { systemChars: number; userChars: number; schemaChars: number; systemBytes: number; userBytes: number; schemaBytes: number; maxOutputTokens: number; retries: number; pairs: number; model: string }) {
  // Expected: ordinary text averages 3.5 chars/token; output is 350 verdict tokens plus 1,500 thinking tokens per pair request.
  // Worst case: UTF-8 bytes are a conservative one-token-per-byte input bound, and every retry uses max output.
  const expectedInput = Math.ceil((input.systemChars + input.userChars + input.schemaChars) / 3.5); const expectedOutput = 1500 + 350 * input.pairs;
  const worstInput = input.systemBytes + input.userBytes + input.schemaBytes; const worstOutput = input.maxOutputTokens * (1 + input.retries);
  const expected = callCost(input.model, { input: expectedInput, output: expectedOutput, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 }); const worstCase = callCost(input.model, { input: worstInput * (1 + input.retries), output: worstOutput, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
  return { expected: { tokens: expectedInput + expectedOutput, usd: expected?.costUsd ?? null }, worstCase: { tokens: worstInput * (1 + input.retries) + worstOutput, usd: worstCase?.costUsd ?? null } };
}
