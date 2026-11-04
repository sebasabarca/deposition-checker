// The batch request body is the standard request body (same model, prompt, schema, effort and output cap), and
// the economy settings refuse values past the provider's limits.
import { describe, expect, it } from "vitest";
import { CUSTOM_ID, requestBody, requestBytes } from "../../server/src/adjudicate/packetBatch";
import { packetRequestParams } from "../../server/src/adjudicate/packetModel";
import { formatIssuePacket, maxOutputTokensFor, PACKET_EFFORT, PACKET_MODEL, type IssuePacket } from "../../server/src/adjudicate/packetPrompt";
import { BATCH_DEFAULTS, batchSettings } from "../../server/src/jobs/caseRunBatch";

const passage = (id: string, depositionId: number, page: number, answer: string): IssuePacket["passages"][number] => ({
  key: `doc${depositionId}#1-2`, id, depositionId, groupId: 1, witnessId: 1, witnessName: "W", session: `s${depositionId}`, takenOn: null, partIds: [1], wholeExchange: true,
  lines: [{ id: page * 10, page, line: 4, text: "Q. Was it red?", role: "question" }, { id: page * 10 + 1, page, line: 5, text: answer, role: "answer" }],
  before: [], after: [], gapBefore: false, gapAfter: false,
});
const packet: IssuePacket = { id: "pk-1", passages: [passage("E1", 1, 3, "A. Yes."), passage("E2", 2, 9, "A. No, blue.")], pairs: [{ pairId: "P1", a: "E1", b: "E2" }] };

describe("economy request body", () => {
  it("is exactly the standard request's parameters, with a valid custom_id", () => {
    const body = requestBody({ customId: "cr12-e345-0123456789ab", packet });
    expect(body.params).toEqual(packetRequestParams(formatIssuePacket(packet), 1));
    expect(body.params).toMatchObject({ model: PACKET_MODEL, max_tokens: maxOutputTokensFor(1), output_config: { effort: PACKET_EFFORT } });
    expect(body.custom_id).toMatch(CUSTOM_ID);
    expect(`cr${Number.MAX_SAFE_INTEGER}-e${Number.MAX_SAFE_INTEGER}-0123456789ab`).toMatch(CUSTOM_ID); // the longest the engine makes
    expect(requestBytes({ customId: "x", packet })).toBe(Buffer.byteLength(JSON.stringify(requestBody({ customId: "x", packet }))) + 1);
  });

  it("reads its settings from the environment within the provider's limits", () => {
    expect(batchSettings({})).toEqual(BATCH_DEFAULTS);
    expect(batchSettings({ CASE_RUN_BATCH_SIZE: "250", CASE_RUN_BATCHES_IN_FLIGHT: "2", CASE_RUN_BATCH_POLL_SECONDS: "30", CASE_RUN_BATCH_MAX_MB: "64" })).toMatchObject({ batchSize: 250, inFlight: 2, pollSeconds: 30, maxBytes: 64 * 1024 * 1024 });
    expect(() => batchSettings({ CASE_RUN_BATCH_SIZE: "100001" })).toThrow(/CASE_RUN_BATCH_SIZE/);
    expect(() => batchSettings({ CASE_RUN_BATCH_MAX_MB: "256" })).toThrow(/CASE_RUN_BATCH_MAX_MB/);
    expect(() => batchSettings({ CASE_RUN_BATCHES_IN_FLIGHT: "0" })).toThrow();
  });
});
