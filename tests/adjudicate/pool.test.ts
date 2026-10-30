import { describe, expect, it } from "vitest";
import { runPool, type PoolStep } from "../../server/src/adjudicate";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("runPool", () => {
  it.each([1, 5, 10])("never exceeds a concurrency of %i and runs everything", async (concurrency) => {
    let active = 0;
    let seenPeak = 0;
    const done: number[] = [];
    const items = Array.from({ length: 40 }, (_, i) => i);
    const result = await runPool(items, { concurrency }, async (i) => {
      seenPeak = Math.max(seenPeak, ++active);
      await delay(1 + (i % 3));
      active--;
      done.push(i);
    });
    expect(seenPeak).toBe(concurrency);
    expect(result.peak).toBe(concurrency);
    expect([...done].sort((a, b) => a - b)).toEqual(items);
    expect(result.stopped).toBeNull();
  });

  it("starts the next item as soon as a slot frees, without waiting for the group", async () => {
    const order: string[] = [];
    await runPool(["slow", "fast", "next"], { concurrency: 2 }, async (x) => {
      order.push(`start ${x}`);
      await delay(x === "slow" ? 30 : 1);
      order.push(`end ${x}`);
    });
    expect(order.indexOf("start next")).toBeLessThan(order.indexOf("end slow"));
  });

  it("warms up with one item before running the rest at once", async () => {
    const order: string[] = [];
    await runPool([1, 2, 3], { concurrency: 3, warmFirst: true }, async (x) => {
      order.push(`start ${x}`);
      await delay(2);
      order.push(`end ${x}`);
    });
    expect(order.slice(0, 2)).toEqual(["start 1", "end 1"]);
  });

  it("a stop keeps running work but dispatches nothing new", async () => {
    const started: number[] = [];
    const result = await runPool([1, 2, 3, 4, 5, 6], { concurrency: 2 }, async (i): Promise<PoolStep> => {
      started.push(i);
      await delay(2);
      return i === 1 ? { stop: "failures" } : {};
    });
    expect(result.stopped).toBe("failures");
    expect(started.length).toBeLessThan(6);
    expect(result.unstarted.length).toBe(6 - started.length);
  });

  it("an outside stop takes effect immediately", async () => {
    let control!: { stop(r: string): void };
    const started: number[] = [];
    const result = await runPool([1, 2, 3, 4], { concurrency: 1 }, async (i) => {
      started.push(i);
      if (i === 1) control.stop("cancelled");
      await delay(1);
    }, (c) => (control = c));
    expect(result.stopped).toBe("cancelled");
    expect(started).toEqual([1]);
  });

  it("a pause holds new dispatches for the time asked", async () => {
    const times: number[] = [];
    const t0 = Date.now();
    await runPool([1, 2], { concurrency: 1 }, async (i): Promise<PoolStep> => {
      times.push(Date.now() - t0);
      return i === 1 ? { pauseMs: 40 } : {};
    });
    expect(times[1]).toBeGreaterThanOrEqual(38);
  });

  it("requeues an item that couldn't start until another finishes, and stops if nothing is running", async () => {
    let held = true;
    const attempts: number[] = [];
    const result = await runPool([1, 2], { concurrency: 2 }, async (i): Promise<PoolStep> => {
      attempts.push(i);
      if (i === 1) {
        await delay(10);
        held = false;
        return {};
      }
      return held ? { requeue: "budget" } : {};
    });
    expect(result.stopped).toBeNull();
    expect(attempts.filter((x) => x === 2).length).toBe(2);
    const alone = await runPool([1], { concurrency: 2 }, async (): Promise<PoolStep> => ({ requeue: "budget" }));
    expect(alone.stopped).toBe("budget");
    expect(alone.unstarted).toEqual([1]);
  });

  it("reports an unexpected error after what is running has finished", async () => {
    let finished = false;
    await expect(
      runPool([1, 2], { concurrency: 2 }, async (i) => {
        if (i === 1) throw new Error("database down");
        await delay(5);
        finished = true;
      }),
    ).rejects.toThrow("database down");
    expect(finished).toBe(true);
  });
});
