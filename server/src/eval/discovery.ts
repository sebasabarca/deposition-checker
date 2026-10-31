// End-to-end discovery: known contradictions mixed with distractors, found by the real retrieval code
// with no pair chosen for it (DESIGN.md, "Evaluation method"). The suites' labelled exchanges are
// shuffled in among generated testimony, and nothing about a target reaches retrieval: targets are
// resolved to exchanges only afterwards, to score what came back. Run with the mock models this
// measures the pipeline; with real cards it measures retrieval. Always synthetic, reported separately.
// Model verdicts play no part here: every label is what the case was built to be.

import { and, eq } from "drizzle-orm";
import { buildTopicMap, CARD_EXTRACTOR_VERSION, cardSummary, extractCards, mapMembers, topicReport, type CardSummary, type ClaimModel, type TopicReport } from "../claims";
import type { Database } from "../db/client";
import { exchanges } from "../db/schema";
import { findPathB, findTopicPairs, unionCandidates, type PathBQueryMode, type Pool, type PoolCandidate, type LogicalExchange } from "../retrieve";
import type { SyntheticSuite } from "./synthetic";
import { storeSessions } from "./syntheticStore";

const PEOPLE = ["Priya Natarajan", "Owen Castellano", "Mei Lindqvist", "Tomasz Baran", "Grace Okafor", "Ivan Moreau", "Hana Sato", "Felix Brandt"];
const AREAS = ["budget", "warehouse", "vendor", "payroll", "insurance", "forklift", "sales", "refund", "security", "licensing", "fleet", "compliance"];
const THINGS = ["review", "lease", "checklist", "migration", "renewal", "contract", "forecast", "policy", "audit"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October"];

// Filler testimony, identical in shape to a real exchange. Each subject has one person and one month,
// so nothing here contradicts anything else: a distractor is a fair negative. Even exchanges are asked
// in both sessions (compatible pairs that look like candidates); odd ones belong to one session.
export function distractors(session: number, count: number): string {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const n = i % 2 === 0 ? i : i + session * 1000;
    const id = n * 7 + 3;
    const subject = `${AREAS[id % AREAS.length]} ${THINGS[id % THINGS.length]} phase ${"abcdefghij"[Math.floor(id / 36) % 10]}`;
    const person = PEOPLE[id % PEOPLE.length];
    const month = MONTHS[id % MONTHS.length];
    const q = [`Did you work with ${person} on the ${subject}?`, `Who handled the ${subject} in ${month}?`, `When did you first see the ${subject}?`][n % 3];
    const a = [`Yes, ${person} and I finished the ${subject} together in ${month}.`, `${person} handled the ${subject} that month.`, `I first saw the ${subject} in ${month}, when ${person} sent it over.`][n % 3];
    out.push(`Q: ${q}\nA: ${a}`);
  }
  return out.join("\n\n");
}

// A suite's sessions with distractors spread evenly between its exchanges, keeping their order.
export function withDistractors(suite: SyntheticSuite, perSession: number): SyntheticSuite {
  return {
    ...suite,
    set: `${suite.set}-discovery`,
    caseName: `${suite.caseName}: discovery`,
    sessions: suite.sessions.map((s, i) => {
      const real = s.text.split(/\n\s*\n/).filter((b) => /^Q:/.test(b.trim()));
      const filler = distractors(i, perSession).split("\n\n");
      const step = Math.ceil(filler.length / Math.max(real.length, 1));
      const mixed = real.flatMap((block, n) => [...filler.slice(n * step, (n + 1) * step), block.trim()]);
      return { ...s, text: `${[...mixed, ...filler.slice(real.length * step)].join("\n\n")}\n` };
    }),
  };
}

export type TargetPair = { id: string; a: LogicalExchange; b: LogicalExchange };
const samePair = (c: { a: LogicalExchange; b: LogicalExchange }, t: TargetPair) => c.a.depositionId === t.a.depositionId && c.a.groupId === t.a.groupId && c.b.depositionId === t.b.depositionId && c.b.groupId === t.b.groupId;

export type RecallRow = { k: number; pathA: number; pathB: number; pool: number };
export type DiscoveryMetrics = {
  targets: number;
  recallAtK: RecallRow[]; // hits, out of `targets`, within each path's own top K, and the pool's selection order
  found: { pathA: number; pathB: number; both: number; onlyA: string[]; onlyB: string[]; missed: string[] };
  selection: { selected: number; targetsSelected: number; targetsDeferred: string[]; targetsExcluded: string[] };
};

