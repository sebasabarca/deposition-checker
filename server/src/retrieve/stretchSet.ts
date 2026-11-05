// Whole-stretch requests (stretch-v2, experimental and off by default): instead of one issue packet per cluster
// of pairs, the model reads the complete stretch of testimony around nearby pairs on each side and reports every
// conflict between the two stretches. Ported from the candidate-reduction experiment (experiments/
// candidate-reduction/stretch/build.ts and src/features.ts pairUnits, branch experiment/candidate-reduction
// 31590cd), unchanged in its rules. Pure: no I/O, model, clock or randomness.
//
// 1. Units. Pairs of the same two documents whose sides lie within GAP answer groups of a seed pair compare the
//    same two stretches. A unit's stretch on each side is EVERY eligible item of that document between the lowest
//    and highest answer group its pairs touch, so the questions and answers in between are shown too.
// 2. Requests. Units of the same two documents are bundled in transcript order while the request stays within
//    MAX_ITEM_TOKENS and MAX_UNITS. A unit larger than the cap goes alone and is marked oversize.
// Every original pair stays attached to its unit: coverage is checked, and nothing is dropped silently.
//
// The result is a PacketSet (grouping.ts), so the case run's ledger, item index, estimate, Fast and Economy
// execution, recovery and coverage reporting carry stretch requests exactly as they carry issue packets: a
// request's items are every item of its stretches, its pairs the original pairs.

import { INSTRUCTION_TOKENS, itemTokens, type PacketSet } from "./grouping";
import type { SplitPacket } from "./packetSplit";
import type { FrozenItem } from "./frozen";

export const STRETCH_SET_VERSION = "stretch-set-v1";
export const STRETCH_SETTINGS = { gap: 2, maxItemTokens: 6000, maxUnits: 6 } as const; // the experiment's (pilot.ts:42)

type Located = { key: string; document: string; groupId: number };
export type StretchUnit = { id: string; docX: string; docY: string; xKeys: string[]; yKeys: string[]; pairs: [string, string][] };

const pk = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// Each pair's unit: pairs sorted by document pair, then answer group, join the first seed within `gap` on both sides.
export function pairUnits(pairs: readonly { a: string; b: string }[], at: ReadonlyMap<string, Located>, gap: number): Map<string, string> {
  const oriented = pairs.map((p) => { const [x, y] = [at.get(p.a)!, at.get(p.b)!]; return x.document < y.document || (x.document === y.document && x.groupId <= y.groupId) ? { p, x, y } : { p, x: y, y: x }; });
  oriented.sort((m, n) => (m.x.document + m.y.document < n.x.document + n.y.document ? -1 : m.x.document + m.y.document > n.x.document + n.y.document ? 1 : m.x.groupId - n.x.groupId || m.y.groupId - n.y.groupId));
  const seeds = new Map<string, { id: string; gx: number; gy: number }[]>();
  const out = new Map<string, string>();
  for (const { p, x, y } of oriented) {
    const docs = `${x.document}~${y.document}`;
    const list = seeds.get(docs) ?? seeds.set(docs, []).get(docs)!;
    let unit = list.find((s) => Math.abs(s.gx - x.groupId) <= gap && Math.abs(s.gy - y.groupId) <= gap);
    if (!unit) { unit = { id: `${docs}@${x.groupId}:${y.groupId}`, gx: x.groupId, gy: y.groupId }; list.push(unit); }
    out.set(pk(p.a, p.b), unit.id);
  }
  return out;
}

