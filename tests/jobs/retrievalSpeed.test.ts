// The exact retrieval speed-ups are read by case runs only from explicit settings.
import { describe, expect, it } from "vitest";
import { retrievalSpeedOf } from "../../server/src/jobs/caseRun";

describe("retrievalSpeedOf", () => {
  it("is off by default and reads RETRIEVAL_PATH_A / RETRIEVAL_DENSE_THREADS", () => {
    expect(retrievalSpeedOf({})).toEqual({});
    expect(retrievalSpeedOf({ RETRIEVAL_PATH_A: "memory", RETRIEVAL_DENSE_THREADS: "8" })).toEqual({ pathA: "memory", denseThreads: 8 });
    expect(retrievalSpeedOf({ RETRIEVAL_PATH_A: "postgres", RETRIEVAL_DENSE_THREADS: "1" })).toEqual({});
    expect(() => retrievalSpeedOf({ RETRIEVAL_DENSE_THREADS: "0" })).toThrow();
    expect(() => retrievalSpeedOf({ RETRIEVAL_DENSE_THREADS: "2.5" })).toThrow();
  });
});
