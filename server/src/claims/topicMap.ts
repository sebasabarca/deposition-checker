// The topic map's prompt and code's reading of its response (DESIGN.md, "Step 2"). Pure: no I/O.
// A topic's name is a label for the lawyer, never evidence.

import { z } from "zod";
import { V2_MODELS } from "../costs/models";
import { contentWords } from "../verify";

export const TOPICS_PROMPT_VERSION = "topics-v1";
export const TOPICS_MODEL = V2_MODELS.topic_mapping;
export const TOPIC_MAX_OUTPUT_TOKENS = 16_000;
export const MAX_CARDS_PER_CALL = 2_000; // DESIGN.md: a larger witness is read in parts
export const UNASSIGNED = "Unassigned";

const TopicsOutput = z.strictObject({ topics: z.array(z.strictObject({ name: z.string(), primary: z.array(z.string()), secondary: z.array(z.string()) })) });
const { $schema: _unused, ...topicsJsonSchema } = z.toJSONSchema(TopicsOutput);
export const TOPICS_JSON_SCHEMA = topicsJsonSchema as Record<string, unknown>;

export const TOPICS_SYSTEM_PROMPT = `You organize a deposition witness's statements into topics, so that statements about the same event or subject can be compared across sessions. You only group; you never judge truth, contradiction or confidence.

You receive one line per statement card, like "[C12] The March 2003 PeopleSoft board meeting". You may also receive a list of existing topics.

Rules:
- Every card goes in the primary list of exactly one topic: the subject it is most about.
- A card may also go in the secondary list of any other topics it bears on. A statement about a pricing negotiation can have "PeopleSoft negotiations" as primary, and "Pricing and discounts" and "Acquisition strategy" as secondary. Add a secondary topic whenever the card would be worth comparing with that topic's cards.
- A topic names one concrete event or subject, in a few plain words: "PeopleSoft board meeting, March 2003", not "Meetings".
- Cards about the same event belong together even when they are worded differently. Do not make separate topics for the same event.
- When existing topics are listed, reuse their exact names for cards that fit, and add a new topic only when none fits.
- Use only card IDs from the input. If a card fits no topic, leave it out; never put cards in a catch-all topic.`;

export const cardLabel = (id: number) => `C${id}`;
export type TopicCard = { id: number; event: string };

export function formatTopicInput(cards: readonly TopicCard[], existing: readonly string[]): string {
  const known = existing.length > 0 ? `Existing topics:\n${existing.map((n) => `- ${n}`).join("\n")}\n\n` : "";
  return `${known}Cards:\n${cards.map((c) => `[${cardLabel(c.id)}] ${c.event}`).join("\n")}`;
}

export type MappedTopic = { name: string; primary: number[]; secondary: number[] };
export type TopicReading = {
  unusable: string | null;
  topics: MappedTopic[];
  unassigned: number[]; // cards with no primary topic; any secondary topics stay on the card
  unknownCards: string[]; // IDs that aren't in the input: rejected
  duplicates: number; // repeats dropped, including a second primary, which becomes secondary
};

