// Deterministic stand-ins for the card and topic models, for tests and the discovery evaluation. They
// never touch the network, and they read only the text a real model would receive: they know nothing
// of the labels. What they measure is the pipeline, never Haiku's quality. Cards come from simple
// rules (the question is the event, the answer's first sentence the source phrase), and topics from
// shared words in the event lines.

import type Anthropic from "@anthropic-ai/sdk";
import type { ClaimModel } from "../claims";
import { contentWords, normalize } from "../verify";

export const MOCK_HAIKU = "claude-haiku-5-5";
const usage = (chars: number) => ({ input_tokens: Math.round(chars / 3), output_tokens: Math.round(chars / 2), cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null }) as unknown as Anthropic.Usage;
const CAPITALIZED = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g;
const NOT_NAMES = new Set(["Q", "A", "I", "Yes", "No", "Did", "Do", "Have", "Had", "Were", "Was", "What", "When", "Where", "Who", "How", "Which", "The", "That", "This", "Not", "Never", "My", "We", "He", "She", "It", "They", "Around", "About", "Maybe", "Just", "And", "But", "So", "Once", "Twice", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]);

const PREDICATE_RULES: [RegExp, string][] = [[/approv/i, "approve"], [/\b(discuss|talk|speak|spoke|call)/i, "communicate"], [/\bsign/i, "agree"], [/\b(attend|meeting|where were you)/i, "attend"], [/\b(work with|handled)\b/i, "role"], [/\b(see|saw|review)/i, "review"], [/\b(know|heard|met)\b/i, "know"], [/\b(how many|what time|when)\b/i, "measure"]];

// Sabotage for measuring rejections: the nth card (1-based, every `every`) comes back wrong.
export type CardNoise = { fabricateEvery?: number; unknownExchangeEvery?: number; omitEvery?: number; fail?: (call: number) => Error | null; stopReason?: (call: number) => string };

export function mockCardModel(noise: CardNoise = {}): ClaimModel & { calls: number } {
  let seen = 0;
  const mock = {
    model: MOCK_HAIKU,
    calls: 0,
    async extract(text: string) {
      const call = ++mock.calls;
      const failure = noise.fail?.(call);
      if (failure) throw failure;
      const cards: Record<string, unknown>[] = [];
      const noAssertion: string[] = [];
      for (const block of text.split(/^(?=\[E\d+\]$)/m)) {
        const id = block.match(/^\[(E\d+)\]/)?.[1];
        if (!id) continue;
        seen++;
        if (noise.omitEvery && seen % noise.omitEvery === 0) continue;
        const question = block.match(/^Q: ([\s\S]*?)(?=^A: |$(?![\s\S]))/m)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
        const answer = block.match(/^A: ([\s\S]*)/m)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
        if (!answer) {
          noAssertion.push(id);
          continue;
        }
        const first = answer.match(/^[^.?!]*[.?!]?/)?.[0].trim() || answer;
        // A bare answer rests on the question, like a real card; "No, I was alone." rests on its words.
        const phrase = first.replace(/^(yes|no)[,.]\s*/i, "") || first;
        const noRecall = /\bdon'?t (recall|remember)\b/i.test(answer);
        const noKnowledge = /\bdon'?t know\b/i.test(answer);
        const denies = /^(no\b|never\b|i never\b|i did not\b|i didn'?t\b|not\b|i have never\b|i'?d never\b)/i.test(answer) || /\b(never|not once)\b/i.test(first);
        const names = [...new Set([...`${question} ${answer}`.matchAll(CAPITALIZED)].map((m) => m[0]).filter((n) => !NOT_NAMES.has(n.split(" ")[0]) || n.includes(" ")))];
        const when = answer.match(/\b(?:\d{1,2}(?::\d{2})?(?:\s?[ap]m)?|midnight|noon|january|february|march|april|may|june|july|august|september|october|november|december)\b/i)?.[0] ?? null;
        const amount = answer.match(/\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|fifteen|twenty|\d+)\b/i)?.[0] ?? null;
        const n = cards.length + 1;
        cards.push({
          exchangeId: noise.unknownExchangeEvery && n % noise.unknownExchangeEvery === 0 ? "E999999" : id,
          sourcePhrase: noise.fabricateEvery && n % noise.fabricateEvery === 0 ? "words the witness never said in this exchange" : phrase,
          statement: question, // the proposition; stance carries the direction
          event: question,
          subject: "the witness",
          entities: names,
          predicate: PREDICATE_RULES.find(([words]) => words.test(question))?.[1] ?? "other",
          object: null,
          time: when,
          location: null,
          amount: when === amount ? null : amount,
          stance: noRecall || noKnowledge ? "not_answered" : denies ? "denies" : "asserts",
          epistemic: noRecall ? "does_not_recall" : noKnowledge ? "does_not_know" : /\b(i think|i believe|maybe|might|probably)\b/i.test(answer) ? "qualified" : "asserted",
        });
      }
      const output = JSON.stringify({ cards, noAssertion });
      return { stopReason: noise.stopReason?.(call) ?? "end_turn", usage: usage(text.length), text: output };
    },
  };
  return mock;
}

// Groups cards whose event lines share at least `minShared` words that aren't everywhere. The first
// topic a card joins is primary; any other it would fit is secondary. Words used by more than a fifth
// of the cards say nothing, so they don't count; a card sharing nothing with anyone stays unassigned.
export function mockTopicModel({ minShared = 2 } = {}): ClaimModel & { calls: number } {
  const mock = {
    model: MOCK_HAIKU,
    calls: 0,
    async extract(text: string) {
      mock.calls++;
      const lines = [...text.matchAll(/^\[(C\d+)\] (.*)$/gm)].map((m) => ({ id: m[1], words: new Set(contentWords(m[2])) }));
      const existing = [...text.matchAll(/^- (.*)$/gm)].map((m) => m[1]);
      const df = new Map<string, number>();
      for (const l of lines) for (const w of l.words) df.set(w, (df.get(w) ?? 0) + 1);
      const limit = Math.max(4, lines.length / 5);
      const useful = (l: (typeof lines)[number]) => [...l.words].filter((w) => (df.get(w) ?? 0) >= 2 && (df.get(w) ?? 0) <= limit);
      const topics: { name: string; key: Set<string>; primary: string[]; secondary: string[] }[] = existing.map((name) => ({ name, key: new Set(normalize(name).split(" ")), primary: [], secondary: [] }));
      for (const l of lines) {
        const words = useful(l);
        const fits = topics.filter((t) => words.filter((w) => t.key.has(w)).length >= minShared);
        if (fits.length > 0) {
          fits[0].primary.push(l.id);
          for (const t of fits.slice(1)) t.secondary.push(l.id);
        } else if (words.length >= minShared) {
          topics.push({ name: words.slice(0, 4).join(" "), key: new Set(words), primary: [l.id], secondary: [] });
        }
      }
      return { stopReason: "end_turn", usage: usage(text.length), text: JSON.stringify({ topics: topics.map(({ name, primary, secondary }) => ({ name, primary, secondary })) }) };
    },
  };
  return mock;
}
