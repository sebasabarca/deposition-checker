// The economy adapter (adjudicate/packetBatch.ts) through the real Anthropic SDK, against a local fake of the
// Message Batches HTTP API (no network, no key): what it sends, how it reads asynchronous completion, results in
// any order with every result type, usage, cancellation, listing without relying on its order, and a results
// stream that drops mid-way.
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { anthropicPacketBatches, ProviderStreamError, requestBody } from "../../server/src/adjudicate/packetBatch";
import type { IssuePacket } from "../../server/src/adjudicate/packetPrompt";
import { callCost, tokensFromUsage } from "../../server/src/costs";

const passage = (id: string, depositionId: number, page: number, answer: string): IssuePacket["passages"][number] => ({
  key: `doc${depositionId}#1-2`, id, depositionId, groupId: 1, witnessId: 1, witnessName: "W", session: `s${depositionId}`, takenOn: null, partIds: [1], wholeExchange: true,
  lines: [{ id: page * 10, page, line: 4, text: "Q. Was it red?", role: "question" }, { id: page * 10 + 1, page, line: 5, text: answer, role: "answer" }],
  before: [], after: [], gapBefore: false, gapAfter: false,
});
const packet = (id: string): IssuePacket => ({ id, passages: [passage("E1", 1, 3, "A. Yes."), passage("E2", 2, 9, "A. No, blue.")], pairs: [{ pairId: "P1", a: "E1", b: "E2" }] });

const usage = { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 3518, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 3518, ephemeral_1h_input_tokens: 0 }, server_tool_use: null, service_tier: "batch" };
const batchJson = (id: string, status: "in_progress" | "canceling" | "ended", created: string, counts: Record<string, number>) => ({
  id, type: "message_batch", processing_status: status, created_at: created, ended_at: status === "ended" ? "2026-11-04T10:30:00Z" : null, expires_at: "2026-11-05T10:00:00Z",
  cancel_initiated_at: null, archived_at: null, results_url: status === "ended" ? `https://api.anthropic.com/v1/messages/batches/${id}/results` : null,
  request_counts: { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0, ...counts },
});

