// Path A: candidate pairs from statement cards (DESIGN.md, "Step 3"). Two cards from different
// sessions are linked when they share a topic, or, whatever the map says, when they share a grounded
// entity and a predicate other than `other`: a topic label is never the only way in, and a card left unassigned can
// still be found. Links between the same two logical exchanges are one candidate that records every
// topic it was found through.
//
// Signals are reasons to adjudicate, never established contradictions. They rank pairs within Path A:
//   opposite_stance      one side asserts, the other denies
//   different_value      the same stance, with a different time, location or amount, or objects
//   recollection_change  stated on one side, "don't recall" or "don't know" on the other
//   shared_entities      nothing but a shared name
//   same_topic           nothing but a shared topic
// A contradiction needs the same event and the same slot, so a signal counts fully only between
// comparable cards (overlapping objects, or event lines sharing most of their words); otherwise it
// ranks below every comparable pair.

import { sql } from "drizzle-orm";
import { latestMapVersion } from "../claims/topics";
import { contentWords } from "../claims/verify";
import type { Database } from "../db/client";
import type { LogicalExchange } from "./rank";

export const CARD_SIGNALS = ["opposite_stance", "different_value", "recollection_change", "shared_entities", "same_topic"] as const;
export type CardSignal = (typeof CARD_SIGNALS)[number];
export const PATH_A_RANKING_VERSION = "topic-rank-v2";
export const EVENT_OVERLAP = 0.5;

export type PairableCard = {
  id: number;
  exchangeId: number;
  depositionId: number;
  groupId: number;
  stance: string;
  epistemic: string;
  predicate: string;
  object: string | null;
  time: string | null;
  location: string | null;
  amount: string | null;
  entities: readonly string[];
  event: string;
  topicIds: readonly number[]; // real topics only, never Unassigned
};

export type TopicPair = {
  rank: number; // 1 = strongest; excluded pairs rank after every eligible one
  signal: CardSignal;
  comparable: boolean;
  a: LogicalExchange; // sorts first by (deposition, group)
  b: LogicalExchange;
  exchangeA: number; // the parts the representative cards came from
  exchangeB: number;
  cardA: number;
  cardB: number;
  topicIds: number[];
  sharedEntities: string[];
  eventOverlap: number; // share of the shorter event line's words the two cards have in common
  cardPairs: number; // how many card pairs link these two logical exchanges
  exclusion: string | null; // why the cards suggest this pair is weak; it ranks last, and is never ruled out
};

// Objects overlap when they share at least one meaningful word and the shared words are at least this
// share of the smaller object's words: "software package" and "software" overlap; "the 10% discount"
// and "the board" don't. A retrieval link only, never a finding that the two are the same thing.
export const OBJECT_OVERLAP = 0.5;

const sharedWords = (a: string, b: string) => {
  const y = new Set(contentWords(b));
  return [...new Set(contentWords(a))].filter((w) => y.has(w));
};

export function objectsOverlap(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const smaller = Math.min(new Set(contentWords(a)).size, new Set(contentWords(b)).size);
  const shared = sharedWords(a, b).length;
  return shared > 0 && shared / smaller >= OBJECT_OVERLAP;
}

// Two stated objects with meaningful words and none in common.
const objectsDisjoint = (a: string | null, b: string | null) => !!a && !!b && contentWords(a).length > 0 && contentWords(b).length > 0 && sharedWords(a, b).length === 0;
const differs = (a: string | null, b: string | null) => a !== null && b !== null && a.trim().toLowerCase() !== b.trim().toLowerCase();

const eventOverlap = (a: string, b: string) => {
  const x = new Set(contentWords(a));
  const y = new Set(contentWords(b));
  const smaller = Math.min(x.size, y.size);
  return smaller === 0 ? 0 : [...x].filter((w) => y.has(w)).length / smaller;
};

const assertive = (c: PairableCard) => (c.stance === "asserts" || c.stance === "denies") && (c.epistemic === "asserted" || c.epistemic === "qualified");
const noRecall = (c: PairableCard) => c.epistemic === "does_not_recall" || c.epistemic === "does_not_know";

// Why two cards can't be a contradiction of the witness's own statements, or null.
export function pairExclusion(c1: PairableCard, c2: PairableCard): string | null {
  const notTheWitness = (c: PairableCard) => c.epistemic === "hypothetical" || c.epistemic === "reported_by_other";
  if (notTheWitness(c1) || notTheWitness(c2)) return "not_the_witness_assertion";
  if (!assertive(c1) && !assertive(c2)) return "no_assertion_on_either_side";
  const unanswered = (c: PairableCard) => c.stance === "not_answered" && !noRecall(c);
  if (unanswered(c1) || unanswered(c2)) return "side_not_answered";
  return null;
}

export function cardSignal(c1: PairableCard, c2: PairableCard): { signal: CardSignal; comparable: boolean; sharedEntities: string[]; eventOverlap: number } {
  const sharedEntities = c1.entities.filter((e) => c2.entities.includes(e)).sort();
  const overlap = eventOverlap(c1.event, c2.event);
  const comparable = objectsOverlap(c1.object, c2.object) || overlap >= EVENT_OVERLAP;
  let signal: CardSignal = sharedEntities.length > 0 ? "shared_entities" : "same_topic";
  if (assertive(c1) && assertive(c2)) {
    if (c1.stance !== c2.stance) signal = "opposite_stance";
    else if (differs(c1.time, c2.time) || differs(c1.location, c2.location) || differs(c1.amount, c2.amount) || (sharedEntities.length > 0 && objectsDisjoint(c1.object, c2.object))) signal = "different_value";
  } else if ((assertive(c1) && noRecall(c2)) || (assertive(c2) && noRecall(c1))) {
    signal = "recollection_change";
  }
  return { signal, comparable, sharedEntities, eventOverlap: overlap };
}