// Reads one response against the cards that were sent. A bad ID never costs the rest; a response
// that can't be read returns `unusable`. A name matching an existing topic takes its spelling.
export function readTopicMap(cardIds: readonly number[], reply: { stopReason: string | null; text: string | null } | null, existing: readonly string[] = []): TopicReading {
  const fail = (reason: string): TopicReading => ({ unusable: reason, topics: [], unassigned: [...cardIds], unknownCards: [], duplicates: 0 });
  if (reply === null) return fail("no response");
  if (reply.stopReason === "refusal") return fail("the model refused");
  if (reply.stopReason === "max_tokens") return fail("cut off at max_tokens");
  let parsed;
  try {
    parsed = TopicsOutput.parse(JSON.parse(reply.text ?? ""));
  } catch {
    return fail("the output doesn't match the topic schema");
  }

  const labels = new Map(cardIds.map((id) => [cardLabel(id), id]));
  const spelled = new Map(existing.map((n) => [n.trim().toLowerCase(), n]));
  const topics = new Map<string, { name: string; primary: Set<number>; secondary: Set<number> }>();
  const primaryOf = new Map<number, string>();
  const unknown = new Set<string>();
  let duplicates = 0;
  const idOf = (label: string) => {
    const id = labels.get(label);
    if (id === undefined) unknown.add(label);
    return id;
  };
  const named = parsed.topics.map((t) => ({ ...t, key: t.name.trim().toLowerCase() })).filter((t) => t.key && t.key !== UNASSIGNED.toLowerCase());
  for (const t of named) if (!topics.has(t.key)) topics.set(t.key, { name: spelled.get(t.key) ?? t.name.trim(), primary: new Set(), secondary: new Set() });
  for (const t of named) {
    for (const label of t.primary) {
      const id = idOf(label);
      if (id === undefined) continue;
      if (!primaryOf.has(id)) {
        primaryOf.set(id, t.key);
        topics.get(t.key)!.primary.add(id);
      } else {
        duplicates++;
        if (primaryOf.get(id) !== t.key) topics.get(t.key)!.secondary.add(id);
      }
    }
  }
  for (const t of named) {
    for (const label of t.secondary) {
      const id = idOf(label);
      if (id === undefined) continue;
      const topic = topics.get(t.key)!;
      if (primaryOf.get(id) === t.key || topic.secondary.has(id)) duplicates++;
      else topic.secondary.add(id);
    }
  }
  return {
    unusable: null,
    topics: [...topics.values()].filter((t) => t.primary.size + t.secondary.size > 0).map((t) => ({ name: t.name, primary: [...t.primary], secondary: [...t.secondary] })),
    unassigned: cardIds.filter((id) => !primaryOf.has(id)),
    unknownCards: [...unknown],
    duplicates,
  };
}

export type TopicMember = { topic: string; isUnassigned: boolean; isPrimary: boolean; cardId: number; depositionId: number };

export type TopicReport = {
  topics: number;
  cards: number;
  assigned: number;
  unassigned: number;
  topicCoverage: number | null; // share of cards with a real primary topic
  multiTopicCards: number; // cards with at least one secondary topic
  fragmentation: {
    singleSession: number; // topics that can't form a cross-session pair on their own
    singletons: number; // topics with one card
    nearDuplicateNames: string[][]; // topic names sharing most of their words: possibly one event split
    largestTopicShare: number | null; // share of cards in the biggest topic: a catch-all shows up here
  };
};

const similar = (a: readonly string[], b: readonly string[]) => {
  const y = new Set(b);
  const smaller = Math.min(new Set(a).size, y.size);
  return smaller > 0 && new Set(a.filter((w) => y.has(w))).size / smaller >= 0.6;
};

// Coverage and fragmentation of one map, from its memberships.
export function topicReport(members: readonly TopicMember[]): TopicReport {
  const byTopic = new Map<string, TopicMember[]>();
  for (const m of members) if (!m.isUnassigned) byTopic.set(m.topic, [...(byTopic.get(m.topic) ?? []), m]);
  const cards = new Set(members.map((m) => m.cardId));
  const unassigned = new Set(members.filter((m) => m.isUnassigned && m.isPrimary).map((m) => m.cardId)).size;
  const names = [...byTopic.keys()];
  const words = new Map(names.map((n) => [n, contentWords(n)]));
  const nearDuplicateNames: string[][] = [];
  names.forEach((a, i) => names.slice(i + 1).forEach((b) => similar(words.get(a)!, words.get(b)!) && nearDuplicateNames.push([a, b])));
  const sizes = [...byTopic.values()].map((m) => new Set(m.map((x) => x.cardId)).size);
  return {
    topics: byTopic.size,
    cards: cards.size,
    assigned: cards.size - unassigned,
    unassigned,
    topicCoverage: cards.size === 0 ? null : (cards.size - unassigned) / cards.size,
    multiTopicCards: new Set(members.filter((m) => !m.isPrimary && !m.isUnassigned).map((m) => m.cardId)).size,
    fragmentation: {
      singleSession: [...byTopic.values()].filter((m) => new Set(m.map((x) => x.depositionId)).size < 2).length,
      singletons: sizes.filter((n) => n === 1).length,
      nearDuplicateNames,
      largestTopicShare: cards.size === 0 || sizes.length === 0 ? null : Math.max(...sizes) / cards.size,
    },
  };
}
