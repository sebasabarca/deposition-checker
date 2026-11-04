// Adding many transcripts at once: the witness guessed from a file name, the row check and the
// limited-concurrency runner.

import { describe, expect, it } from "vitest";
import { guessWitness, needsWitness, runLimited } from "../../client/src/lib/bulkUpload";

const CASE = ["Marcus Webb", "Linda Webb", "Cassidy Hutchinson", "Ann O'Brien Jr."];

describe("guessWitness", () => {
  it("finds a known witness's surname, ignoring case and separators", () => {
    expect(guessWitness("hutchinson_june_2022.pdf", CASE)).toBe("Cassidy Hutchinson");
    expect(guessWitness("HUTCHINSON-Vol2.txt", CASE)).toBe("Cassidy Hutchinson");
    expect(guessWitness("HutchinsonSept2022.pdf", CASE)).toBe("Cassidy Hutchinson");
    expect(guessWitness("Depo.OBrien.2023-03-14.docx", CASE)).toBe("Ann O'Brien Jr.");
  });

  it("uses the other name words to choose between witnesses who share a surname", () => {
    expect(guessWitness("Webb_Marcus_Vol1.pdf", CASE)).toBe("Marcus Webb");
    expect(guessWitness("linda-webb.txt", CASE)).toBe("Linda Webb");
    expect(guessWitness("Webb Deposition.pdf", CASE)).toBe("");
  });

  it("leaves the witness empty instead of inventing a name", () => {
    expect(guessWitness("Deposition of John Smith.pdf", CASE)).toBe("");
    expect(guessWitness("Marcus_2023.pdf", CASE)).toBe(""); // a first name alone is not enough
    expect(guessWitness("Webbster.pdf", CASE)).toBe(""); // only whole words
    expect(guessWitness("hutchinson.pdf", [])).toBe("");
  });
});

describe("needsWitness", () => {
  it("flags only rows still to send with no witness", () => {
    expect(needsWitness({ witness: "  ", state: "waiting" })).toBe(true);
    expect(needsWitness({ witness: "", state: "failed" })).toBe(true);
    expect(needsWitness({ witness: "Marcus Webb", state: "waiting" })).toBe(false);
    expect(needsWitness({ witness: "", state: "added" })).toBe(false);
  });
});

describe("runLimited", () => {
  it("never runs more than the limit at once, and a failure doesn't stop the rest", async () => {
    let running = 0;
    let peak = 0;
    const done: number[] = [];
    await runLimited([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, n % 3));
      running--;
      if (n === 2) throw new Error("upload failed");
      done.push(n);
    });
    expect(peak).toBe(3);
    expect(done.sort()).toEqual([1, 3, 4, 5, 6, 7]);
  });

  it("handles an empty list", async () => {
    await expect(runLimited([], 3, async () => undefined)).resolves.toBeUndefined();
  });
});
