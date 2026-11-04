// The provider limiter for whole-case runs: one per worker process, shared by every run it executes.
//
//   slots      at most `maxInFlight` packets in flight across all runs. A freed slot goes to the waiting run
//              that holds the fewest slots (oldest waiter first on a tie), so a large case can't starve a small one.
//   buckets    the provider's limits as continuous token buckets, as the Messages API enforces them: requests
//              per minute, input tokens per minute (uncached input plus cache writes; cache reads don't count),
//              output tokens per minute (actual output, thinking included). Input is charged from an estimate
//              before the request and corrected to the reply's usage after it, as the provider does. Output is
//              only known as it is generated, so a request is admitted against its worst case (max_tokens) and
//              the unused part is refunded when the reply arrives: requests in flight can never together produce
//              more output than the bucket allowed, however long they run. A rejected request (4xx) is refunded
//              in full; one whose outcome is unknown keeps its whole charge. A bucket holds at most
//              `burstSeconds` of its rate, because the provider may enforce a per-minute limit over shorter
//              intervals; a request larger than that waits for a full bucket and leaves it in debt.
//   pause      a 429 or 529 pauses every request through this limiter until its retry-after (or reset) has passed.
//
// The limits are configuration (the account's tier), not assumptions; nothing here sends or retries a request.
// shortcut: per process only; several worker processes each get the full limits. Coordinate them in Postgres if
// the worker is ever scaled out.

import { z } from "zod";

export type ProviderLimits = { maxInFlight: number; requestsPerMinute: number; inputTokensPerMinute: number; outputTokensPerMinute: number; burstSeconds: number };
export type Clock = { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> };
export type Usage = { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null };
// input: estimated input tokens; output: the most output the request may produce (its max_tokens).
export type Ticket = { input: number; output: number };

export const UNLIMITED: ProviderLimits = { maxInFlight: Number.MAX_SAFE_INTEGER, requestsPerMinute: Infinity, inputTokensPerMinute: Infinity, outputTokensPerMinute: Infinity, burstSeconds: 10 };

export class Aborted extends Error {
  constructor() {
    super("aborted while waiting for the provider limiter");
  }
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((ok, no) => {
      if (signal?.aborted) return no(new Aborted());
      const t = setTimeout(() => { signal?.removeEventListener("abort", stop); ok(); }, Math.max(0, ms));
      const stop = () => { clearTimeout(t); no(new Aborted()); };
      signal?.addEventListener("abort", stop, { once: true });
    }),
};

// A continuous token bucket. Its level may go below zero when a reply used more than its estimate: later
// requests then wait until it is paid back.
class Bucket {
  private level: number;
  private at: number;
  constructor(private readonly perMinute: number, private readonly capacity: number, now: number) {
    this.level = capacity;
    this.at = now;
  }
  private refill(now: number) {
    this.level = Math.min(this.capacity, this.level + ((now - this.at) * this.perMinute) / 60_000);
    this.at = now;
  }
  // How long until `amount` can be taken. A request larger than the whole bucket waits for a full bucket.
  waitFor(amount: number, now: number) {
    if (this.perMinute === Infinity) return 0;
    this.refill(now);
    const need = Math.min(amount, this.capacity) - this.level;
    return need <= 0 ? 0 : Math.ceil((need * 60_000) / this.perMinute);
  }
  take(amount: number, now: number) {
    if (this.perMinute === Infinity) return;
    this.refill(now);
    this.level = Math.min(this.capacity, this.level - amount); // a refund never fills past the top
  }
}

export type Slot = { release(): void };

export class ProviderLimiter {
  private readonly requests: Bucket;
  private readonly input: Bucket;
  private readonly output: Bucket;
  private pausedUntil = 0;
  private readonly held = new Map<string, number>();
  private readonly waiting: { owner: string; grant: (slot: Slot) => void; seq: number }[] = [];
  private seq = 0;
  readonly stats = { pauses: 0, peakInFlight: 0, waitedMs: 0 };

  constructor(readonly limits: ProviderLimits = UNLIMITED, private readonly clock: Clock = realClock) {
    const now = clock.now();
    const cap = (perMinute: number) => Math.max(1, (perMinute * limits.burstSeconds) / 60);
    this.requests = new Bucket(limits.requestsPerMinute, cap(limits.requestsPerMinute), now);
    this.input = new Bucket(limits.inputTokensPerMinute, cap(limits.inputTokensPerMinute), now);
    this.output = new Bucket(limits.outputTokensPerMinute, cap(limits.outputTokensPerMinute), now);
  }

  inFlight() {
    let n = 0;
    for (const v of this.held.values()) n += v;
    return n;
  }

  waitingCount() {
    return this.waiting.length;
  }

