// Does grouped ("packet") adjudication get worse as packets grow? Read-only analysis of saved paid runs:
// no database, no model, no API call. Each pair's packet-arm result is compared with its own pairwise-arm
// result on the same evidence, so the pair's difficulty is held fixed (docs/packet-size-analysis.md).
//
//   npx tsx scripts/packet-size-analysis.ts [--root data/raw/packet-pilot] [--runs pilot-run:packet-v1,v2-eval:packet-v2]
//                                           [--out data/raw/packet-pilot/size-analysis]
//
// Each run folder needs pairs.json and replies.json (scripts/packet-benchmark.ts run + rescore). Writes
// <out>/size-analysis.json (counts and item keys, no testimony) and prints a summary. Rows with repeat=true are
// kept out of the main tables and only feed the repeat-variance note.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const SIZE_BINS = [[1, 1], [2, 3], [4, 5], [6, 8], [9, Infinity]] as const;
export const TOKEN_BINS = [[0, 4999], [5000, 5999], [6000, 6999], [7000, Infinity]] as const;
const CONFLICTS = ["direct", "inferential"];
const INDICATORS = ["unanswered", "invalidCitation", "consistency", "attribution", "anyError"] as const;
export type Indicator = (typeof INDICATORS)[number];

type Side = { source?: string | null; cited?: string | null; attribution?: { disagreement?: string | null } | null } | null;
export type PairRow = {
  arm: "packet" | "pairwise"; repeat: boolean; corpus: string; packetId: string; request: string; pairId: string;
  a: string; b: string; status: string; outcome: string | null; validationFailures: string[]; sideA: Side; sideB: Side;
};
type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
export type ReplyRow = { arm: "packet" | "pairwise"; corpus: string; packetId: string; repeat?: boolean; reply: { text: string | null; usage: Usage; stopReason?: string | null; error?: string } };
export type Verdict = Record<string, unknown> & { pairId: string; outcome: string };

// The verify/packet.ts consistency rules for both prompt versions (packet-v1 has falsePositiveReason, v2 has
// detailsCompared). pairs.json does not store them, so they are re-derived from the saved reply.
export function consistencyIssues(v: Verdict): string[] {
  const issues: string[] = [];
  const conflict = CONFLICTS.includes(v.outcome);
  if (conflict && v.conflictSource !== "cited_exchanges") issues.push("ungrounded");
  if ("falsePositiveReason" in v) {
    if (v.outcome !== "false_positive" && v.falsePositiveReason !== null) issues.push("false_positive_reason_on_non_false_positive");
    if (v.outcome === "false_positive" && v.falsePositiveReason === null) issues.push("false_positive_reason_missing");
  } else {
    const details = Array.isArray(v.detailsCompared) ? (v.detailsCompared as { relation?: string }[]) : [];
    if (v.outcome === "direct" && !details.some((d) => d.relation === "different")) issues.push("direct_without_different_detail");
    if (v.outcome === "direct" && v.conflictBasis === "requires_inference") issues.push("direct_requires_inference");
    if (conflict && details.length === 0) issues.push("conflict_without_details");
  }
  if (!conflict && v.conflictBasis !== "none") issues.push("conflict_basis_on_non_conflict");
  if ((v.alternativeExplanation === null) !== (v.alternativeSupport === null)) issues.push("alternative_support_mismatch");
  return issues;
}

export function verdictsOf(text: string | null): Verdict[] {
  if (!text) return [];
  try {
    const j = JSON.parse(text) as { verdicts?: Verdict[] };
    return Array.isArray(j.verdicts) ? j.verdicts : [];
  } catch {
    return [];
  }
}

