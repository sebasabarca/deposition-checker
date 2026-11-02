// The Sol arm's request and response handling, with hand-built replies. No network.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { finalEvent, openaiBody, replyOfOpenAI } from "../../experiments/multimodel-contradictions/src/providers";
import { parseOutput } from "../../experiments/multimodel-contradictions/src/schemas";

const { arms } = JSON.parse(readFileSync("experiments/multimodel-contradictions/config/arms.json", "utf8"));
const usage = { input_tokens: 100, output_tokens: 50, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 30 } };
const message = (content: unknown[]) => [{ type: "reasoning" }, { type: "message", content }];

describe("OpenAI arm", () => {
  it("uses the same prompt addition as Fable, doesn't store, and enforces the schema", () => {
    expect(arms.S.systemExtra).toBe(arms.F.systemExtra);
    const body = openaiBody(arms.S, { system: "s", user: "u", maxTokens: 10 });
    expect(body).toMatchObject({ model: "gpt-6.1-sol", instructions: "s", input: "u", store: false, stream: true, max_output_tokens: 10, reasoning: { effort: "xhigh" } });
    expect(body.text.format).toMatchObject({ type: "json_schema", strict: true });
    expect(body.text.format.schema).toMatchObject({ additionalProperties: false, required: ["summary", "findings"] });
  });

  it("reads a finished answer and separates cached input", () => {
    const text = JSON.stringify({ summary: { completion_status: "complete", limitations: [] }, findings: [] });
    const reply = replyOfOpenAI({ model: "gpt-6.1-sol", status: "completed", output: message([{ type: "output_text", text }]), usage } as never);
    expect(reply.usage).toEqual({ input: 60, output: 50, cacheRead: 40, cacheWrite: 0 });
    expect(parseOutput(reply.text).error).toBeNull();
  });

  it("returns no text for a refusal or a cut-off answer", () => {
    expect(replyOfOpenAI({ status: "completed", output: message([{ type: "refusal", refusal: "no" }]) } as never)).toMatchObject({ text: null, stopReason: "refusal" });
    expect(replyOfOpenAI({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: message([{ type: "output_text", text: "{" }]) } as never)).toMatchObject({ text: null, stopReason: "max_output_tokens" });
  });

  it("finds the final event in a stream, or none", () => {
    const sse = `event: response.created\ndata: {"type":"response.created","response":{"status":"in_progress"}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n`;
    expect(finalEvent(sse)?.status).toBe("completed");
    expect(finalEvent('data: {"type":"response.created","response":{}}\n')).toBeNull();
  });
});
