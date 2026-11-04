// A fake Message Batches API for packet adjudication, with the label-blind mock replies (mockPacketModel.ts).
// It models what the real provider does that matters to economy runs: a batch is accepted at once and ends
// later; results come back in any order and can be delivered twice; single requests can error or expire; a
// cancel ends the batch with the unfinished requests cancelled; a submission can fail after the provider
// accepted it (the caller never learns the ID) or before; listing returns batches newest first.
// Its state is the provider's, not the application's: tests keep one instance across simulated worker restarts.
// No network, no API key, no cost.

import Anthropic from "@anthropic-ai/sdk";
import type { BatchCounts, BatchResult, BatchState, PacketBatchProvider, PacketBatchRequest } from "../adjudicate/packetBatch";
import type { IssuePacket } from "../adjudicate/packetPrompt";
import { mockPacketReply } from "./mockPacketModel";

// What one request gets: an answer (optionally leaving pairs out), an error, expiry, or no result at all.
export type FakeOutcome = { drop?: string[] } | "errored" | "invalid" | "expired" | "omit";
// What one submission does: accepted, refused (rate limit or a 400: nothing created), or lost (the connection
// fails after the provider accepted it, or before).
export type FakeSubmit = "ok" | "rate_limited" | "invalid" | "lost_accepted" | "lost_unaccepted";

type FakeBatch = { id: string; createdAt: number; endsAt: number; requests: PacketBatchRequest[]; canceledAt: number | null };

export type FakeBatchOptions = {
  model?: string;
  processingMs?: number; // how long a batch takes to end
  now?: () => number;
  outcome?: (request: PacketBatchRequest, sent: number) => FakeOutcome; // sent: the nth time this packet was submitted
  onSubmit?: (submission: number) => FakeSubmit;
  duplicateResults?: boolean; // every result delivered twice
  completeOnCancel?: number; // requests that still finish (and are billed) after a cancel
  outputPerPair?: number; // reported output tokens per answered pair (the mock's own default otherwise)
  failRetrieve?: (call: number) => boolean;
};

const apiError = (status: number, message: string) => Anthropic.APIError.generate(status, { type: "error", error: { type: status === 429 ? "rate_limit_error" : "invalid_request_error", message } }, message, new Headers());

export class FakeBatchProvider implements PacketBatchProvider {
  readonly batches = new Map<string, FakeBatch>();
  readonly sentPerPacket = new Map<string, number>();
  private readonly nthOf = new Map<string, number>(); // custom_id -> which submission of its packet it was
  submissions = 0;
  retrieves = 0;
  constructor(readonly options: FakeBatchOptions = {}) {}
  private now = () => (this.options.now ?? Date.now)();

  async submit(requests: PacketBatchRequest[]): Promise<BatchState> {
    const n = ++this.submissions;
    const mode = this.options.onSubmit?.(n) ?? "ok";
    if (mode === "rate_limited") throw apiError(429, "rate limited");
    if (mode === "invalid") throw apiError(400, "invalid request");
    if (mode === "lost_unaccepted") throw new Anthropic.APIConnectionError({ message: "connection reset before the request was sent" });
    const at = this.now();
    const batch: FakeBatch = { id: `msgbatch_fake_${n}_${at}_${Math.random().toString(36).slice(2, 10)}`, createdAt: at, endsAt: at + (this.options.processingMs ?? 0), requests, canceledAt: null };
    this.batches.set(batch.id, batch);
    for (const r of requests) {
      this.sentPerPacket.set(r.packet.id, (this.sentPerPacket.get(r.packet.id) ?? 0) + 1);
      this.nthOf.set(r.customId, this.sentPerPacket.get(r.packet.id)!);
    }
    if (mode === "lost_accepted") throw new Anthropic.APIConnectionError({ message: "connection reset after the request was sent" });
    return this.state(batch);
  }

  async retrieve(batchId: string): Promise<BatchState> {
    if (this.options.failRetrieve?.(++this.retrieves)) throw new Anthropic.APIConnectionError({ message: "timed out" });
    return this.state(this.get(batchId));
  }

  async *results(batchId: string): AsyncIterable<BatchResult> {
    const b = this.get(batchId);
    if (!this.ended(b)) throw apiError(400, "results are available only once the batch has ended");
    // Reversed: results never come back in submission order.
    const all = b.requests.map((r, i) => this.resultOf(b, r, i)).filter((r): r is BatchResult => r !== null).reverse();
    for (const r of all) {
      yield r;
      if (this.options.duplicateResults) yield r;
    }
  }

  async cancel(batchId: string): Promise<void> {
    const b = this.get(batchId);
    if (!this.ended(b)) b.canceledAt = this.now();
  }

  async *list(createdAfter: Date): AsyncIterable<BatchState> {
    for (const b of [...this.batches.values()].sort((x, y) => y.createdAt - x.createdAt)) {
      if (b.createdAt < createdAfter.getTime()) return;
      yield this.state(b);
    }
  }

  private get(batchId: string) {
    const b = this.batches.get(batchId);
    if (!b) throw apiError(404, `no batch ${batchId}`);
    return b;
  }
  private ended = (b: FakeBatch) => b.canceledAt !== null || this.now() >= b.endsAt;

  private resultOf(b: FakeBatch, r: PacketBatchRequest, index: number): BatchResult | null {
    if (b.canceledAt !== null && index >= (this.options.completeOnCancel ?? 0)) return { customId: r.customId, type: "canceled" };
    const o = this.options.outcome?.(r, this.nthOf.get(r.customId) ?? 1) ?? {};
    if (o === "omit") return null;
    if (o === "expired") return { customId: r.customId, type: "expired" };
    if (o === "errored") return { customId: r.customId, type: "errored", errorType: "api_error", message: "internal error" };
    if (o === "invalid") return { customId: r.customId, type: "errored", errorType: "invalid_request_error", message: "invalid request" };
    return { customId: r.customId, type: "succeeded", reply: this.reply(r.packet, o) };
  }

  private reply(packet: IssuePacket, o: { drop?: string[] }) {
    const m = mockPacketReply(packet, o);
    const answered = (JSON.parse(m.text) as { verdicts: unknown[] }).verdicts.length;
    const usage = { input_tokens: m.usage.inputTokens, output_tokens: this.options.outputPerPair ? this.options.outputPerPair * answered : m.usage.outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } as Anthropic.Usage;
    return { model: this.options.model ?? "mock-packet-v1", stopReason: "end_turn", usage, text: m.text, latencyMs: 0, requestId: null };
  }

  private state(b: FakeBatch): BatchState {
    const ended = this.ended(b);
    const counts: BatchCounts = { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0 };
    if (!ended) counts.processing = b.requests.length;
    else b.requests.forEach((r, i) => {
      const res = this.resultOf(b, r, i);
      if (res === null) counts.errored++; // the real provider always accounts for every request
      else counts[res.type === "succeeded" ? "succeeded" : res.type === "errored" ? "errored" : res.type === "expired" ? "expired" : "canceled"]++;
    });
    const endedAt = ended ? (b.canceledAt ?? b.endsAt) : null;
    return { id: b.id, status: ended ? "ended" : b.canceledAt !== null ? "canceling" : "in_progress", counts, createdAt: new Date(b.createdAt), endedAt: endedAt === null ? null : new Date(endedAt), expiresAt: new Date(b.createdAt + 24 * 3600_000) };
  }
}
