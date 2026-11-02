// Provider adapters. Only this file knows a provider's request shape. One attempt each: retries and
// fallbacks are off, so a failed call is a recorded failure. Only run.ts calls these, after the gate.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { ROOT } from "./data";
import type { ArmConfig } from "./estimate";
import { RUN_OUTPUT_JSON_SCHEMA } from "./schemas";

export type Reply = { raw?: unknown; rateLimitHeaders?: Record<string, string>; text: string | null; stopReason: string | null; modelReported: string | null; usage: { input: number; output: number; cacheRead: number; cacheWrite: number }; schemaEnforced: boolean };
export type Request = { system: string; user: string; maxTokens: number; schema?: Record<string, unknown> };
export type Adapter = (req: Request) => Promise<Reply>;

// One request shape for streaming and batch, so a batch arm differs only in its model and price.
export const anthropicParams = (arm: ArmConfig, { system, user, maxTokens, schema = RUN_OUTPUT_JSON_SCHEMA }: Request) => ({
  model: arm.model!, max_tokens: maxTokens,
  system: [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }],
  output_config: { effort: (arm.effort ?? "medium") as "low" | "medium" | "xhigh" | "max", format: { type: "json_schema" as const, schema } },
  ...(arm.thinking ? { thinking: { type: "adaptive" as const, display: "summarized" as const } } : {}),
  messages: [{ role: "user" as const, content: user }],
});

export const replyOf = (message: Anthropic.Message, rateLimitHeaders?: Record<string, string>): Reply => {
  const block = message.content.find((b) => b.type === "text");
  return { raw: message, rateLimitHeaders, text: block?.type === "text" ? block.text : null, stopReason: message.stop_reason, modelReported: message.model, schemaEnforced: true, usage: { input: message.usage.input_tokens, output: message.usage.output_tokens, cacheRead: message.usage.cache_read_input_tokens ?? 0, cacheWrite: message.usage.cache_creation_input_tokens ?? 0 } };
};

const anthropic = (arm: ArmConfig): Adapter => async (req) => {
  const stream = new Anthropic({ maxRetries: 0 }).messages.stream(anthropicParams(arm, req));
  const { response } = await stream.withResponse();
  const message = await stream.finalMessage();
  return replyOf(message, Object.fromEntries([...response.headers.entries()].filter(([k]) => k.startsWith("anthropic-ratelimit-"))));
};

export const batches = () => new Anthropic({ maxRetries: 0 }).messages.batches; // one attempt: a failed item is recorded, never resubmitted

// Official OpenAI-compatible endpoint. JSON mode guarantees JSON, not this schema: run.ts validates it.
const deepseek = (arm: ArmConfig): Adapter => async ({ system, user, maxTokens }) => {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("DEEPSEEK_API_KEY is not set.");
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: arm.model, max_tokens: maxTokens, stream: false, response_format: { type: "json_object" }, messages: [{ role: "system", content: `${system}\n\nThe required JSON schema:\n${JSON.stringify(RUN_OUTPUT_JSON_SCHEMA)}` }, { role: "user", content: user }] }),
  });
  if (!response.ok) throw new Error(`DeepSeek returned HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`);
  const body = (await response.json()) as { model?: string; choices?: { finish_reason?: string; message?: { content?: string } }[]; usage?: { prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; completion_tokens?: number } };
  const choice = body.choices?.[0];
  // Blank content is DeepSeek's documented signal that its output wasn't valid JSON.
  return { raw: body, text: choice?.message?.content?.trim() || null, stopReason: choice?.finish_reason ?? null, modelReported: body.model ?? null, schemaEnforced: false, usage: { input: body.usage?.prompt_cache_miss_tokens ?? 0, output: body.usage?.completion_tokens ?? 0, cacheRead: body.usage?.prompt_cache_hit_tokens ?? 0, cacheWrite: 0 } };
};

// OpenAI's Responses API. Structured output is strict here, and run.ts validates it again.
export const openaiBody = (arm: ArmConfig, { system, user, maxTokens, schema = RUN_OUTPUT_JSON_SCHEMA }: Request) => ({
  model: arm.model, instructions: system, input: user, max_output_tokens: maxTokens, store: false, stream: true,
  reasoning: { effort: arm.effort ?? "medium" },
  text: { format: { type: "json_schema", name: "run_output", strict: true, schema } },
});

