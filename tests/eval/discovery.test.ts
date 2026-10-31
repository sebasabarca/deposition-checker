import { describe, expect, it } from "vitest";
import { discoveryMetrics, distractors, mockCardModel, mockTopicModel, withDistractors } from "../../server/src/eval";
import { WEBB_SUITE } from "../../server/src/eval/synthetic";
import { readCards } from "../../server/src/claims";
import { unionCandidates, type RankedPair } from "../../server/src/retrieve";

const pair = (n: number, rank: number): RankedPair => ({ rank, score: 1, a: { depositionId: 1, groupId: n }, b: { depositionId: 2, groupId: n }, exchangeA: 1, exchangeB: 2, sharedTerms: [], foundBy: "a" });

describe("discovery metrics", () => {
  const target = (id: string, n: number) => ({ id, a: { depositionId: 1, groupId: n }, b: { depositionId: 2, groupId: n } });

  it("scores recall per path and names what was missed", () => {
    const pool = unionCandidates({ fulltext: [pair(1, 1), pair(2, 2), pair(3, 3)] }, { capacity: 2 });
    const m = discoveryMetrics(pool, [target("first", 1), target("third", 3), target("gone", 9)], [1, 3]);
    expect(m.recallAtK).toEqual([{ k: 1, pathA: 0, pathB: 1, pool: 1 }, { k: 3, pathA: 0, pathB: 2, pool: 1 }]);
    expect(m.found).toMatchObject({ onlyB: ["first", "third"], missed: ["gone"] });
    expect(m.selection).toMatchObject({ targetsSelected: 1, targetsDeferred: ["third"] });
  });
});

describe("distractors", () => {
  it("are the same every time, and answer a repeated subject the same way", () => {
    expect(distractors(0, 40)).toBe(distractors(0, 40));
    const answers = new Map<string, Set<string>>();
    for (const block of `${distractors(0, 400)}\n\n${distractors(1, 400)}`.split("\n\n")) {
      const [q, a] = block.split("\n");
      answers.set(q, (answers.get(q) ?? new Set()).add(a));
    }
    for (const a of answers.values()) expect(a.size).toBe(1);
  });

  it("keep every labelled exchange and don't name a target", () => {
    const mixed = withDistractors(WEBB_SUITE, 30);
    for (const c of WEBB_SUITE.cases) {
      expect(mixed.sessions[0].text).toContain(c.questionA);
      expect(mixed.sessions[1].text).toContain(c.questionB);
      expect(distractors(0, 30)).not.toContain(c.questionA);
    }
  });
});

describe("mock models", () => {
  it("read only the text they are sent, and their cards pass the real checks", async () => {
    const lines = [{ id: 1, role: "question" as const, text: "Q. Have you met Daniel Cho?" }, { id: 2, role: "answer" as const, text: "A. No, I never met him." }];
    const chunk = { depositionId: 1, witnessId: 1, exchanges: [{ id: 7, depositionId: 1, witnessId: 1, kind: "qa", lines }] };
    const reply = await mockCardModel().extract("[E7]\nQ: Have you met Daniel Cho?\nA: No, I never met him.");
    const reading = readCards(chunk, reply);
    expect(reading.cards[0]).toMatchObject({ status: "usable", entities: ["daniel cho"] });
    expect(reading.cards[0].card?.stance).toBe("denies");
  });

  it("topics group shared event words and leave lone cards out", async () => {
    const reply = await mockTopicModel().extract("Cards:\n[C1] Fire alarm monday\n[C2] Fire alarm tuesday\n[C3] Unrelated lunch");
    expect(JSON.parse(reply.text!).topics[0].primary).toEqual(["C1", "C2"]);
  });
});
