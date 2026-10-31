// Code's checks shared by statement cards: which named entities an exchange's own words support, and
// the line type cards are read against. Pure: no I/O.

import { contentWords, findHedge, locate, normalize, STOPWORDS } from "../verify";

export { contentWords, findHedge, locate };
import { normalizeEntities } from "./entities";

export type PartLine = { id: number; role: "question" | "answer" | "context" | "unknown"; text: string };

// An entity is kept only if the exchange's own words support it: every meaningful word of its name
// appears, or it is named by an alias, at least half its words, one of them capitalized as a proper
// noun ("Ms. Catz" for Safra Catz). A lowercase common word ("systems", "suite") never grounds a name
// on its own. Names the model added from the wider deposition are set aside as ungrounded.
export function groundEntities(entities: readonly string[], exchangeText: string): { entities: string[]; ungrounded: string[] } {
  const words = new Set(normalize(exchangeText).split(" "));
  const capitalized = new Set((exchangeText.match(/\b[A-Z][A-Za-z0-9&'-]*/g) ?? []).map((w) => normalize(w)));
  const grounded: string[] = [];
  const ungrounded: string[] = [];
  for (const entity of normalizeEntities(entities)) {
    const parts = normalize(entity).split(" ").filter((w) => w.length > 1 && !STOPWORDS.has(w));
    const present = parts.filter((w) => words.has(w));
    const byName = parts.length > 0 && present.length === parts.length;
    const byAlias = present.length * 2 >= parts.length && present.some((w) => capitalized.has(w));
    (byName || byAlias ? grounded : ungrounded).push(entity);
  }
  return { entities: grounded, ungrounded };
}