export type Flags = Record<Indicator, boolean>;
export function indicatorsOf(row: PairRow, verdict: Verdict | null): Flags {
  const unanswered = row.status !== "answered";
  // Citation failures are the source and same-passage checks (and a substantive outcome with no phrase);
  // "missing verdict" and API errors are counted as unanswered instead.
  const invalidCitation = !unanswered && row.validationFailures.some((f) => /source|passage|phrase/.test(f));
  const consistency = !unanswered && verdict !== null && consistencyIssues(verdict).length > 0;
  const attribution = !unanswered && [row.sideA, row.sideB].some((s) => (s?.attribution?.disagreement ?? null) !== null);
  return { unanswered, invalidCitation, consistency, attribution, anyError: unanswered || invalidCitation || consistency || attribution };
}

export const binLabel = (n: number, bins: readonly (readonly [number, number])[]) => {
  const [lo, hi] = bins.find(([l, h]) => n >= l && n <= h)!;
  return hi === Infinity ? `${lo}+` : lo === hi ? `${lo}` : `${lo}-${hi}`;
};

// Spearman's rho with average ranks for ties; null when either side is constant or n < 3.
export function spearman(x: number[], y: number[]): number | null {
  if (x.length !== y.length || x.length < 3) return null;
  const rank = (v: number[]) => {
    const order = v.map((value, i) => ({ value, i })).sort((p, q) => p.value - q.value);
    const r = new Array<number>(v.length);
    for (let s = 0; s < order.length; ) {
      let e = s;
      while (e + 1 < order.length && order[e + 1].value === order[s].value) e++;
      for (let k = s; k <= e; k++) r[order[k].i] = (s + e) / 2 + 1;
      s = e + 1;
    }
    return r;
  };
  const rx = rank(x), ry = rank(y);
  const mean = (v: number[]) => v.reduce((n, a) => n + a, 0) / v.length;
  const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < rx.length; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return dx === 0 || dy === 0 ? null : num / Math.sqrt(dx * dy);
}

// Exact two-sided McNemar (binomial) p-value from the discordant counts: b = packet-only errors, c = pairwise-only.
export function mcnemarP(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  let tail = 0;
  for (let k = 0; k <= Math.min(b, c); k++) tail += choose(n, k) / 2 ** n;
  return Math.min(1, 2 * tail);
}
const choose = (n: number, k: number) => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; };

export type RequestStat = { key: string; corpus: string; packetId: string; pairs: number; passages: number; inputTokens: number; outputTokens: number; stopReason: string };
export type Paired = { key: string; requestKey: string; pairs: number; inputTokens: number; packet: Flags; pairwise: Flags; outcomeDiffers: boolean | null; conflictDiffers: boolean | null; packetOutcome: string | null; pairwiseOutcome: string | null };

const pairKey = (r: { corpus: string; packetId: string; a: string; b: string }) => `${r.corpus}/${r.packetId}/${r.a}|${r.b}`;
const replyKey = (arm: string, corpus: string, request: string, repeat: boolean) => `${arm}|${corpus}|${request}|${repeat}`;

function replyIndex(replies: ReplyRow[]) {
  const m = new Map<string, ReplyRow>();
  for (const r of replies) {
    const k = replyKey(r.arm, r.corpus, r.packetId, r.repeat ?? false); // calibration-run predates the field
    if (m.has(k)) throw new Error(`two replies for ${k}`);
    m.set(k, r);
  }
  return m;
}

// The verdict a pair row was scored from: its pairId inside its own request's reply, only when exactly one.
function verdictFor(row: PairRow, replies: Map<string, ReplyRow>): Verdict | null {
  const reply = replies.get(replyKey(row.arm, row.corpus, row.request, row.repeat));
  const own = verdictsOf(reply?.reply.text ?? null).filter((v) => v.pairId === row.pairId);
  return own.length === 1 ? own[0] : null;
}

