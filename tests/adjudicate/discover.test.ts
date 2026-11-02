// Direct discovery's pure parts: the locked prompt, and telling outcomes apart.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyDiscovery, DISCOVERY_SYSTEM, discoveryUserPrompt, fitsContext, inputTokensBound, readDiscoveryOutput, type DiscoveryResult } from "../../server/src/adjudicate";

const message = (stop_reason: string, text: string | null, extra = {}): DiscoveryResult => ({ type: "succeeded", message: { model: "claude-fable-5-1", stop_reason, content: text === null ? [] : [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 5 }, ...extra } as never });
const EMPTY = JSON.stringify({ summary: { completion_status: "complete", limitations: [] }, findings: [] });
const R = "experiments/multimodel-contradictions/prompts/";
const session = { description: "session of 2022-06-20", lines: [{ page: 6, line: 6, text: "the cab" }] };

describe("the discovery prompt", () => {
  it("is the prompt of the November 1 Fable run, word for word", () => {
    expect(DISCOVERY_SYSTEM).toBe(readFileSync(`${R}system.md`, "utf8") + readFileSync(`${R}read-fully.md`, "utf8"));
    expect(createHash("sha256").update(DISCOVERY_SYSTEM).digest("hex")).toBe("12bf630c0f5d606b2b26a4369b4a13a67dec7c0fecfd36f82e7f541a15bd5110");
  });

  it("carries every line with its page:line, and fills every slot", () => {
    const user = discoveryUserPrompt("W", session, { ...session, description: "session of 2022-09-15" });
    expect(user).toContain("6:06 the cab");
    expect(user).toContain('description="session of 2022-09-15"');
    expect(user).not.toContain("{{");
  });

  it("carries no hint of a known answer", () => {
    expect(`${DISCOVERY_SYSTEM}${discoveryUserPrompt("W", session, session)}`).not.toMatch(/limo|\bSUV\b|beast|errata/i);
  });

  it("refuses testimony that might not fit, rather than cutting it", () => {
    expect(fitsContext(inputTokensBound("x".repeat(100)))).toBe(true);
    expect(fitsContext(inputTokensBound("x".repeat(1_000_000)))).toBe(false);
  });
});

describe("telling outcomes apart", () => {
  it("reads a valid empty answer as a success, never a refusal", () => {
    expect(classifyDiscovery(message("end_turn", EMPTY))).toMatchObject({ status: "succeeded", output: { findings: [] } });
  });

  it("reads only an explicit refusal as a refusal, keeping its category", () => {
    expect(classifyDiscovery(message("refusal", null, { stop_details: { category: "reasoning_extraction", explanation: "blocked" } }))).toMatchObject({ status: "refused", category: "reasoning_extraction", detail: "blocked" });
  });

  it("separates cut-off output from invalid output and provider failures", () => {
    expect(classifyDiscovery(message("max_tokens", null)).status).toBe("incomplete");
    expect(classifyDiscovery(message("end_turn", "not json")).status).toBe("invalid_output");
    expect(classifyDiscovery(message("end_turn", JSON.stringify({ findings: [] }))).status).toBe("invalid_output");
    expect(classifyDiscovery({ type: "errored", error: "overloaded" }).status).toBe("provider_failed");
    expect(classifyDiscovery({ type: "expired" }).status).toBe("expired");
    expect(classifyDiscovery({ type: "canceled" }).status).toBe("cancelled");
    expect(classifyDiscovery({ type: "missing" }).status).toBe("provider_failed");
  });

  it("rejects a confidence number in a finding", () => {
    const f = { finding_id: "1", witness: "w", session_a: "A", citation_a: "1:1", exact_excerpt_a: "x", session_b: "B", citation_b: "2:2", exact_excerpt_b: "y", shared_subject: "s", comparable: "yes", classification: "compatible", factual_proposition_a: "a", factual_proposition_b: "b", conflict_basis: "c", explanation: "e", alternative_explanation: "", missing_context: "", confidence_rationale: "r" };
    expect(readDiscoveryOutput(JSON.stringify({ summary: { completion_status: "complete", limitations: [] }, findings: [f] })).output).not.toBeNull();
    expect(readDiscoveryOutput(JSON.stringify({ summary: { completion_status: "complete", limitations: [] }, findings: [{ ...f, confidence: 0.9 }] })).output).toBeNull();
  });
});
