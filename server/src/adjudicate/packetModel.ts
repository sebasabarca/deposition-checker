// The real packet adjudication client: one Messages API call per issue packet (or per pair, for the
// pairwise arm), with the strict packet reply schema as structured output. Only this file talks to
// Anthropic for packet adjudication; the evaluation takes any PacketAdjudicator, so tests and dry runs
// use the label-blind mock (eval/mockPacketModel.ts). Callers reserve each attempt's worst-case cost
// before calling, so SDK retries are off.

import Anthropic from "@anthropic-ai/sdk";
import type { AdjudicatorReply, CallOptions } from "./model";
import { maxOutputTokensFor, PACKET_EFFORT, PACKET_MODEL, PACKET_PROMPT_VERSION, PACKET_PROMPTS, type PromptVersionId } from "./packetPrompt";

export type PacketAdjudicator = {
  model: string;
  promptVersion: string;
  effort: string;
  adjudicate(packetText: string, pairCount: number, options?: CallOptions): Promise<AdjudicatorReply>;
};

// version selects the contract (packet-v1 by default, unchanged; packet-v2 for Milestone 2.5).
export function anthropicPacketAdjudicator(client = new Anthropic({ maxRetries: 0 }), version: PromptVersionId = PACKET_PROMPT_VERSION): PacketAdjudicator {
  const prompt = PACKET_PROMPTS[version];
  return {
    model: PACKET_MODEL,
    promptVersion: version,
    effort: PACKET_EFFORT,
    async adjudicate(packetText, pairCount, options) {
      const started = performance.now();
      // Streamed: a large max_tokens on a plain request would hit HTTP timeouts. finalMessage() resolves with
      // the whole message, or rejects with the same typed errors as a plain request.
      const stream = client.messages.stream(
        {
          model: PACKET_MODEL,
          max_tokens: maxOutputTokensFor(pairCount),
          system: [{ type: "text", text: prompt.system, cache_control: { type: "ephemeral" } }],
          output_config: { effort: PACKET_EFFORT, format: { type: "json_schema", schema: prompt.jsonSchema } },
          messages: [{ role: "user", content: packetText }],
        },
        { signal: options?.signal },
      );
      const response = await stream.finalMessage();
      const latencyMs = Math.round(performance.now() - started);
      const text = response.content.find((b) => b.type === "text");
      return { model: response.model, stopReason: response.stop_reason, usage: response.usage, text: text?.type === "text" ? text.text : null, latencyMs, requestId: stream.request_id ?? null };
    },
  };
}