type OpenAIResponse = { model?: string; status?: string; incomplete_details?: { reason?: string } | null; error?: { message?: string } | null; output?: { type: string; content?: { type: string; text?: string; refusal?: string }[] }[]; usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } } };

// A refusal or a cut-off answer carries no usable text, and says why in stopReason.
export function replyOfOpenAI(body: OpenAIResponse): Reply {
  const parts = (body.output ?? []).filter((o) => o.type === "message").flatMap((o) => o.content ?? []);
  const cached = body.usage?.input_tokens_details?.cached_tokens ?? 0;
  const stopReason = parts.some((p) => p.type === "refusal") ? "refusal" : body.status === "incomplete" ? (body.incomplete_details?.reason ?? "incomplete") : (body.status ?? null);
  const text = stopReason === "completed" ? parts.filter((p) => p.type === "output_text").map((p) => p.text ?? "").join("") || null : null;
  return { raw: body, text, stopReason, modelReported: body.model ?? null, schemaEnforced: true, usage: { input: (body.usage?.input_tokens ?? 0) - cached, output: body.usage?.output_tokens ?? 0, cacheRead: cached, cacheWrite: 0 } };
}

// Streaming keeps the connection open through a long think. Only the final event is kept.
export function finalEvent(sse: string): OpenAIResponse | null {
  for (const line of sse.split("\n").reverse()) {
    if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
    const event = JSON.parse(line.slice(6)) as { type?: string; response?: OpenAIResponse };
    if (event.response && ["response.completed", "response.incomplete", "response.failed"].includes(event.type ?? "")) return event.response;
  }
  return null;
}

const openai = (arm: ArmConfig): Adapter => async (req) => {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set.");
  const response = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(openaiBody(arm, req)) });
  if (!response.ok) throw new Error(`OpenAI returned HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`);
  const final = finalEvent(await response.text());
  if (!final) throw new Error("OpenAI's stream ended with no final response.");
  return replyOfOpenAI(final);
};

// The free model only works through OpenCode, so this drives its CLI from an empty folder, with an
// agent that denies every tool. The docs don't say whether that agent's prompt replaces OpenCode's
// built-in one: confirm on the synthetic pilot and record it.
export function parseOpencodeEvents(stdout: string): Pick<Reply, "text" | "modelReported" | "stopReason" | "usage"> {
  const events = stdout.split("\n").filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l) as { type?: string; part?: { type?: string; text?: string; tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } }; reason?: string } }];
    } catch {
      return [];
    }
  });
  const text = events.filter((e) => e.part?.type === "text").map((e) => e.part!.text ?? "").join("") || null;
  const finish = events.filter((e) => e.part?.tokens).pop()?.part;
  return { text, stopReason: finish?.reason ?? null, modelReported: null, usage: { input: finish?.tokens?.input ?? 0, output: finish?.tokens?.output ?? 0, cacheRead: finish?.tokens?.cache?.read ?? 0, cacheWrite: finish?.tokens?.cache?.write ?? 0 } };
}

const opencode = (arm: ArmConfig): Adapter => async ({ system, user, schema = RUN_OUTPUT_JSON_SCHEMA }) => {
  const dir = mkdtempSync(join(tmpdir(), "contradiction-arm-a-"));
  const file = join(dir, "prompt.txt");
  writeFileSync(file, `${system}\n\nThe required JSON schema:\n${JSON.stringify(schema)}\n\n${user}`); // the CLI has no schema option
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn("opencode", ["run", "Follow the instructions in the attached file and return only the JSON object.", "--model", arm.model!, "--agent", "contradiction-experiment", "--format", "json", "--dir", dir, "--file", file], { env: { ...process.env, OPENCODE_CONFIG: join(ROOT, "config", "opencode.json") }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`opencode exited with ${code}: ${err.slice(-500)}`))));
    });
    return { ...parseOpencodeEvents(stdout), schemaEnforced: false };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export function adapterFor(arm: ArmConfig): Adapter {
  if (arm.provider === "anthropic") return anthropic(arm);
  if (arm.provider === "deepseek") return deepseek(arm);
  if (arm.provider === "openai") return openai(arm);
  if (arm.provider === "opencode") return opencode(arm);
  throw new Error(`Arm ${arm.label} makes no calls.`);
}
