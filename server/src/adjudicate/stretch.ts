// Reading a whole-stretch reply (contract "stretch-v2"): parse it strictly, verify every finding's citations with
// production's packet verifier (verify/packet.ts, unchanged), then give each original pair exactly one status
// derived from the verified evidence, never from the model's own ledger. Ported from the candidate-reduction
// experiment (stretch/v2/contract.ts parseAndVerify, stretch/v2/reconcile.ts). Pure: no I/O.
//
// Statuses (one per original pair):
//   flagged                a finding cites exactly this pair's two exchanges (A from stretch A), in its unit, and
//                          code verified its citations
//   flagged_unverified     a finding cites exactly this pair, but its citations failed verification or it was filed
//                          under another unit: shown, unscored, check manually
//   unclear                the model said it can't tell, and no finding cites the pair
//   no_conflict_identified checked, and no finding cites the pair. NOT proof of compatibility: never shown as
//                          "compatible", never a finding
//   incomplete             its unit or ledger entry is missing, or the reply failed: not read (recovery, then the
//                          entry ends incomplete)
// `related` (an attribute): another finding of the unit cites one of the pair's exchanges. Never made a conflict.
// When the model's channels disagree (its ledger against its own findings), the verified finding stands and an
// INCONSISTENT audit note is kept. Findings on exchanges that are not an original pair are counted, not published.

import { verifyPacketReply, type PacketPairVerification, type PacketVerification } from "../verify/packet";
import { mockPacketReply } from "../eval/mockPacketModel";
import type { IssuePacket } from "./packetPrompt";
import { formatStretchRequest, requestUnits, STRETCH_V2_SYSTEM_PROMPT, StretchReplyV2, type RequestUnit, type StretchFinding } from "./stretchPrompt";

export type StretchStatus = "flagged" | "flagged_unverified" | "unclear" | "no_conflict_identified" | "incomplete";
export type StretchPairResult = { pairId: string; unitId: string | null; status: StretchStatus; related: boolean; modelStatus: string | null; audit: string[]; finding: StretchFinding | null };
type Checked = { unitId: string; f: StretchFinding; inUnit: boolean; citation: string | null; verified: boolean; diagnoses: string[] };
export type StretchReading = {
  ok: boolean;
  error: string | null;
  problems: string[];
  pairs: StretchPairResult[];
  // The flagged and flagged_unverified pairs as packet-v1 verdicts, verified against the request's own pairs: what
  // production persistence and scoring read (jobs/caseRun.ts persist, adjudicate assessPacketPair).
  verification: PacketVerification;
  outsidePairs: number; // findings on two exchanges that are not an original pair of their unit: kept in the raw reply only
};

const swap = (f: StretchFinding): StretchFinding => ({ ...f, evidenceAId: f.evidenceBId, evidenceBId: f.evidenceAId, keyPhraseA: f.keyPhraseB, keyPhraseB: f.keyPhraseA, attributionA: f.attributionB, attributionB: f.attributionA, stanceA: f.stanceB, stanceB: f.stanceA });

