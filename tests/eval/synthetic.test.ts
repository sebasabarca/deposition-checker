// The synthetic fixtures obey the transcript layout, so exchanges that span a page stay whole.

import { describe, expect, it } from "vitest";
import { SYNTHETIC_SUITES, toSourceLines } from "../../server/src/eval/synthetic";
import { syntheticPages } from "../../server/src/eval/syntheticStore";
import { buildExchangeParts } from "../../server/src/ingest/exchanges";
import { ELLISON_DOJ_V1 as LAYOUT } from "../../server/src/ingest/layout";
import { validateDeposition } from "../../server/src/ingest/validate";

describe("synthetic transcripts", () => {
  it("number lines within the layout's page length, and pass the real page validation", () => {
    for (const suite of SYNTHETIC_SUITES) {
      for (const s of suite.sessions) {
        const lines = toSourceLines(s.text, s.firstPage);
        expect(Math.max(...lines.map((l) => l.lineNo))).toBeLessThanOrEqual(LAYOUT.maxLinesPerPage);
        expect(validateDeposition(syntheticPages(lines), LAYOUT).status, `${suite.set} ${s.takenOn}`).toBe("ready");
      }
    }
  });

  it("keep a question on a page's last line and its answer on the next page in one exchange", () => {
    // Ten two-line exchanges, one with a two-line answer, fill 10:01-10:21; the next question is 10:22.
    const long = "Yes, and I remember it well because it was the same week as the audit.";
    const text = [`Q: Question number 1?\nA: ${long}`, ...Array.from({ length: 9 }, (_, i) => `Q: Question number ${i + 2}?\nA: Answer number ${i + 2}.`), "Q: Who signed the delivery log on June 4th?\nA: I did, after my shift ended.", "Q: Anything else?\nA: No."].join("\n\n");
    const lines = toSourceLines(text, 10);
    const q = lines.find((l) => l.rawText.startsWith("Q. Who signed"))!;
    const a = lines.find((l) => l.rawText.startsWith("A. I did, after"))!;
    expect([q.printedPage, q.lineNo, a.printedPage, a.lineNo]).toEqual([10, 22, 11, 1]);
    const part = buildExchangeParts(lines, LAYOUT).parts.find((p) => p.questionText.startsWith("Who signed"))!;
    expect(part).toMatchObject({ answerText: "I did, after my shift ended.", flags: [] });
  });

  it("flags a page that runs past the layout's last line, as the real validation does", () => {
    const lines = toSourceLines("Q: One?\nA: Yes.", 10).map((l, i) => ({ ...l, lineNo: 23 + i, lineFromPosition: 23 + i }));
    expect(validateDeposition(syntheticPages(lines), LAYOUT).status).not.toBe("ready");
  });
});