export function requestStats(pairs: PairRow[], replies: ReplyRow[]): RequestStat[] {
  const index = replyIndex(replies);
  const groups = new Map<string, PairRow[]>();
  for (const p of pairs) if (p.arm === "packet" && !p.repeat) groups.set(`${p.corpus}/${p.request}`, [...(groups.get(`${p.corpus}/${p.request}`) ?? []), p]);
  return [...groups].map(([key, rows]) => {
    const reply = index.get(replyKey("packet", rows[0].corpus, rows[0].request, false));
    if (!reply) throw new Error(`no reply for packet request ${key}`);
    const u = reply.reply.usage;
    return {
      key, corpus: rows[0].corpus, packetId: rows[0].packetId, pairs: rows.length,
      passages: new Set(rows.flatMap((r) => [r.a, r.b])).size,
      inputTokens: u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0),
      outputTokens: u.outputTokens, stopReason: String(reply.reply.stopReason ?? (reply.reply.error ? "error" : "unknown")),
    };
  });
}

// Joins each non-repeat packet-arm pair with the same pair's pairwise-arm row (same corpus, packet and item keys).
export function pairUp(pairs: PairRow[], replies: ReplyRow[], requests: RequestStat[]): { paired: Paired[]; packetOnly: string[] } {
  const index = replyIndex(replies);
  const req = new Map(requests.map((r) => [r.key, r]));
  const pairwise = new Map(pairs.filter((p) => p.arm === "pairwise" && !p.repeat).map((p) => [pairKey(p), p]));
  const paired: Paired[] = [];
  const packetOnly: string[] = [];
  for (const p of pairs.filter((x) => x.arm === "packet" && !x.repeat)) {
    const q = pairwise.get(pairKey(p));
    if (!q) { packetOnly.push(pairKey(p)); continue; }
    const r = req.get(`${p.corpus}/${p.request}`)!;
    const both = p.status === "answered" && q.status === "answered";
    paired.push({
      key: pairKey(p), requestKey: r.key, pairs: r.pairs, inputTokens: r.inputTokens,
      packet: indicatorsOf(p, verdictFor(p, index)), pairwise: indicatorsOf(q, verdictFor(q, index)),
      outcomeDiffers: both ? p.outcome !== q.outcome : null,
      conflictDiffers: both ? CONFLICTS.includes(p.outcome ?? "") !== CONFLICTS.includes(q.outcome ?? "") : null,
      packetOutcome: p.outcome, pairwiseOutcome: q.outcome,
    });
  }
  return { paired, packetOnly };
}

type IndicatorStat = { packet: number; pairwise: number; packetRate: number | null; pairwiseRate: number | null; difference: number | null; packetOnly: number; pairwiseOnly: number; mcnemarP: number };
const rate = (k: number, n: number) => (n === 0 ? null : Number((k / n).toFixed(3)));

export function binTable(paired: Paired[], binOf: (p: Paired) => string, order: string[]) {
  return order.map((bin) => {
    const rows = paired.filter((p) => binOf(p) === bin);
    const requests = new Set(rows.map((r) => r.requestKey)).size;
    const byIndicator = Object.fromEntries(INDICATORS.map((ind): [Indicator, IndicatorStat] => {
      const pk = rows.filter((r) => r.packet[ind]).length, pw = rows.filter((r) => r.pairwise[ind]).length;
      const b = rows.filter((r) => r.packet[ind] && !r.pairwise[ind]).length, c = rows.filter((r) => !r.packet[ind] && r.pairwise[ind]).length;
      return [ind, { packet: pk, pairwise: pw, packetRate: rate(pk, rows.length), pairwiseRate: rate(pw, rows.length), difference: rows.length ? Number(((pk - pw) / rows.length).toFixed(3)) : null, packetOnly: b, pairwiseOnly: c, mcnemarP: Number(mcnemarP(b, c).toFixed(3)) }];
    })) as Record<Indicator, IndicatorStat>;
    const compared = rows.filter((r) => r.outcomeDiffers !== null);
    return {
      bin, requests, pairs: rows.length, ...byIndicator,
      outcomeDiffers: { n: compared.length, k: compared.filter((r) => r.outcomeDiffers).length, rate: rate(compared.filter((r) => r.outcomeDiffers).length, compared.length) },
      conflictDiffers: { n: compared.length, k: compared.filter((r) => r.conflictDiffers).length, rate: rate(compared.filter((r) => r.conflictDiffers).length, compared.length) },
    };
  });
}