// opposite, different, recollection when comparable; then shared entities; then the three again when
// not comparable; then a shared topic alone.
export const tierOf = (signal: CardSignal, comparable: boolean) => (signal === "same_topic" ? 7 : signal === "shared_entities" ? 3 : CARD_SIGNALS.indexOf(signal) + (comparable ? 0 : 4));

const compareSide = (x: LogicalExchange, y: LogicalExchange) => x.depositionId - y.depositionId || x.groupId - y.groupId;
const side = (c: PairableCard): LogicalExchange => ({ depositionId: c.depositionId, groupId: c.groupId });

// Every linked pair of logical exchanges, ranked. Pure.
export function pairCards(cards: readonly PairableCard[]): TopicPair[] {
  const links = new Map<string, { c1: PairableCard; c2: PairableCard; topics: Set<number> }>();
  const groupsBy = new Map<string, PairableCard[]>();
  const add = (key: string, c: PairableCard) => groupsBy.set(key, [...(groupsBy.get(key) ?? []), c]);
  for (const c of cards) {
    for (const t of c.topicIds) add(`t${t}`, c);
    // "other" says nothing about the fact, so sharing it and a name isn't a link.
    if (c.predicate !== "other") for (const e of c.entities) add(`e${c.predicate}\0${e}`, c);
  }
  for (const [key, members] of groupsBy) {
    const topic = key.startsWith("t") ? Number(key.slice(1)) : null;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        if (members[i].depositionId === members[j].depositionId) continue;
        const [c1, c2] = compareSide(side(members[i]), side(members[j])) < 0 ? [members[i], members[j]] : [members[j], members[i]];
        const k = `${c1.id}|${c2.id}`;
        const link = links.get(k) ?? { c1, c2, topics: new Set<number>() };
        if (topic !== null) link.topics.add(topic);
        links.set(k, link);
      }
    }
  }

  const pairs = new Map<string, Omit<TopicPair, "rank">>();
  const order = (p: Omit<TopicPair, "rank">, q: Omit<TopicPair, "rank">) =>
    Number(p.exclusion !== null) - Number(q.exclusion !== null) || tierOf(p.signal, p.comparable) - tierOf(q.signal, q.comparable) || q.eventOverlap - p.eventOverlap || q.sharedEntities.length - p.sharedEntities.length || q.topicIds.length - p.topicIds.length;
  for (const { c1, c2, topics } of links.values()) {
    const a = side(c1);
    const b = side(c2);
    const key = `${a.depositionId}:${a.groupId}|${b.depositionId}:${b.groupId}`;
    const candidate = { ...cardSignal(c1, c2), a, b, exchangeA: c1.exchangeId, exchangeB: c2.exchangeId, cardA: c1.id, cardB: c2.id, topicIds: [...topics].sort((x, y) => x - y), cardPairs: 1, exclusion: pairExclusion(c1, c2) };
    const seen = pairs.get(key);
    if (!seen) {
      pairs.set(key, candidate);
      continue;
    }
    const better = order(candidate, seen) || candidate.cardA - seen.cardA || candidate.cardB - seen.cardB;
    const topicIds = [...new Set([...seen.topicIds, ...candidate.topicIds])].sort((x, y) => x - y);
    pairs.set(key, { ...(better < 0 ? candidate : seen), topicIds, cardPairs: seen.cardPairs + 1 });
  }
  return [...pairs.values()].sort((p, q) => order(p, q) || compareSide(p.a, q.a) || compareSide(p.b, q.b)).map((p, i) => ({ rank: i + 1, ...p }));
}

type Row = { id: string; exchange_id: string; deposition_id: string; group_id: number; stance: string; epistemic: string; predicate: string; object: string | null; time: string | null; location: string | null; amount: string | null; entities: string[]; event: string; topic_ids: string[] };

// Path A for a set of sessions of one witness. Works with no topic map (entity links only), and
// finds nothing, without failing, when there are no cards.
export async function findTopicPairs(db: Database, { witnessId, depositionIds, extractorVersion }: { witnessId: number; depositionIds: readonly number[]; extractorVersion: string }): Promise<{ mapVersion: number | null; cards: number; pairs: TopicPair[] }> {
  const mapVersion = await latestMapVersion(db, witnessId);
  const rows = await db.execute<Row>(sql`
    select sc.id, sc.exchange_id, sc.deposition_id, e.group_id, sc.stance::text as stance, sc.epistemic::text as epistemic, sc.predicate, sc.object, sc.time, sc.location, sc.amount, sc.entities, sc.event,
      array(select ct.topic_id from card_topics ct join topics t on t.id = ct.topic_id where ct.card_id = sc.id and ct.map_version = ${mapVersion ?? 0} and not t.is_unassigned) as topic_ids
    from statement_cards sc
    join exchanges e on e.id = sc.exchange_id
    join depositions d on d.id = sc.deposition_id
    where sc.witness_id = ${witnessId} and sc.extractor_version = ${extractorVersion} and sc.status = 'usable' and d.status = 'ready'
      and sc.deposition_id in (${sql.join(depositionIds.map((d) => sql`${d}`), sql`, `)})
  `);
  const cards = rows.rows.map((r): PairableCard => ({ id: Number(r.id), exchangeId: Number(r.exchange_id), depositionId: Number(r.deposition_id), groupId: r.group_id, stance: r.stance, epistemic: r.epistemic, predicate: r.predicate, object: r.object, time: r.time, location: r.location, amount: r.amount, entities: r.entities, event: r.event, topicIds: r.topic_ids.map(Number) }));
  return { mapVersion, cards: cards.length, pairs: pairCards(cards) };
}