// Units over `items` (every eligible item that may appear in a stretch). Each pair is oriented docX -> docY.
export function buildUnits(pairs: readonly { a: string; b: string }[], items: ReadonlyMap<string, Located>, gap: number = STRETCH_SETTINGS.gap): StretchUnit[] {
  const byDoc = new Map<string, Located[]>();
  for (const i of items.values()) (byDoc.get(i.document) ?? byDoc.set(i.document, []).get(i.document)!).push(i);
  for (const list of byDoc.values()) list.sort((x, y) => x.groupId - y.groupId);
  const unitOf = pairUnits(pairs, items, gap);
  const members = new Map<string, [string, string][]>();
  for (const p of pairs) {
    const id = unitOf.get(pk(p.a, p.b))!;
    const [docX] = id.split("@")[0].split("~");
    const oriented: [string, string] = items.get(p.a)!.document === docX ? [p.a, p.b] : [p.b, p.a];
    (members.get(id) ?? members.set(id, []).get(id)!).push(oriented);
  }
  const span = (keys: string[]) => { const g = keys.map((k) => items.get(k)!.groupId); return [Math.min(...g), Math.max(...g)]; };
  const stretch = (doc: string, [lo, hi]: number[]) => byDoc.get(doc)!.filter((i) => i.groupId >= lo && i.groupId <= hi).map((i) => i.key);
  return [...members]
    .map(([id, ps]) => { const [docX, docY] = id.split("@")[0].split("~"); return { id, docX, docY, xKeys: stretch(docX, span(ps.map((p) => p[0]))), yKeys: stretch(docY, span(ps.map((p) => p[1]))), pairs: ps }; })
    .sort((u, v) => (u.docX + u.docY < v.docX + v.docY ? -1 : u.docX + u.docY > v.docX + v.docY ? 1 : items.get(u.xKeys[0])!.groupId - items.get(v.xKeys[0])!.groupId));
}

// The case's stretch requests as a PacketSet. `kept`: the triage-kept pool pairs (every one is placed).
export function buildStretchSet(kept: readonly { a: string; b: string }[], items: readonly FrozenItem[], settings = STRETCH_SETTINGS): PacketSet & { packets: SplitPacket[] } {
  const at = new Map(items.map((i) => [i.key, i]));
  const tokensOf = new Map(items.map((i) => [i.key, itemTokens(i)]));
  const units = buildUnits(kept, at, settings.gap);
  const keysOf = (us: readonly StretchUnit[]) => [...new Set(us.flatMap((u) => [...u.xKeys, ...u.yKeys]))];
  const tokens = (us: readonly StretchUnit[]) => keysOf(us).reduce((n, k) => n + tokensOf.get(k)!, 0);
  const packets: SplitPacket[] = [];
  const oversize: string[] = [];
  let cur: StretchUnit[] = [];
  const flush = () => {
    if (!cur.length) return;
    const id = `S${packets.length + 1}`;
    const t = tokens(cur);
    if (t > settings.maxItemTokens) oversize.push(id);
    packets.push({ id, issue: `stretches ${cur[0].docX} ~ ${cur[0].docY}`, items: keysOf(cur), pairs: cur.flatMap((u) => u.pairs), inputTokens: INSTRUCTION_TOKENS + t, splitFrom: null, oversize: t > settings.maxItemTokens });
    cur = [];
  };
  for (const u of units) {
    const sameDocs = cur.length && cur[0].docX === u.docX && cur[0].docY === u.docY;
    if (cur.length && (!sameDocs || cur.length >= settings.maxUnits || tokens([...cur, u]) > settings.maxItemTokens)) flush();
    cur.push(u);
  }
  flush();
  // Coverage: every kept pair must sit in one request, with both of its items in that request's stretches.
  const held = new Set(packets.flatMap((p) => { const ks = new Set(p.items); return p.pairs.filter(([a, b]) => ks.has(a) && ks.has(b)).map(([a, b]) => pk(a, b)); }));
  const uncovered = kept.filter((p) => !held.has(pk(p.a, p.b))).map((p) => ({ a: p.a, b: p.b, reason: "not placed in a stretch request (a bug: every kept pair should be)" }));
  return {
    name: `${STRETCH_SET_VERSION}(gap ${settings.gap}, ${settings.maxItemTokens} item tokens, ${settings.maxUnits} units)`, source: "triage-kept pool pairs",
    settings: { ...settings, version: STRETCH_SET_VERSION, units: units.length, oversize }, packets, uncovered,
    tokenAssumption: "item tokens as in grouping.ts, plus the packet instruction allowance per request",
  };
}