// Per-request rank correlations: packet error rate, pairwise error rate on the same pairs (difficulty), their
// difference, and outcome disagreement, each against pairs per request and input tokens.
export function correlations(paired: Paired[], requests: RequestStat[]) {
  const per = requests.map((r) => {
    const rows = paired.filter((p) => p.requestKey === r.key);
    const n = rows.length || 1;
    const cmp = rows.filter((p) => p.outcomeDiffers !== null);
    return {
      pairs: r.pairs, tokens: r.inputTokens,
      packet: rows.filter((p) => p.packet.anyError).length / n,
      pairwise: rows.filter((p) => p.pairwise.anyError).length / n,
      diff: (rows.filter((p) => p.packet.anyError).length - rows.filter((p) => p.pairwise.anyError).length) / n,
      disagree: cmp.length ? cmp.filter((p) => p.outcomeDiffers).length / cmp.length : 0,
    };
  });
  const rho = (y: (x: (typeof per)[number]) => number, x: (p: (typeof per)[number]) => number) => {
    const v = spearman(per.map(x), per.map(y));
    return v === null ? null : Number(v.toFixed(3));
  };
  const out: Record<string, { vsPairs: number | null; vsInputTokens: number | null }> = {};
  for (const k of ["packet", "pairwise", "diff", "disagree"] as const) out[k] = { vsPairs: rho((p) => p[k], (p) => p.pairs), vsInputTokens: rho((p) => p[k], (p) => p.tokens) };
  return { requests: per.length, anyErrorRate: { packet: out.packet, pairwiseSamePairs: out.pairwise, packetMinusPairwise: out.diff }, outcomeDisagreement: out.disagree, pairsVsTokens: rho((p) => p.tokens, (p) => p.pairs) };
}

// Repeat rows (pilot-run only): the same request sent again. How often does the outcome change, per arm?
export function repeatVariance(pairs: PairRow[]) {
  const main = new Map(pairs.filter((p) => !p.repeat).map((p) => [`${p.arm}/${pairKey(p)}`, p]));
  type Count = { n: number; outcomeChanged: number; conflictChanged: number };
  const out: Record<string, Count> = {};
  const byPacket: Record<string, Count> = {};
  for (const p of pairs.filter((x) => x.repeat)) {
    const m = main.get(`${p.arm}/${pairKey(p)}`);
    if (!m || m.status !== "answered" || p.status !== "answered") continue;
    for (const o of [(out[p.arm] ??= { n: 0, outcomeChanged: 0, conflictChanged: 0 }), (byPacket[`${p.arm} ${p.corpus}/${p.packetId}`] ??= { n: 0, outcomeChanged: 0, conflictChanged: 0 })]) {
      o.n++;
      if (m.outcome !== p.outcome) o.outcomeChanged++;
      if (CONFLICTS.includes(m.outcome ?? "") !== CONFLICTS.includes(p.outcome ?? "")) o.conflictChanged++;
    }
  }
  return { ...out, byPacket };
}

