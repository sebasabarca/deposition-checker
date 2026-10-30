// Optional stage timings for benchmarks. With BENCHMARK_TIMING_FILE set, each timed stage appends one
// JSON line to that file (the API and the worker are separate processes, so a file serves both, and
// a line already written survives a crash). Unset, as in normal use, these only call the function.

import { appendFileSync } from "node:fs";

export type Timing = { stage: string; ms: number; at: string; pid: number } & Record<string, unknown>;

export function recordTiming(stage: string, ms: number, meta: Record<string, unknown> = {}) {
  const file = process.env.BENCHMARK_TIMING_FILE;
  if (!file) return;
  appendFileSync(file, `${JSON.stringify({ stage, ms: Math.round(ms * 100) / 100, at: new Date().toISOString(), pid: process.pid, ...meta })}\n`);
}

export async function timed<T>(stage: string, run: () => Promise<T>, meta?: Record<string, unknown>): Promise<T> {
  const started = performance.now();
  try {
    return await run();
  } finally {
    recordTiming(stage, performance.now() - started, meta);
  }
}

export function timedSync<T>(stage: string, run: () => T, meta?: Record<string, unknown>): T {
  const started = performance.now();
  try {
    return run();
  } finally {
    recordTiming(stage, performance.now() - started, meta);
  }
}
