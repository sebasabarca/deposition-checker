// Candidate triage: cuts a frozen CandidatePool (frozen.ts) down to the pairs worth adjudicating with cheap,
// label-agnostic signals, one measured stage at a time. Pure: no I/O, clock or randomness. Every input
// candidate ends in `kept` or in `deferred` with the stage and a reason, so nothing disappears silently and
// a deferred pair can be audited or re-admitted later. It never reads benchmark labels.
//
// Stages, in order (each sees only what the previous kept):
//   not-testimony   a side has no attorney question or no witness answer (headers, appearances, colloquy)
//   near-duplicate  both sides say almost the same words (repeated boilerplate, read-backs)
//   content-poor    a side has too few content words to state a checkable fact on its own
//   no-rare-word    the pair shares no rare content word (no common name, place or event to compare)
//   coverage        neither side ranks the other's passage among its best `perItem` partner passages
//   budget          beyond `maxPairs`, ordered by distinctiveness (a ratio test), then fused score

import type { Candidate, CandidatePool, FrozenItem } from "./frozen";

export type TriageOptions = {
  nearDuplicate: number; // content-word Jaccard at or above which a pair is a near-duplicate
  minContentWords: number; // content words a side needs in its question and answer
  rareShare: number | null; // a word is rare when at most this share of items use it; null skips the no-rare-word stage
  passageGap: number; // partner items of one document within this many groups form one passage
  perItem: number; // partner passages each item keeps, by its own retrieval ranking
  maxPairs: number | null; // the final budget, or null for none
};

// Defaults measured on two corpora (lead integration, retrieval-triage-sweep.ts): the rare-word gate and the
// ratio-test budget each lost known targets on the independent corpus, because "rare" as a share of items and
// the ratio ordering behave differently at another corpus size; two partner passages per item and no budget
// kept every target the input pools held. The earlier settings (rareShare 0.01, perItem 1, a maxPairs budget)
// stay available as options for comparison.
export const DEFAULT_TRIAGE: TriageOptions = { nearDuplicate: 0.8, minContentWords: 2, rareShare: null, passageGap: 5, perItem: 2, maxPairs: null };

export type Deferral = { candidate: Candidate; stage: string; reason: string };
export type TriageStage = { name: string; in: number; out: number };
export type TriageResult = { kept: Candidate[]; deferred: Deferral[]; stages: TriageStage[] };

const RRF_K = 60; // as frozen.ts fuses: score = sum of 1 / (k + rank)

// Function words and courtroom fillers: they say nothing about which event a passage is about.
const STOPWORDS = new Set(
  ("the and that was you your did not but for with have had what this they there then were him his her she said say says when where " +
    "who how why are about from just all any can could would should will been being into out our ours their them its it's i'm don't " +
    "didn't recall remember know think yes okay well right sir mr ms mrs one two time something anything thing things going went get " +
    "got like let tell asked told question answer mean also because which some other more very only really").split(" "),
);

