// The real packet adjudication client: one Messages API call per issue packet (or per pair, for the
// pairwise arm), with the strict packet reply schema as structured output. Only this file talks to
// Anthropic for packet adjudication; the evaluation takes any PacketAdjudicator, so tests and dry runs
// use the label-blind mock (eval/mockPacketModel.ts). Callers reserve each attempt's worst-case cost
// before calling, so SDK retries are off.

import Anthropic from "@anthropic-ai/sdk";
import type { AdjudicatorReply, CallOptions } from "./model";
import { maxOutputTokensFor, PACKET_EFFORT, PACKET_MODEL, PACKET_PROMPT_VERSION, PACKET_PROMPTS, type ContractId } from "./packetPrompt";

export type PacketAdjudicator = {
  model: string;
  promptVersion: string;
  effort: string;
  adjudicate(packetText: string, pairCount: number, options?: CallOptions): Promise<AdjudicatorReply>;
};

// The request body for one packet, shared by the Messages API client below and the Message Batches API client
// (packetBatch.ts), so fast and economy runs send the same model, prompt, schema, effort and output cap.
export function packetRequestParams(packetText: string, pairCount: number, version: ContractId = PACKET_PROMPT_VERSION) {
  const prompt = PACKET_PROMPTS[version];
  return {
    model: PACKET_MODEL,
    max_tokens: maxOutputTokensFor(pairCount),
    system: [{ type: "text" as const, text: prompt.system, cache_control: { type: "ephemeral" as const } }],
    output_config: { effort: PACKET_EFFORT, format: { type: "json_schema" as const, schema: prompt.jsonSchema } },
    messages: [{ role: "user" as const, content: packetText }],
  };
}

// version selects the contract (packet-v1 by default, unchanged; packet-v2 for Milestone 2.5).
export function anthropicPacketAdjudicator(client = new Anthropic({ maxRetries: 0 }), version: ContractId = PACKET_PROMPT_VERSION): PacketAdjudicator {
  return {
    model: PACKET_MODEL,
    promptVersion: version,
    effort: PACKET_EFFORT,
    async adjudicate(packetText, pairCount, options) {
      const started = performance.now();
      // Streamed: a large max_tokens on a plain request would hit HTTP timeouts. finalMessage() resolves with
      // the whole message, or rejects with the same typed errors as a plain request.
      const stream = client.messages.stream(packetRequestParams(packetText, pairCount, version), { signal: options?.signal });
      const response = await stream.finalMessage();
      const latencyMs = Math.round(performance.now() - started);
      const text = response.content.find((b) => b.type === "text");
      return { model: response.model, stopReason: response.stop_reason, usage: response.usage, text: text?.type === "text" ? text.text : null, latencyMs, requestId: stream.request_id ?? null };
    },
  };
}
