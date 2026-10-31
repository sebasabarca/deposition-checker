import { describe, expect, it } from "vitest";
import { CARD_EXTRACTOR_VERSION, CARDS_SYSTEM_PROMPT, chunkByPages, estimateCards } from "../../server/src/claims";
import { CARDS_JSON_SCHEMA } from "../../server/src/claims/cards";

const onPages = (...pages: number[]) => pages.map((firstPage, id) => ({ id, firstPage }));

describe("chunkByPages", () => {
  it("cuts about 10 pages with one page of overlap", () => {
    const chunks = chunkByPages(onPages(...Array.from({ length: 25 }, (_, i) => i + 1)));
    expect(chunks.map((c) => [c[0].firstPage, c[c.length - 1].firstPage])).toEqual([[1, 10], [10, 19], [19, 25]]);
  });

  it("keeps every exchange of a page together, and covers them all", () => {
    const parts = onPages(1, 1, 2, 2, 2, 3);
    const chunks = chunkByPages(parts, 2, 1);
    expect(chunks.map((c) => c.map((p) => p.id))).toEqual([[0, 1, 2, 3, 4], [2, 3, 4, 5]]);
    expect(new Set(chunks.flat().map((p) => p.id)).size).toBe(parts.length);
  });

  it("counts only pages present, so a gap in an excerpt doesn't shrink a chunk", () => {
    expect(chunkByPages(onPages(1, 2, 50, 51), 3, 1).map((c) => c.map((p) => p.firstPage))).toEqual([[1, 2, 50], [50, 51]]);
  });

  it("makes no chunks from nothing", () => {
    expect(chunkByPages([])).toEqual([]);
  });
});

describe("the card request", () => {
  it("sends a schema structured outputs accepts: no string length constraints", () => {
    expect(JSON.stringify(CARDS_JSON_SCHEMA)).not.toContain("minLength");
  });

  it("asks for no confidence, score or probability", () => {
    expect(JSON.stringify(CARDS_JSON_SCHEMA)).not.toMatch(/confidence|score|probability/i);
  });

  it("states each rule the pilot showed was needed", () => {
    expect(CARDS_SYSTEM_PROMPT).toContain("never join the question's words to the answer's");
    expect(CARDS_SYSTEM_PROMPT).toContain("A statement never contains");
    expect(CARDS_SYSTEM_PROMPT).toContain("no answer always goes here");
    expect(CARDS_SYSTEM_PROMPT).toContain("not the exhibit or document");
  });

  it("names its version and tells silence from no assertion", () => {
    expect(CARD_EXTRACTOR_VERSION).toMatch(/^cards-v2\+/);
    expect(CARDS_SYSTEM_PROMPT).toContain("noAssertion");
  });

  it("estimates at or under the worst case, and nothing for no chunks", () => {
    const e = estimateCards([[{ id: 1, dialogueText: "Q: Did you?\nA: Yes." }]]);
    expect(e.expectedUsd).toBeGreaterThan(0);
    expect(e.worstCaseUsd).toBeGreaterThanOrEqual(e.expectedUsd);
    expect(estimateCards([]).worstCaseUsd).toBe(0);
  });
});
