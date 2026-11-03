// The real extraction models: one Messages API call per batch, with structured output. Only this
// file talks to Anthropic for cards and topics; the pipelines take any ClaimModel, so tests
// use a fake one.

import Anthropic from "@anthropic-ai/sdk";
import { CARD_MAX_OUTPUT_TOKENS, CARDS_MODEL, CARDS_SYSTEM_PROMPT } from "./cardPrompt";
import { CARDS_JSON_SCHEMA } from "./cards";
import { TOPIC_MAX_OUTPUT_TOKENS, TOPICS_JSON_SCHEMA, TOPICS_MODEL, TOPICS_SYSTEM_PROMPT } from "./topicMap";
import { FACTS_JSON_SCHEMA, FACTS_MODEL } from "./facts/contracts";
import { FACT_MAX_OUTPUT_TOKENS, FACTS_SYSTEM_PROMPT } from "./facts/prompt";

export type ModelReply = {
  stopReason: string | null;
  usage: Anthropic.Usage;
  text: string | null; // the structured output's JSON, when there is one
};

export type ClaimModel = {
  model: string;
  // schema: this request's structured-output schema, when it depends on the batch (facts: one key per unit).
  extract(batchText: string, schema?: Record<string, unknown>): Promise<ModelReply>;
};

// Automatic SDK retries are off: every attempt must reserve its own cost from the budget, so a retry
// is a new, separately reserved request made by the caller.
function structuredModel({ model, system, schema, maxTokens }: { model: string; system: string; schema: Record<string, unknown>; maxTokens: number }, client: Anthropic): ClaimModel {
  return {
    model,
    async extract(batchText, requestSchema) {
      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        // The fixed instructions are cached; only the batch changes between calls.
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        // Extraction, not reasoning: low effort keeps thinking short.
        output_config: { effort: "low", format: { type: "json_schema", schema: requestSchema ?? schema } },
        messages: [{ role: "user", content: batchText }],
      });
      const text = response.content.find((b) => b.type === "text");
      return { stopReason: response.stop_reason, usage: response.usage, text: text?.type === "text" ? text.text : null };
    },
  };
}

export const anthropicCardModel = (client = new Anthropic({ maxRetries: 0 })) => structuredModel({ model: CARDS_MODEL, system: CARDS_SYSTEM_PROMPT, schema: CARDS_JSON_SCHEMA, maxTokens: CARD_MAX_OUTPUT_TOKENS }, client);
export const anthropicTopicModel = (client = new Anthropic({ maxRetries: 0 })) => structuredModel({ model: TOPICS_MODEL, system: TOPICS_SYSTEM_PROMPT, schema: TOPICS_JSON_SCHEMA, maxTokens: TOPIC_MAX_OUTPUT_TOKENS }, client);
// Stage 2 fact extraction. Built only when paid calls are allowed; tests use a fake ClaimModel.
export const anthropicFactModel = (client = new Anthropic({ maxRetries: 0 })) => structuredModel({ model: FACTS_MODEL, system: FACTS_SYSTEM_PROMPT, schema: FACTS_JSON_SCHEMA, maxTokens: FACT_MAX_OUTPUT_TOKENS }, client);