export function analyzeRun(name: string, prompt: string, pairs: PairRow[], replies: ReplyRow[]) {
  const requests = requestStats(pairs, replies);
  const { paired, packetOnly } = pairUp(pairs, replies, requests);
  const sizeOrder = SIZE_BINS.map((b) => binLabel(b[0], SIZE_BINS));
  const tokenOrder = TOKEN_BINS.map((b) => binLabel(b[0], TOKEN_BINS));
  const sum = (f: (p: Paired) => boolean) => paired.filter(f).length;
  // v2 passages also show adjacent exchanges; how many were shown is in the request text, which is not saved.
  const citedAdjacent = prompt === "packet-v2" ? Object.fromEntries(["packet", "pairwise"].map((arm) => [arm, pairs.filter((p) => p.arm === arm && !p.repeat).flatMap((p) => [p.sideA, p.sideB]).filter((s) => s?.cited === "adjacent").length])) : null;
  return {
    run: name, prompt,
    requests: requests.length, pairs: paired.length, packetOnlyPairs: packetOnly,
    totals: Object.fromEntries(INDICATORS.map((i) => [i, { packet: sum((p) => p.packet[i]), pairwise: sum((p) => p.pairwise[i]) }])),
    outcomeDiffers: sum((p) => p.outcomeDiffers === true), conflictDiffers: sum((p) => p.conflictDiffers === true), compared: sum((p) => p.outcomeDiffers !== null),
    adjacentExchangesShown: prompt === "packet-v2" ? "not derivable: the request text is not saved; input tokens include them" : "none (packet-v1 shows no adjacent exchanges)",
    sidesCitingAdjacent: citedAdjacent,
    bySize: binTable(paired, (p) => binLabel(p.pairs, SIZE_BINS), sizeOrder),
    byInputTokens: binTable(paired, (p) => binLabel(p.inputTokens, TOKEN_BINS), tokenOrder),
    correlations: correlations(paired, requests),
    largestRequests: [...requests].sort((x, y) => y.pairs - x.pairs).slice(0, 5),
    stopReasons: requests.reduce<Record<string, number>>((m, r) => ({ ...m, [r.stopReason]: (m[r.stopReason] ?? 0) + 1 }), {}),
    repeatVariance: repeatVariance(pairs),
    perRequest: requests,
  };
}

function main() {
  const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
  const root = resolve(arg("root", "data/raw/packet-pilot"));
  const out = resolve(arg("out", join(root, "size-analysis")));
  const runs = arg("runs", "pilot-run:packet-v1,v2-eval:packet-v2").split(",").map((s) => s.split(":") as [string, string]);
  const results = runs.map(([dir, prompt]) => analyzeRun(dir, prompt,
    JSON.parse(readFileSync(join(root, dir, "pairs.json"), "utf8")) as PairRow[],
    JSON.parse(readFileSync(join(root, dir, "replies.json"), "utf8")) as ReplyRow[]));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "size-analysis.json"), JSON.stringify({ sizeBins: SIZE_BINS.map((b) => binLabel(b[0], SIZE_BINS)), tokenBins: TOKEN_BINS.map((b) => binLabel(b[0], TOKEN_BINS)), runs: results }, null, 2) + "\n");
  for (const r of results) {
    console.log(`\n${r.run} (${r.prompt}): ${r.requests} packet requests, ${r.pairs} paired pairs, outcome differs ${r.outcomeDiffers}/${r.compared}, conflict flag differs ${r.conflictDiffers}/${r.compared}`);
    for (const [title, table] of [["pairs per packet", r.bySize], ["input tokens", r.byInputTokens]] as const) {
      console.log(`  by ${title}: bin | requests | pairs | any error packet/pairwise (diff, McNemar p) | outcome differs`);
      for (const b of table) {
        const e = b.anyError;
        console.log(`    ${b.bin.padEnd(10)} | ${String(b.requests).padStart(3)} | ${String(b.pairs).padStart(3)} | ${e.packet}/${e.pairwise} (${e.difference}, p=${e.mcnemarP}) | ${b.outcomeDiffers.k}/${b.outcomeDiffers.n}`);
      }
    }
    console.log(`  Spearman vs pairs: packet ${r.correlations.anyErrorRate.packet.vsPairs}, pairwise same pairs ${r.correlations.anyErrorRate.pairwiseSamePairs.vsPairs}, difference ${r.correlations.anyErrorRate.packetMinusPairwise.vsPairs}, outcome disagreement ${r.correlations.outcomeDisagreement.vsPairs}`);
    console.log(`  repeat variance: ${JSON.stringify(r.repeatVariance)}`);
  }
  console.log(`\nWrote ${join(out, "size-analysis.json")}`);
}

if (require.main === module) main();