export function readStretchReply(packet: IssuePacket, text: string | null): StretchReading {
  const units = requestUnits(packet);
  const failed = (error: string): StretchReading => ({ ok: false, error, problems: [error], pairs: units.flatMap((u) => u.pairs.map((p) => ({ pairId: p.pairId, unitId: u.unitId, status: "incomplete" as const, related: false, modelStatus: null, audit: [`reply failed: ${error}`], finding: null }))), verification: verifyPacketReply(packet, { ok: true, reply: { verdicts: [] } }), outsidePairs: 0 });
  if (text === null) return failed("no structured output");
  let json: unknown;
  try { json = JSON.parse(text); } catch { return failed("reply is not JSON"); }
  const parsed = StretchReplyV2.safeParse(json);
  if (!parsed.success) return failed(`schema: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  const reply = parsed.data;
  const byId = new Map(units.map((u) => [u.unitId, u]));
  const problems: string[] = [];
  const seen = reply.units.map((u) => u.unitId);
  for (const id of byId.keys()) if (!seen.includes(id)) problems.push(`unit ${id} missing`);
  for (const id of new Set(seen)) { if (!byId.has(id)) problems.push(`unknown unit ${id}`); else if (seen.filter((x) => x === id).length > 1) problems.push(`unit ${id} repeated`); }
  const answered = new Set(seen.filter((id) => byId.has(id)));

  // Every finding's citations, checked by production's verifier against the request's passages.
  const flat = reply.units.flatMap((u) => u.findings.map((f) => ({ unitId: u.unitId, f })));
  const v = flat.length ? verifyPacketReply({ id: packet.id, passages: packet.passages, pairs: flat.map((x, n) => ({ pairId: `F${n + 1}`, a: x.f.evidenceAId, b: x.f.evidenceBId })) }, { ok: true, reply: { verdicts: flat.map((x, n) => ({ ...x.f, pairId: `F${n + 1}`, falsePositiveReason: null })) } }) : null;
  const checked: Checked[] = flat.map((x, n) => {
    const u = byId.get(x.unitId);
    const inUnit = !!u && u.a.includes(x.f.evidenceAId) && u.b.includes(x.f.evidenceBId);
    const ver = v?.pairs[n] ?? null;
    const citation = ver?.source?.status ?? null;
    const diagnoses = [ver?.source?.a?.diagnosis, ver?.source?.b?.diagnosis].filter((d): d is NonNullable<typeof d> => !!d).map(String);
    return { unitId: x.unitId, f: x.f, inUnit, citation, verified: inUnit && citation === "verified", diagnoses: inUnit ? diagnoses : ["outside_its_unit", ...diagnoses] };
  });
  const ledger = new Map<string, string[]>();
  for (const l of reply.ledger) (ledger.get(l.pairId) ?? ledger.set(l.pairId, []).get(l.pairId)!).push(l.status);
  for (const id of ledger.keys()) if (!units.some((u) => u.pairs.some((p) => p.pairId === id))) problems.push(`ledger: unknown ${id}`);

  const originals = new Set(units.flatMap((u) => u.pairs.flatMap((p) => [`${p.a}|${p.b}`, `${p.b}|${p.a}`])));
  const outsidePairs = checked.filter((c) => !originals.has(`${c.f.evidenceAId}|${c.f.evidenceBId}`)).length;

  const pairs = units.flatMap((u: RequestUnit) => u.pairs.map((p): StretchPairResult => {
    const audit: string[] = [];
    const statuses = ledger.get(p.pairId) ?? [];
    if (statuses.length > 1) audit.push(`ledger lists this pair ${statuses.length} times (${statuses.join(", ")})`);
    const model = statuses[0] ?? null;
    const exact = checked.filter((c) => c.f.evidenceAId === p.a && c.f.evidenceBId === p.b);
    const reversed = checked.filter((c) => c.f.evidenceAId === p.b && c.f.evidenceBId === p.a);
    if (reversed.length) audit.push(`${reversed.length} finding(s) cite this pair with the sides swapped (A from stretch B): not counted`);
    const verified = exact.filter((c) => c.verified && c.unitId === u.unitId);
    const related = checked.some((c) => c.unitId === u.unitId && !exact.includes(c) && (c.f.evidenceAId === p.a || c.f.evidenceBId === p.b));
    let status: StretchStatus;
    let finding: StretchFinding | null = null;
    if (verified.length) {
      status = "flagged";
      finding = verified[0].f;
      if (model === "unclear") audit.push("INCONSISTENT: model ledger said unclear, but its own verified finding cites this pair; the finding stands");
      if (model === null) audit.push("INCOMPLETE LEDGER: no ledger status; a verified finding covers this pair, so it is flagged");
    } else if (exact.length) {
      status = "flagged_unverified";
      finding = exact[0].f;
      audit.push(...exact.map((c) => `finding not verified: ${c.inUnit ? "" : "filed under another unit; "}citation ${c.citation ?? "none"}${c.diagnoses.length ? ` (${c.diagnoses.join(", ")})` : ""}`));
      if (model === "unclear") audit.push("INCONSISTENT: model ledger said unclear, but its own (unverified) finding cites this pair");
    } else if (!answered.has(u.unitId) || model === null) {
      status = "incomplete";
      audit.push(!answered.has(u.unitId) ? "unit missing from the reply" : "no ledger status");
    } else status = model === "unclear" ? "unclear" : "no_conflict_identified";
    return { pairId: p.pairId, unitId: u.unitId, status, related, modelStatus: model, audit, finding };
  }));

  // The flagged pairs as packet-v1 verdicts on the request's own pairs (oriented as the packet lists them), so
  // persistence, scoring and the review UI treat them exactly as packet-v1 findings.
  const verdicts = pairs.flatMap((r) => {
    if (!r.finding) return [];
    const pair = packet.pairs.find((x) => x.pairId === r.pairId)!;
    const f = r.finding.evidenceAId === pair.a ? r.finding : swap(r.finding);
    return [{ ...f, pairId: r.pairId, falsePositiveReason: null }];
  });
  const verification = verifyPacketReply(packet, { ok: true, reply: { verdicts } });
  return { ok: true, error: null, problems, pairs, verification, outsidePairs };
}

export const verificationOf = (reading: StretchReading, pairId: string): PacketPairVerification | undefined => reading.verification.pairs.find((p) => p.pairId === pairId && p.status === "answered" && !!p.verdict);

// The label-blind mock in the stretch-v2 contract, from packet-v1's mock (eval/mockPacketModel.ts): its `direct`
// pairs become findings in their units, its abstentions `unclear`, the rest `checked`. A stretch run on the test
// model therefore flags exactly the pairs a packet-v1 test run calls direct. Measures the pipeline, never quality.
export function mockStretchReply(packet: IssuePacket, options: { drop?: string[]; garble?: boolean } = {}) {
  if (options.garble) return { text: "{not json", usage: { inputTokens: 0, outputTokens: 0 } };
  const v1 = new Map((JSON.parse(mockPacketReply(packet).text) as { verdicts: (StretchFinding & { pairId: string; falsePositiveReason: unknown; outcome: string })[] }).verdicts.map((v) => [v.pairId, v]));
  const drop = new Set(options.drop ?? []);
  const units = requestUnits(packet).map((u) => ({
    unitId: u.unitId,
    findings: u.pairs.flatMap((p) => {
      const v = v1.get(p.pairId);
      if (!v || drop.has(p.pairId) || v.outcome !== "direct") return [];
      const { pairId: _p, falsePositiveReason: _f, ...f } = v;
      return [f.evidenceAId === p.a ? f : swap(f)];
    }),
  }));
  const ledger = requestUnits(packet).flatMap((u) => u.pairs.filter((p) => !drop.has(p.pairId)).map((p) => ({ pairId: p.pairId, status: (v1.get(p.pairId)?.outcome as string | undefined) === "insufficient_evidence" ? ("unclear" as const) : ("checked" as const) })));
  const findings = units.reduce((n, u) => n + u.findings.length, 0);
  return { text: JSON.stringify({ units, ledger }), usage: { inputTokens: Math.ceil((STRETCH_V2_SYSTEM_PROMPT.length + formatStretchRequest(packet).length) / 3.5), outputTokens: 350 * findings + 15 * ledger.length } };
}
