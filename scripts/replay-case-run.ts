// A whole-case run whose model replies are RECORDED REAL CALLS, replayed through production code (no model call).
// For demonstrations and checks on disposable databases only.
//
//   npx tsx scripts/replay-case-run.ts --db <_rehearsal_ db> --case <id> --contract stretch-v2|packet-v1 --replies <runs dir>
//
// 1. Creates a live case run with the contract and runs production retrieval: an unconfirmed live run stops at
//    awaiting_confirmation before any request (the adjudicator here throws if called).
// 2. For each ledger entry, rebuilds its request exactly as the run would send it (entryContext, nextStep), and only
//    when that text is byte-identical to a request of the given accuracy-eval run directory, takes that request's
//    recorded reply and its llm_calls row (the real call, matched by its stored raw output), reserves and settles
//    the call's real cost on the run's budget, records the adjudication request, and parses, verifies and persists
//    the reply with applyReply (the path a resumed run takes for a stored reply).
// 3. Every other entry is left unread, and the run ends `incomplete` with a note saying how many requests were
//    replayed and that nothing else was sent. Nothing is invented: no entry gets a reply that was not recorded for
//    exactly its text.

import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { PACKET_EFFORT, PACKET_MODEL, PACKET_PROMPTS, maxOutputTokensFor } from "../server/src/adjudicate/packetPrompt";
import { openRequest, closeRequest } from "../server/src/adjudicate/requests";
import { reserve, settle } from "../server/src/costs";
import { connect } from "../server/src/db/client";
import { caseRuns, llmCalls, screeningEntries, screeningRuns, witnesses } from "../server/src/db/schema";
import { applyReply, caseRunSetOf, createCaseRun, entryContext, finish, nextStep, runCaseRun } from "../server/src/jobs/caseRun";

const sha = (x: string) => createHash("sha256").update(x).digest("hex");
const jl = (f: string) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

async function main() {
  const { values } = parseArgs({ options: { db: { type: "string" }, case: { type: "string" }, contract: { type: "string", default: "stretch-v2" }, replies: { type: "string" } } });
  if (!values.db || !/_rehearsal_|_test$/.test(values.db)) throw new Error("--db must name a disposable database");
  const contract = values.contract as "stretch-v2" | "packet-v1";
  const recorded = jl(path.join(values.replies!, "replies.jsonl")).filter((r: { round: number; text: string | null }) => r.round === 0 && r.text !== null) as { id: string; text: string }[];
  const frozen = new Map((jl("data/raw/accuracy-eval/frozen/requests.jsonl") as { id: string; contract: string; textSha256: string }[]).filter((r) => r.contract === contract).map((r) => [r.textSha256, r.id]));
  const replyOf = new Map<string, string>(); // request text SHA-256 -> recorded reply text
  for (const [s, id] of frozen) { const r = recorded.find((x) => x.id === id); if (r) replyOf.set(s, r.text); }

  const u = new URL(process.env.DATABASE_URL!); u.pathname = `/${values.db}`;
  const { db, pool } = connect(u.toString(), { max: 4 });
  try {
    const run0 = await createCaseRun(db, Number(values.case), { mode: "live", budgetUsd: 1, confirmed: false, contract });
    const never = () => { throw new Error("replay: no model call is made"); };
    const status = await runCaseRun(db, pool, run0.id, { adjudicator: () => ({ model: PACKET_MODEL, promptVersion: contract, effort: PACKET_EFFORT, adjudicate: never }), minilm: "off" });
    if (status !== "awaiting_confirmation") throw new Error(`retrieval ended ${status}`);
    const [run] = await db.select().from(caseRuns).where(eq(caseRuns.id, run0.id));
    const [ledger] = await db.select().from(screeningRuns).where(eq(screeningRuns.caseRunId, run.id));
    const index = (ledger.settings as { itemIndex: Parameters<typeof entryContext>[2] }).itemIndex;
    const names = new Map((await db.select({ id: witnesses.id, name: witnesses.name }).from(witnesses)).map((w) => [w.id, w.name]));
    const entries = await db.select().from(screeningEntries).where(eq(screeningEntries.runId, ledger.id));
    let replayed = 0, usd = 0;
    for (const entry of entries) {
      const ctx = await entryContext(db, entry, index, names, { allItems: contract === "stretch-v2" });
      if (typeof ctx === "string") continue;
      const step = await nextStep(db, run, { entry }, ctx);
      if (step.kind !== "send") continue;
      const text = PACKET_PROMPTS[contract].format(step.packet);
      const reply = replyOf.get(sha(text));
      if (reply === undefined) continue;
      const [call] = await db.select({ id: llmCalls.id, costUsd: llmCalls.costUsd, model: llmCalls.model }).from(llmCalls).where(eq(llmCalls.rawOutput, reply));
      if (!call) throw new Error(`entry ${entry.packetId}: no llm_calls row holds its recorded reply`);
      const cost = Number(call.costUsd);
      const reservationId = await reserve(db, run.budgetId!, cost, `${caseRunSetOf(run.id)} ${entry.packetId} (replay of llm_calls ${call.id})`);
      await settle(db, reservationId, { id: call.id, costUsd: cost });
      const requestId = await openRequest(db, { candidateSet: caseRunSetOf(run.id), analysisId: null, strategy: "packet", maxConcurrency: 1 }, { candidateIds: step.sentIds, model: PACKET_MODEL, promptVersion: contract, estimatedInputTokens: Math.ceil(text.length / 2.4), maxOutputTokens: maxOutputTokensFor(step.packet.pairs.length), maxCostUsd: cost, reservationId });
      await closeRequest(db, requestId, { status: "completed", llmCallId: call.id });
      await db.update(screeningEntries).set({ attempts: 1, requestId, llmCallId: call.id }).where(eq(screeningEntries.id, entry.id));
      const after = await applyReply(db, run, { ...entry, requestId, llmCallId: call.id }, step.packet, step.sentIds, { text: reply, callId: call.id, requestId }, { model: call.model, promptVersion: contract, effort: PACKET_EFFORT });
      await db.update(screeningEntries).set({ llmCallId: null }).where(eq(screeningEntries.id, after.id));
      // The production loop's next round marks the entry adjudicated once every pair has a verdict (or lists the rest).
      const done = await nextStep(db, run, { entry: { ...after, llmCallId: null } }, ctx);
      if (done.kind !== "done") await db.update(screeningEntries).set({ adjudicationStatus: "incomplete", adjudicationNote: "replay: pairs without a recorded answer" }).where(eq(screeningEntries.id, entry.id));
      replayed++;
      usd += cost;
    }
    const total = entries.length;
    await finish(db, run.id, ledger.id, "incomplete", `Replay for demonstration: ${replayed} of ${total} requests were answered by recorded real calls to Veridict's model (November 5, 2026; $${usd.toFixed(4)}), re-read through production verification. The other ${total - replayed} were never sent; their pairs are unread, not compatible.`);
    console.log(JSON.stringify({ caseRun: run.id, requests: total, replayed, recordedCostUsd: +usd.toFixed(4) }));
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
