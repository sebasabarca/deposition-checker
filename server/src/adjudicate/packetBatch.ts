// The Message Batches API client for packet adjudication (economy case runs, jobs/caseRunBatch.ts). Each request
// body is packetRequestParams, the same one the Messages API client sends, so a batch differs from a fast run
// only in transport and price. Only this file talks to the Batches API for packets; tests and mock runs use
// the fake provider in eval/mockPacketBatch.ts.
//
// What the provider documents (https://platform.claude.com/docs/en/build-with-claude/batch-processing, read
// November 4, 2026): at most 100,000 requests or 256 MB per batch; results in any order, matched by custom_id
// (^[a-zA-Z0-9_-]{1,64}$); a batch ends within 24 hours or its unfinished requests expire (not billed); results
// stay downloadable for 29 days after creation; errored, cancelled and expired requests are not billed; a batch
// carries no metadata, so after a crash the only way back to it is the list of batches by creation time.

import Anthropic from "@anthropic-ai/sdk";
import type { AdjudicatorReply } from "./model";
import { packetRequestParams } from "./packetModel";
import { PACKET_PROMPT_VERSION, PACKET_PROMPTS, type ContractId, type IssuePacket } from "./packetPrompt";

export const PROVIDER_MAX_REQUESTS = 100_000;
export const PROVIDER_MAX_BYTES = 256 * 1024 * 1024;
export const CUSTOM_ID = /^[a-zA-Z0-9_-]{1,64}$/;

// contract: the request contract (packet-v1 when absent; stretch-v2 for an experimental whole-stretch run).
export type PacketBatchRequest = { customId: string; packet: IssuePacket; contract?: ContractId };
export type BatchCounts = { processing: number; succeeded: number; errored: number; canceled: number; expired: number };
export type BatchState = { id: string; status: "in_progress" | "canceling" | "ended"; counts: BatchCounts; createdAt: Date; endedAt: Date | null; expiresAt: Date | null };
export type BatchResult = { customId: string } & (
  | { type: "succeeded"; reply: AdjudicatorReply }
  | { type: "errored"; errorType: string; message: string }
  | { type: "expired" }
  | { type: "canceled" }
);

export type PacketBatchProvider = {
  submit(requests: PacketBatchRequest[]): Promise<BatchState>;
  retrieve(batchId: string): Promise<BatchState>;
  results(batchId: string): AsyncIterable<BatchResult>; // only once the batch has ended
  cancel(batchId: string): Promise<void>;
  list(createdAfter: Date): AsyncIterable<BatchState>; // batches created since createdAfter, in any order
};

// A failure while reading from the provider (a dropped results stream, say), as opposed to one in our own code.
export class ProviderStreamError extends Error {}
async function* fromProvider<T>(items: AsyncIterable<T>): AsyncIterable<T> {
  const it = items[Symbol.asyncIterator]();
  for (;;) {
    let next: IteratorResult<T>;
    try {
      next = await it.next();
    } catch (e) {
      throw e instanceof Anthropic.APIError ? e : new ProviderStreamError(e instanceof Error ? e.message : String(e));
    }
    if (next.done) return;
    yield next.value;
  }
}
// How many listed batches a crash recovery reads at most. The list's order isn't relied on: every batch read is
// filtered by its creation time.
export const LIST_SCAN_LIMIT = 2_000;

export const requestBody = (r: PacketBatchRequest) => { const c = r.contract ?? PACKET_PROMPT_VERSION; return { custom_id: r.customId, params: packetRequestParams(PACKET_PROMPTS[c].format(r.packet), r.packet.pairs.length, c) }; };
// The bytes a request adds to a batch's body, for the 256 MB limit.
export const requestBytes = (r: PacketBatchRequest) => Buffer.byteLength(JSON.stringify(requestBody(r))) + 1;
export const totalOf = (c: BatchCounts) => c.processing + c.succeeded + c.errored + c.canceled + c.expired;

function stateOf(b: Anthropic.Messages.MessageBatch): BatchState {
  return {
    id: b.id, status: b.processing_status, counts: { ...b.request_counts },
    createdAt: new Date(b.created_at), endedAt: b.ended_at ? new Date(b.ended_at) : null, expiresAt: b.expires_at ? new Date(b.expires_at) : null,
  };
}

export function anthropicPacketBatches(client = new Anthropic({ maxRetries: 0 })): PacketBatchProvider {
  const batches = client.messages.batches;
  return {
    async submit(requests) {
      return stateOf(await batches.create({ requests: requests.map(requestBody) }));
    },
    async retrieve(batchId) {
      return stateOf(await batches.retrieve(batchId));
    },
    async *results(batchId) {
      const batch = await batches.retrieve(batchId);
      const latencyMs = batch.ended_at ? new Date(batch.ended_at).getTime() - new Date(batch.created_at).getTime() : null;
      // Streamed line by line: a large batch's results are never held in memory at once.
      for await (const item of fromProvider(await batches.results(batchId))) {
        const r = item.result;
        if (r.type === "succeeded") {
          const text = r.message.content.find((b) => b.type === "text");
          yield { customId: item.custom_id, type: "succeeded", reply: { model: r.message.model, stopReason: r.message.stop_reason, usage: r.message.usage, text: text?.type === "text" ? text.text : null, latencyMs: latencyMs ?? 0, requestId: null } };
        } else if (r.type === "errored") {
          const e = r.error as { error?: { type?: string; message?: string }; type?: string; message?: string };
          yield { customId: item.custom_id, type: "errored", errorType: e.error?.type ?? e.type ?? "unknown", message: (e.error?.message ?? e.message ?? JSON.stringify(r.error)).slice(0, 1000) };
        } else yield { customId: item.custom_id, type: r.type };
      }
    },
    async cancel(batchId) {
      await batches.cancel(batchId);
    },
    async *list(createdAfter) {
      let read = 0;
      for await (const b of fromProvider(batches.list({ limit: 100 }))) {
        if (++read > LIST_SCAN_LIMIT) return;
        if (new Date(b.created_at) >= createdAfter) yield stateOf(b);
      }
    },
  };
}