  // A packet slot for `owner` (a run). Resolves when one is free; rejects with Aborted if `signal` fires first.
  acquireSlot(owner: string, signal?: AbortSignal): Promise<Slot> {
    if (signal?.aborted) return Promise.reject(new Aborted());
    if (this.inFlight() < this.limits.maxInFlight && this.waiting.length === 0) return Promise.resolve(this.grant(owner));
    return new Promise((ok, no) => {
      const entry = { owner, seq: this.seq++, grant: (slot: Slot) => { signal?.removeEventListener("abort", onAbort); ok(slot); } };
      const onAbort = () => {
        const i = this.waiting.indexOf(entry);
        if (i >= 0) this.waiting.splice(i, 1);
        no(new Aborted());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(entry);
    });
  }

  private grant(owner: string): Slot {
    this.held.set(owner, (this.held.get(owner) ?? 0) + 1);
    this.stats.peakInFlight = Math.max(this.stats.peakInFlight, this.inFlight());
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const n = (this.held.get(owner) ?? 1) - 1;
        if (n > 0) this.held.set(owner, n);
        else this.held.delete(owner);
        this.dispatch();
      },
    };
  }

  // Fair hand-off: the waiting owner holding the fewest slots, then the oldest waiter.
  private dispatch() {
    while (this.waiting.length && this.inFlight() < this.limits.maxInFlight) {
      let best = 0;
      for (let i = 1; i < this.waiting.length; i++) {
        const [a, b] = [this.waiting[i], this.waiting[best]];
        const [ha, hb] = [this.held.get(a.owner) ?? 0, this.held.get(b.owner) ?? 0];
        if (ha < hb || (ha === hb && a.seq < b.seq)) best = i;
      }
      const [next] = this.waiting.splice(best, 1);
      next.grant(this.grant(next.owner));
    }
  }

  // Waits until a request with these estimated tokens may be sent, then charges it. Nothing is charged if aborted.
  async beforeSend(estimate: Ticket, signal?: AbortSignal): Promise<Ticket> {
    for (;;) {
      if (signal?.aborted) throw new Aborted();
      const now = this.clock.now();
      const wait = Math.max(this.pausedUntil - now, this.requests.waitFor(1, now), this.input.waitFor(estimate.input, now), this.output.waitFor(estimate.output, now));
      if (wait <= 0) {
        this.requests.take(1, now);
        this.input.take(estimate.input, now);
        this.output.take(estimate.output, now);
        return estimate;
      }
      this.stats.waitedMs += wait;
      await this.clock.sleep(wait, signal);
    }
  }

  // Corrects the charge to what the reply used: input to its uncached input and cache writes (cache reads don't
  // count), output refunded down to what was generated.
  afterReply(ticket: Ticket, usage: Usage) {
    const now = this.clock.now();
    this.input.take(usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) - ticket.input, now);
    this.output.take(Math.min(usage.output_tokens, ticket.output) - ticket.output, now);
  }

  // A request that got no reply. Rejected before generating anything (billable false): refunded in full. Its
  // outcome unknown: the whole charge stays, since it may have run to max_tokens.
  afterFailure(ticket: Ticket, billable: boolean) {
    if (billable) return;
    const now = this.clock.now();
    this.input.take(-ticket.input, now);
    this.output.take(-ticket.output, now);
  }

  // Every request through this limiter waits until `ms` from now.
  pause(ms: number) {
    this.stats.pauses++;
    this.pausedUntil = Math.max(this.pausedUntil, this.clock.now() + ms);
  }
}

// The worker's settings, from the environment. Defaults are conservative for a first paid pilot; set the
// provider limits to the account's tier (Console, Rate limits page).
const positive = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const CaseRunEnv = z.object({
  CASE_RUN_PACKETS_PER_CASE: positive(2),
  CASE_RUN_PACKETS_GLOBAL: positive(4),
  CASE_RUN_MAX_CASES: positive(2),
  PROVIDER_REQUESTS_PER_MINUTE: positive(50),
  PROVIDER_INPUT_TOKENS_PER_MINUTE: positive(200_000),
  PROVIDER_OUTPUT_TOKENS_PER_MINUTE: positive(200_000), // worst case per 8-pair packet: 44,000 (max_tokens)
  PROVIDER_BURST_SECONDS: positive(10),
});
export type CaseRunSettings = { packetsPerCase: number; maxCases: number; limits: ProviderLimits };

export function caseRunSettings(env: Record<string, string | undefined>): CaseRunSettings {
  const e = CaseRunEnv.parse(Object.fromEntries(Object.keys(CaseRunEnv.shape).map((k) => [k, env[k] === "" ? undefined : env[k]])));
  if (e.CASE_RUN_PACKETS_PER_CASE > e.CASE_RUN_PACKETS_GLOBAL) throw new Error("CASE_RUN_PACKETS_PER_CASE can't be more than CASE_RUN_PACKETS_GLOBAL.");
  return {
    packetsPerCase: e.CASE_RUN_PACKETS_PER_CASE,
    maxCases: e.CASE_RUN_MAX_CASES,
    limits: { maxInFlight: e.CASE_RUN_PACKETS_GLOBAL, requestsPerMinute: e.PROVIDER_REQUESTS_PER_MINUTE, inputTokensPerMinute: e.PROVIDER_INPUT_TOKENS_PER_MINUTE, outputTokensPerMinute: e.PROVIDER_OUTPUT_TOKENS_PER_MINUTE, burstSeconds: e.PROVIDER_BURST_SECONDS },
  };
}