function fakeApi({ dropResultsAfter }: { dropResultsAfter?: number } = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let status: "in_progress" | "canceling" | "ended" = "in_progress";
  const results = [
    { custom_id: "cr1-e3-cccccccccccc", result: { type: "expired" } },
    { custom_id: "cr1-e1-aaaaaaaaaaaa", result: { type: "succeeded", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: '{"verdicts":[]}' }], stop_reason: "end_turn", stop_sequence: null, usage } } },
    { custom_id: "cr1-e4-dddddddddddd", result: { type: "canceled" } },
    { custom_id: "cr1-e2-bbbbbbbbbbbb", result: { type: "errored", error: { type: "error", error: { type: "invalid_request_error", message: "bad" } } } },
  ];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname + url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json", "request-id": "req_1" } });
    if (method === "POST" && url.pathname === "/v1/messages/batches") return json(batchJson("msgbatch_1", "in_progress", "2026-11-04T10:00:00Z", { processing: 4 }));
    if (method === "POST" && url.pathname.endsWith("/cancel")) { status = "canceling"; return json(batchJson("msgbatch_1", "canceling", "2026-11-04T10:00:00Z", { processing: 4 })); }
    if (url.pathname === "/v1/messages/batches/msgbatch_1") return json(batchJson("msgbatch_1", status, "2026-11-04T10:00:00Z", status === "ended" ? { succeeded: 1, errored: 1, canceled: 1, expired: 1 } : { processing: 4 }));
    if (url.pathname === "/v1/messages/batches/msgbatch_1/results") {
      const lines = results.map((r) => JSON.stringify(r) + "\n");
      if (dropResultsAfter === undefined) return new Response(lines.join(""), { status: 200, headers: { "content-type": "application/binary" } });
      let sent = 0;
      const body = new ReadableStream({
        // One line per read, then the connection drops (an error discards anything still queued, so pull-based).
        pull(c) {
          if (sent < dropResultsAfter) c.enqueue(new TextEncoder().encode(lines[sent++]));
          else c.error(new TypeError("terminated"));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/binary" } });
    }
    if (url.pathname === "/v1/messages/batches" && method === "GET") {
      // Not newest first: the adapter must not rely on the order.
      const data = [batchJson("msgbatch_old", "ended", "2026-11-01T00:00:00Z", { succeeded: 4 }), batchJson("msgbatch_1", status, "2026-11-04T10:00:00Z", { processing: 4 }), batchJson("msgbatch_2", "in_progress", "2026-11-04T11:00:00Z", { processing: 2 })];
      return json({ data, has_more: false, first_id: "msgbatch_old", last_id: "msgbatch_2" });
    }
    return new Response(JSON.stringify({ type: "error", error: { type: "not_found_error", message: url.pathname } }), { status: 404, headers: { "content-type": "application/json" } });
  };
  const client = new Anthropic({ apiKey: "test-key-not-real", fetch: fetch as typeof globalThis.fetch, maxRetries: 0 });
  return { client, calls, end: () => { status = "ended"; } };
}

describe("economy adapter through the Anthropic SDK", () => {
  it("submits the standard request bodies and reads the batch as still processing", async () => {
    const api = fakeApi();
    const provider = anthropicPacketBatches(api.client);
    const requests = [{ customId: "cr1-e1-aaaaaaaaaaaa", packet: packet("pk-1") }, { customId: "cr1-e2-bbbbbbbbbbbb", packet: packet("pk-2") }];
    const state = await provider.submit(requests);
    expect(state).toMatchObject({ id: "msgbatch_1", status: "in_progress", counts: { processing: 4 } });
    expect(api.calls[0]).toMatchObject({ method: "POST", path: "/v1/messages/batches" });
    expect(api.calls[0].body).toEqual({ requests: requests.map(requestBody) });
    expect((await provider.retrieve("msgbatch_1")).endedAt).toBeNull();
  });

  it("reads every result type in the order the provider sends them, with usage priced at batch rates", async () => {
    const api = fakeApi();
    const provider = anthropicPacketBatches(api.client);
    api.end();
    const out = [];
    for await (const r of provider.results("msgbatch_1")) out.push(r);
    expect(out.map((r) => [r.customId, r.type])).toEqual([
      ["cr1-e3-cccccccccccc", "expired"], ["cr1-e1-aaaaaaaaaaaa", "succeeded"], ["cr1-e4-dddddddddddd", "canceled"], ["cr1-e2-bbbbbbbbbbbb", "errored"],
    ]);
    const ok = out[1];
    if (ok.type !== "succeeded") throw new Error("expected a reply");
    expect(ok.reply).toMatchObject({ model: "claude-sonnet-5-5", stopReason: "end_turn", text: '{"verdicts":[]}', latencyMs: 30 * 60_000 });
    const tokens = tokensFromUsage(ok.reply.usage);
    expect(tokens).toEqual({ input: 1200, output: 300, cacheWrite5m: 3518, cacheWrite1h: 0, cacheRead: 0 });
    expect(callCost("claude-sonnet-5-5", tokens, { batch: true })!.costUsd).toBeCloseTo((1200 * 2 + 3518 * 2.5 + 300 * 10) / 1e6 / 2, 8);
    const err = out[3];
    expect(err.type === "errored" && err.errorType).toBe("invalid_request_error");
  });

  it("cancels through the cancel endpoint and lists batches by creation time whatever their order", async () => {
    const api = fakeApi();
    const provider = anthropicPacketBatches(api.client);
    await provider.cancel("msgbatch_1");
    expect(api.calls.at(-1)).toMatchObject({ method: "POST", path: "/v1/messages/batches/msgbatch_1/cancel" });
    expect((await provider.retrieve("msgbatch_1")).status).toBe("canceling");
    const listed = [];
    for await (const b of provider.list(new Date("2026-11-04T09:58:00Z"))) listed.push(b.id);
    expect(listed.sort()).toEqual(["msgbatch_1", "msgbatch_2"]);
  });

  it("reports a results stream that drops mid-way as a provider failure, not ours", async () => {
    const api = fakeApi({ dropResultsAfter: 2 });
    const provider = anthropicPacketBatches(api.client);
    api.end();
    const seen: string[] = [];
    await expect((async () => { for await (const r of provider.results("msgbatch_1")) seen.push(r.customId); })()).rejects.toBeInstanceOf(ProviderStreamError);
    expect(seen).toHaveLength(2);
  });
});
