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
export type Request = { system: string; user: string; maxTokens: number };
export type Adapter = (req: Request) => Promise<Reply>;

const anthropic = (arm: ArmConfig): Adapter => async ({ system, user, maxTokens }) => {
  const stream = new Anthropic({ maxRetries: 0 }).messages.stream({
    model: arm.model!, max_tokens: maxTokens,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    output_config: { effort: (arm.effort ?? "medium") as "medium", format: { type: "json_schema", schema: RUN_OUTPUT_JSON_SCHEMA } },
    messages: [{ role: "user", content: user }],
  });
  const { response } = await stream.withResponse();
  const message = await stream.finalMessage();
  const rateLimitHeaders = Object.fromEntries([...response.headers.entries()].filter(([k]) => k.startsWith("anthropic-ratelimit-")));
  const block = message.content.find((b) => b.type === "text");
  return { raw: message, rateLimitHeaders, text: block?.type === "text" ? block.text : null, stopReason: message.stop_reason, modelReported: message.model, schemaEnforced: true, usage: { input: message.usage.input_tokens, output: message.usage.output_tokens, cacheRead: message.usage.cache_read_input_tokens ?? 0, cacheWrite: message.usage.cache_creation_input_tokens ?? 0 } };
};

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

const opencode = (arm: ArmConfig): Adapter => async ({ user }) => {
  const dir = mkdtempSync(join(tmpdir(), "contradiction-arm-a-"));
  const file = join(dir, "prompt.txt");
  writeFileSync(file, user);
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn("opencode", ["run", "--model", arm.model!, "--agent", "contradiction-experiment", "--format", "json", "--dir", dir, "--file", file, "Follow the instructions in the attached file and return only the JSON object."], { env: { ...process.env, OPENCODE_CONFIG: join(ROOT, "config", "opencode.json") }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`opencode exited with ${code}.`))));
    });
    return { ...parseOpencodeEvents(stdout), schemaEnforced: false };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export function adapterFor(arm: ArmConfig): Adapter {
  if (arm.provider === "anthropic") return anthropic(arm);
  if (arm.provider === "deepseek") return deepseek(arm);
  if (arm.provider === "opencode") return opencode(arm);
  throw new Error(`Arm ${arm.label} makes no calls.`);
}
