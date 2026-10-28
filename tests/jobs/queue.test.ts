import { describe, expect, it } from "vitest";
import { parseIngestJob } from "../../server/src/jobs/queue";

describe("parseIngestJob", () => {
  it("keeps the run a job was queued for", () => {
    expect(parseIngestJob({ depositionId: 4, run: 2 })).toEqual({ depositionId: 4, run: 2 });
  });

  it("reads a job queued before runs existed as run 1, the run migration 0003 gave its deposition", () => {
    expect(parseIngestJob({ depositionId: 4 })).toEqual({ depositionId: 4, run: 1 });
  });

  it("throws on a payload that can't name a deposition and run, so the job fails visibly", () => {
    for (const bad of [null, {}, { depositionId: "4" }, { depositionId: 0 }, { depositionId: 4, run: 0 }, { depositionId: 4, run: 1.5 }]) {
      expect(() => parseIngestJob(bad)).toThrow();
    }
  });
});