export const contentWords = (text: string) => new Set((text.toLowerCase().match(/[a-z][a-z']+/g) ?? []).filter((w) => w.length >= 3 && !STOPWORDS.has(w)));

// Candidates are stored a<b; direction 0 is a's view of b, direction 1 is b's view of a.
export const directionalScore = (c: Candidate, d: 0 | 1) => Object.values(c.ranks).reduce((s, r) => s + (r[d] == null ? 0 : 1 / (RRF_K + r[d]!)), 0);

// For every item, the 1-based rank of each partner's passage in that item's own retrieval ranking: partners
// in one document whose groups lie within `gap` of each other are one passage, ranked by its best member,
// so several neighbouring answers to the same line of questioning take one slot rather than crowding out
// every other passage. Returns, per candidate, [rank from a, rank from b], and per item its passages' best
// scores, best first.
export function passageRanks(candidates: readonly Candidate[], items: ReadonlyMap<string, FrozenItem>, gap: number) {
  const scores = new Map<string, number[]>();
  const partners = new Map<string, { c: Candidate; other: FrozenItem; s: number }[]>();
  for (const c of candidates) for (const [self, other, d] of [[c.a, c.b, 0], [c.b, c.a, 1]] as const) {
    const list = partners.get(self) ?? partners.set(self, []).get(self)!;
    list.push({ c, other: items.get(other)!, s: directionalScore(c, d) });
  }
  const out = new Map<Candidate, [number, number]>(candidates.map((c) => [c, [0, 0]]));
  for (const [self, list] of partners) {
    list.sort((x, y) => (x.other.document < y.other.document ? -1 : x.other.document > y.other.document ? 1 : x.other.groupId - y.other.groupId));
    const passages: { best: number; members: Candidate[] }[] = [];
    list.forEach((p, i) => {
      const prev = list[i - 1];
      if (prev && prev.other.document === p.other.document && p.other.groupId - prev.other.groupId <= gap) {
        const last = passages[passages.length - 1];
        last.members.push(p.c);
        last.best = Math.max(last.best, p.s);
      } else passages.push({ best: p.s, members: [p.c] });
    });
    passages.sort((x, y) => y.best - x.best);
    passages.forEach((p, i) => { for (const c of p.members) out.get(c)![c.a === self ? 0 : 1] = i + 1; });
    scores.set(self, passages.map((p) => p.best));
  }
  return { ranks: out, scores };
}

// A ratio test, as in feature matching (Lowe 2004): a choice is distinctive when the chooser's passage scores
// clearly above the next passage it could have chosen (Infinity when there was none). A pair takes the best
// ratio over the sides that kept it (rank ≤ perItem).
export function distinctiveness(ranks: readonly [number, number], sideScores: readonly [number[], number[]], perItem: number): number {
  let best = 0;
  ranks.forEach((r, side) => {
    if (r > perItem) return;
    const s = sideScores[side];
    best = Math.max(best, r < s.length ? s[r - 1] / s[r] : Infinity);
  });
  return best;
}

export function triage(pool: CandidatePool, items: readonly FrozenItem[], options: Partial<TriageOptions> = {}): TriageResult {
  const o = { ...DEFAULT_TRIAGE, ...options };
  const byKey = new Map(items.map((i) => [i.key, i]));
  for (const c of pool.candidates) for (const k of [c.a, c.b]) if (!byKey.has(k)) throw new Error(`candidate item ${k} is not in the items`);
  const words = new Map(items.map((i) => [i.key, contentWords(`${i.question} ${i.answer}`)]));
  const df = new Map<string, number>();
  for (const ws of words.values()) for (const w of ws) df.set(w, (df.get(w) ?? 0) + 1);
  const maxDf = o.rareShare === null ? Infinity : Math.max(1, Math.floor(items.length * o.rareShare));
  const shared = (c: Candidate) => [...words.get(c.a)!].filter((w) => words.get(c.b)!.has(w));

  const deferred: Deferral[] = [];
  const stages: TriageStage[] = [];
  let current = [...pool.candidates];
  const stage = (name: string, why: (c: Candidate) => string | null) => {
    const next: Candidate[] = [];
    for (const c of current) {
      const reason = why(c);
      if (reason === null) next.push(c);
      else deferred.push({ candidate: c, stage: name, reason });
    }
    stages.push({ name, in: current.length, out: next.length });
    current = next;
  };

  stage("not-testimony", (c) => {
    const bad = [c.a, c.b].filter((k) => !byKey.get(k)!.question.trim() || !byKey.get(k)!.answer.trim());
    return bad.length ? `no question or no answer: ${bad.join(", ")}` : null;
  });
  stage("near-duplicate", (c) => {
    const n = shared(c).length;
    const union = words.get(c.a)!.size + words.get(c.b)!.size - n;
    const jaccard = union ? n / union : 1;
    return jaccard >= o.nearDuplicate ? `content-word Jaccard ${jaccard.toFixed(2)} ≥ ${o.nearDuplicate}` : null;
  });
  stage("content-poor", (c) => {
    const poor = [c.a, c.b].filter((k) => words.get(k)!.size < o.minContentWords);
    return poor.length ? `fewer than ${o.minContentWords} content words: ${poor.join(", ")}` : null;
  });
  if (o.rareShare !== null) stage("no-rare-word", (c) => {
    const s = shared(c);
    if (s.some((w) => df.get(w)! <= maxDf)) return null;
    return s.length ? `shared words all common (df > ${maxDf}): ${s.slice(0, 5).join(", ")}` : "no shared content word";
  });

  const { ranks, scores } = passageRanks(current, byKey, o.passageGap);
  stage("coverage", (c) => {
    const [ra, rb] = ranks.get(c)!;
    return Math.min(ra, rb) <= o.perItem ? null : `passage rank ${ra} from a, ${rb} from b; each item keeps ${o.perItem}`;
  });

  if (o.maxPairs !== null) {
    const ratio = new Map(current.map((c) => [c, distinctiveness(ranks.get(c)!, [scores.get(c.a)!, scores.get(c.b)!], o.perItem)]));
    const sorted = [...current].sort((x, y) => ratio.get(y)! - ratio.get(x)! || y.fused - x.fused || (x.a + x.b < y.a + y.b ? -1 : 1));
    const position = new Map(sorted.map((c, i) => [c, i + 1]));
    const budget = o.maxPairs;
    stage("budget", (c) => (position.get(c)! <= budget ? null : `distinctiveness ${ratio.get(c)!.toFixed(3)}: position ${position.get(c)} of ${sorted.length} beyond budget ${budget}`));
    current = sorted.slice(0, budget);
  }

  return { kept: current, deferred, stages };
}
