// The real extraction model: one Messages API call per batch, with structured output. Only this
// file talks to Anthropic for claims; the pipeline takes any ClaimModel, so tests use a fake one.

import Anthropic from "@anthropic-ai/sdk";
import { CLAIMS_MODEL, MAX_OUTPUT_TOKENS, SYSTEM_PROMPT } from "./prompt";
import { EXTRACTION_JSON_SCHEMA } from "./schema";

export type ModelReply = {
  stopReason: string | null;
  usage: Anthropic.Usage;
  text: string | null; // the structured output's JSON, when there is one
};

export type ClaimModel = {
  model: string;
  extract(batchText: string): Promise<ModelReply>;
};

// Automatic SDK retries are off: every attempt must reserve its own cost from the budget, so a retry
// is a new, separately reserved request made by the caller (a re-run tags failed parts again).
export function anthropicClaimModel(client = new Anthropic({ maxRetries: 0 })): ClaimModel {
  return {
    model: CLAIMS_MODEL,
    async extract(batchText) {
      const response = await client.messages.create({
        model: CLAIMS_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        // The fixed instructions are cached; only the batch changes between calls.
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        // Extraction, not reasoning: low effort keeps thinking short.
        output_config: { effort: "low", format: { type: "json_schema", schema: EXTRACTION_JSON_SCHEMA } },
        messages: [{ role: "user", content: batchText }],
      });
      const text = response.content.find((b) => b.type === "text");
      return { stopReason: response.stop_reason, usage: response.usage, text: text?.type === "text" ? text.text : null };
    },
  };
}