// Scores a pool against known pairs. Pure.
export function discoveryMetrics(pool: Pool, targets: readonly TargetPair[], ks: readonly number[]): DiscoveryMetrics {
  const found = targets.map((t) => ({ t, c: pool.candidates.find((c) => samePair(c, t)) ?? null }));
  const has = (c: PoolCandidate | null, path: "topics" | "fulltext") => c?.ranks[path] !== undefined;
  const within = (rank: number | undefined, k: number) => rank !== undefined && rank <= k;
  return {
    targets: targets.length,
    recallAtK: ks.map((k) => ({
      k,
      pathA: found.filter(({ c }) => within(c?.ranks.topics, k)).length,
      pathB: found.filter(({ c }) => within(c?.ranks.fulltext, k)).length,
      pool: found.filter(({ c }) => c?.status === "selected" && c.rank <= k).length,
    })),
    found: {
      pathA: found.filter(({ c }) => has(c, "topics")).length,
      pathB: found.filter(({ c }) => has(c, "fulltext")).length,
      both: found.filter(({ c }) => has(c, "topics") && has(c, "fulltext")).length,
      onlyA: found.filter(({ c }) => has(c, "topics") && !has(c, "fulltext")).map(({ t }) => t.id),
      onlyB: found.filter(({ c }) => !has(c, "topics") && has(c, "fulltext")).map(({ t }) => t.id),
      missed: found.filter(({ c }) => c === null).map(({ t }) => t.id),
    },
    selection: {
      selected: pool.counts.selected,
      targetsSelected: found.filter(({ c }) => c?.status === "selected").length,
      targetsDeferred: found.filter(({ c }) => c?.status === "deferred").map(({ t }) => t.id),
      targetsExcluded: found.filter(({ c }) => c?.status === "excluded").map(({ t }) => t.id),
    },
  };
}

export type DiscoveryRun = {
  suite: string;
  synthetic: true;
  sessions: number;
  distractorsPerSession: number;
  mode: PathBQueryMode;
  capacity: number;
  cards: CardSummary[];
  topics: TopicReport | null;
  pool: Pool["counts"];
  metrics: DiscoveryMetrics;
};

export type DiscoveryOptions = { distractorsPerSession?: number; capacity?: number; mode?: PathBQueryMode; ks?: readonly number[]; cards: ClaimModel | null; topics: ClaimModel | null };

// Stores the mixed sessions, runs cards, topics, both paths and the union, then scores the result.
// With `cards: null`, Path A has nothing and Path B must still work alone.
export async function runDiscovery(db: Database, suite: SyntheticSuite, { distractorsPerSession = 60, capacity = 30, mode = "rare_terms", ks = [5, 10, 30, 100], cards, topics }: DiscoveryOptions): Promise<DiscoveryRun> {
  const mixed = withDistractors(suite, distractorsPerSession);
  const { witnessId, depositionIds } = await storeSessions(db, mixed);
  const [first, second] = depositionIds;
  if (cards) for (const d of depositionIds) await extractCards(db, d, cards);
  const map = topics ? await buildTopicMap(db, witnessId, topics) : null;
  const pathA = await findTopicPairs(db, { witnessId, depositionIds, extractorVersion: CARD_EXTRACTOR_VERSION });
  const pathB = await findPathB(db, { witnessId, depositionId: second, mode });
  const pool = unionCandidates({ topics: pathA.pairs, fulltext: pathB.pairs }, { capacity });

  const groupOf = async (depositionId: number, phrase: string) => {
    const rows = await db.select({ groupId: exchanges.groupId, q: exchanges.questionText }).from(exchanges).where(and(eq(exchanges.depositionId, depositionId)));
    const hit = rows.find((r) => r.q.replace(/\s+/g, " ").includes(phrase));
    if (!hit) throw new Error(`No exchange asks "${phrase}".`);
    return { depositionId, groupId: hit.groupId };
  };
  const targets: TargetPair[] = [];
  for (const c of suite.cases.filter((x) => x.label === "direct" || x.label === "inferential")) targets.push({ id: c.id, a: await groupOf(first, c.questionA), b: await groupOf(second, c.questionB) });

  return {
    suite: suite.set,
    synthetic: true,
    sessions: depositionIds.length,
    distractorsPerSession,
    mode,
    capacity,
    cards: await Promise.all(depositionIds.map((d) => cardSummary(db, d))),
    topics: map?.mapVersion ? topicReport(await mapMembers(db, witnessId, map.mapVersion)) : null,
    pool: pool.counts,
    metrics: discoveryMetrics(pool, targets, ks),
  };
}
