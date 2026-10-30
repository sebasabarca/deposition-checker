// The real adjudication model: one Messages API call per packet, with structured output. Only this
// file talks to Anthropic for adjudication; the pipeline takes any Adjudicator, so tests use a fake.

import Anthropic from "@anthropic-ai/sdk";
import { BATCH_JSON_SCHEMA, BATCH_SYSTEM_PROMPT } from "./batch";
import { ADJUDICATION_MODEL, DEFAULT_EFFORT, DEFAULT_PROMPT_VERSION, MAX_OUTPUT_TOKENS, PROMPTS, type Effort, type PromptVersion } from "./prompt";

export type AdjudicatorReply = {
  model: string; // as the response reports it
  stopReason: string | null;
  usage: Anthropic.Usage;
  text: string | null; // the structured output's JSON, when there is one
  latencyMs: number;
  requestId?: string | null; // the API's ID for this request
};

export type CallOptions = { signal?: AbortSignal };

export type Adjudicator = {
  model: string;
  effort: Effort;
  promptVersion: PromptVersion;
  adjudicate(packetText: string, options?: CallOptions): Promise<AdjudicatorReply>;
};

// Several candidates in one request (batch.ts). maxOutputTokens is sized to the batch.
export type BatchAdjudicator = {
  model: string;
  effort: Effort;
  promptChars: number; // the system prompt and schema, for the input bound
  adjudicate(batchText: string, maxOutputTokens: number, options?: CallOptions): Promise<AdjudicatorReply>;
};

// Automatic SDK retries are off: every attempt must reserve its own cost from the budget first.
export function anthropicAdjudicator(effort: Effort = DEFAULT_EFFORT, promptVersion: PromptVersion = DEFAULT_PROMPT_VERSION, client = new Anthropic({ maxRetries: 0 })): Adjudicator {
  const prompt = PROMPTS[promptVersion];
  return {
    model: ADJUDICATION_MODEL,
    effort,
    promptVersion,
    async adjudicate(packetText, options) {
      const started = performance.now();
      const response = await client.messages.create(
        {
          model: ADJUDICATION_MODEL,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: [{ type: "text", text: prompt.system, cache_control: { type: "ephemeral" } }],
          // Sonnet 5.5 thinks adaptively by default; effort sets how much (its default is high).
          output_config: { effort, format: { type: "json_schema", schema: prompt.jsonSchema } },
          messages: [{ role: "user", content: packetText }],
        },
        { signal: options?.signal },
      );
      const latencyMs = Math.round(performance.now() - started);
      const text = response.content.find((b) => b.type === "text");
      return { model: response.model, stopReason: response.stop_reason, usage: response.usage, text: text?.type === "text" ? text.text : null, latencyMs, requestId: response._request_id ?? null };
    },
  };
}

// Streams, because a long response would otherwise be refused as too slow for a plain request.
export function anthropicBatchAdjudicator(effort: Effort = DEFAULT_EFFORT, client = new Anthropic({ maxRetries: 0 })): BatchAdjudicator {
  return {
    model: ADJUDICATION_MODEL,
    effort,
    promptChars: BATCH_SYSTEM_PROMPT.length + JSON.stringify(BATCH_JSON_SCHEMA).length,
    async adjudicate(batchText, maxOutputTokens, options) {
      const started = performance.now();
      const stream = client.messages.stream(
        {
          model: ADJUDICATION_MODEL,
          max_tokens: maxOutputTokens,
          system: [{ type: "text", text: BATCH_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          output_config: { effort, format: { type: "json_schema", schema: BATCH_JSON_SCHEMA } },
          messages: [{ role: "user", content: batchText }],
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
