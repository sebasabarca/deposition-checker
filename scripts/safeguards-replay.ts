// Offline replay: the frozen real-model replies of the accuracy evaluation (data/raw/accuracy-eval, read only)
// re-read through production assessment (adjudicate/packetAssess.ts assessPacketPair), which now applies
// verify/safeguards.ts. No model call; nothing under data/raw/accuracy-eval is written.
//
//   npx tsx scripts/safeguards-replay.ts [--json data/raw/<file>]
//
// Before: a conflict outcome (direct, inferential) is a published contradiction, needs_more_context the review lane.
// After: what assessPacketPair publishes (type direct/inferential, or insufficient_evidence with priority needs_context).

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { assessPacketPair } from "../server/src/adjudicate/packetAssess";
import type { IssuePacket } from "../server/src/adjudicate/packetPrompt";
import { parseVerdictsLenient, VERDICT_SCHEMAS } from "../server/src/adjudicate/packetSchema";
import { readStretchReply } from "../server/src/adjudicate/stretch";
import { pairKey } from "../server/src/retrieve/frozen";
import { verifyPacketReply } from "../server/src/verify/packet";

const OUT = "data/raw/accuracy-eval";
const jl = (f: string) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
type Frozen = { id: string; contract: string; set: string; packet: IssuePacket };
type Label = { label: string; truth: string; verified: boolean; pairs: { pair: string }[] };
type Row = { run: string; request: string; set: string; key: string; labels: string[]; outcome: string; before: "contradiction" | "needs_context"; after: "contradiction" | "needs_context"; rules: string[]; citation: string };

const reqs = jl(path.join(OUT, "frozen/requests.jsonl")) as Frozen[];
const labels = (JSON.parse(readFileSync(path.join(OUT, "frozen/trace.json"), "utf8")) as Label[]).filter((t) => t.label);
const labelsOf = (key: string) => labels.filter((l) => l.pairs.some((p) => p.pair === key)).map((l) => l.label);
const RUNS = ["labelled-packet-v1-r1", "labelled-packet-v1-r2", "labelled-stretch-v2-r1", "labelled-stretch-v2-r2"];

const rows: Row[] = [];
for (const run of RUNS) {
  const stretch = run.includes("stretch");
  for (const rep of jl(path.join(OUT, "runs", run, "replies.jsonl")) as { id: string; pairs: { pairId: string }[]; text: string | null }[]) {
    const r = reqs.find((x) => x.id === rep.id)!;
    const ids = new Set(rep.pairs.map((p) => p.pairId));
    const packet = { ...r.packet, pairs: r.packet.pairs.filter((p) => ids.has(p.pairId)) };
    const ver = stretch ? readStretchReply(packet, rep.text).verification : verifyPacketReply(packet, parseVerdictsLenient(rep.text, VERDICT_SCHEMAS["packet-v1"]));
    for (const pv of ver.pairs) {
      const outcome = pv.status === "answered" && pv.verdict ? (pv.verdict as { outcome: string }).outcome : null;
      if (!outcome || !["direct", "inferential", "needs_more_context"].includes(outcome)) continue;
      const f = assessPacketPair(packet, pv);
      if (!f) continue;
      const pr = packet.pairs.find((p) => p.pairId === pv.pairId)!;
      const k = (id: string) => packet.passages.find((x) => x.id === id)!.key;
      const key = pairKey(k(pr.a), k(pr.b));
      rows.push({
        run, request: r.id, set: r.set, key, labels: labelsOf(key), outcome,
        before: outcome === "needs_more_context" ? "needs_context" : "contradiction",
        after: f.type === "direct" || f.type === "inferential" ? "contradiction" : "needs_context",
        rules: ((f.checks.safeguards as { rule: string; side: string | null }[]) ?? []).map((s) => `${s.rule}${s.side ? `:${s.side}` : ""}`),
        citation: f.evidenceStatus,
      });
    }
  }
}

const verified = labels.filter((l) => l.verified);
const summary = Object.fromEntries(RUNS.map((run) => {
  const mine = rows.filter((x) => x.run === run);
  const byLabel = (truth: string, lane: "before" | "after") => verified.filter((l) => l.truth === truth && mine.some((x) => x.labels.includes(l.label) && x[lane] === "contradiction")).map((l) => l.label);
  const surfaced = (truth: string) => verified.filter((l) => l.truth === truth && mine.some((x) => x.labels.includes(l.label))).map((l) => l.label);
  const ruleCounts = (xs: Row[]) => Object.fromEntries([...new Set(xs.flatMap((x) => x.rules.map((r) => r.split(":")[0])))].map((r) => [r, xs.filter((x) => x.rules.some((y) => y.startsWith(r))).length]));
  const onPos = mine.filter((x) => x.labels.some((l) => verified.find((v) => v.label === l)?.truth === "review_worthy"));
  const onCtl = mine.filter((x) => x.labels.some((l) => verified.find((v) => v.label === l)?.truth === "no_conflict"));
  return [run, {
    flags: mine.length,
    publishedContradictions: { before: mine.filter((x) => x.before === "contradiction").length, after: mine.filter((x) => x.after === "contradiction").length },
    positives: { surfacedAnyLane: surfaced("review_worthy"), asContradictionBefore: byLabel("review_worthy", "before"), asContradictionAfter: byLabel("review_worthy", "after") },
    controls: { surfacedAnyLane: surfaced("no_conflict"), asContradictionBefore: byLabel("no_conflict", "before"), asContradictionAfter: byLabel("no_conflict", "after") },
    controlFlagsAsContradiction: { before: onCtl.filter((x) => x.before === "contradiction").length, after: onCtl.filter((x) => x.after === "contradiction").length, of: onCtl.length },
    positiveFlagsAsContradiction: { before: onPos.filter((x) => x.before === "contradiction").length, after: onPos.filter((x) => x.after === "contradiction").length, of: onPos.length },
    rulesFired: { onPositives: ruleCounts(onPos), onControls: ruleCounts(onCtl), unlabelled: ruleCounts(mine.filter((x) => !x.labels.length)) },
  }];
}));
const { values } = parseArgs({ options: { json: { type: "string" } } });
if (values.json) {
  const file = path.resolve(values.json);
  if (!file.startsWith(path.resolve("data/raw") + path.sep) || file.startsWith(path.resolve(OUT) + path.sep)) throw new Error("--json: under data/raw/, outside the frozen accuracy-eval directory");
  writeFileSync(file, JSON.stringify({ summary, rows }, null, 1));
}
console.log(JSON.stringify(summary, null, 1));
