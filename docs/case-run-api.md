# Case-run API: contract for the frontend

A **case run** analyses every witness and session of a case at once. Code is in `server/src/jobs/caseRun.ts`, routes in `server/src/api/caseRuns.ts`, and the response type is `CaseRunReport` in `caseRun.ts`. The client keeps its own copy of server response types in `client/src/types.ts` (`CaseRun`, `CaseRunFinding`); the screens are `client/src/components/CaseRuns.tsx` and `client/src/pages/CaseRunPage.tsx`.

Every route is under `/api`. They sit behind the existing sign-in, `sameOrigin` and `scopeToOrg` middleware, so a run in another organization's case answers 404.

- Starting a live run or confirming one needs a verified email and paid access (`analysisAccess`): the same rule as live analyses.
- A mock run never needs paid access.
- Resuming needs paid access only when the run is live; the route checks the run's stored mode.
- Requests only read and write rows and queue a job. All work runs in the worker.

## Lifecycle

```
POST /cases/:id/case-runs {mode:"live"}
  queued → retrieving → awaiting_confirmation (estimate ready; nothing sent, nothing spent)
POST /case-runs/:id/confirm {budgetUsd, execution?, retentionAcknowledged?}
  queued → adjudicating → completed | incomplete | failed | blocked_budget | cancelled | interrupted
POST /case-runs/:id/resume {budgetUsd?, retryUncertain?}   (from incomplete, failed, blocked_*, cancelled, interrupted)
  queued → adjudicating → …
```

A mock run (`{mode:"mock"}`) skips confirmation. It goes straight to adjudication with the deterministic mock: no model, no cost, and verdicts labelled `fixture`.

### Fast and economy execution

A run reads its packets in one of two ways, chosen when it is confirmed (`execution`) and fixed from then on. A mock run chooses at start (`{mode:"mock", execution}`).

| | `standard` (Fast, the default) | `batch` (Economy) |
|---|---|---|
| Transport | Messages API, a few packets in parallel (`CASE_RUN_PACKETS_*`) | Message Batches API (`jobs/caseRunBatch.ts`), `CASE_RUN_BATCH_SIZE` requests a batch, up to `CASE_RUN_BATCHES_IN_FLIGHT` batches open |
| Price | Standard | 50% of standard on every token type ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)) |
| Time | Minutes, set by the rate limits | Set by the provider: most batches end within an hour, every batch within 24 hours |
| Same packets, prompt (`packet-v1`), model, effort, output cap, verification, scoring | Yes | Yes: both send `packetRequestParams` (`adjudicate/packetModel.ts`) |
| Budget | Each request in flight holds its worst case | Each request in a submitted batch holds its worst case at batch prices until its result is imported. A batch takes only what the remaining limit covers, so a limit near the estimate means fewer packets at once and more rounds, never more spending |
| Data retention | As configured for the account | **Not eligible for zero data retention:** the provider stores batch inputs and results for 29 days. Confirming needs `retentionAcknowledged: true` |
| After a worker restart | A request in flight is uncertain; resume continues | Nothing is lost: the next check carries on from the database |

An economy run is a series of short checks: each one imports ended batches, sends recovery requests and retries, and submits new batches, then queues the next check (`CASE_RUN_BATCH_POLL_SECONDS`, 60 by default; 2 for a mock run). Its status stays `adjudicating` while any batch is open. It never falls back to standard requests.

- **Results** are matched by `custom_id`, imported once each (a duplicate delivery is skipped), recorded in `llm_calls` with `batch = true` and their raw text before they are parsed, and settled against their reservation.
- **Errored** (not an invalid request) and **expired** requests are not billed: each is retried once in a later batch, then its packet fails unbilled. An **invalid** request is not retried. A **cancelled** request returns its packet to the queue.
- **A request with no result** in an ended batch is uncertain: its reservation is charged in full and its packet is retried only on `retryUncertain`.
- **A crash while submitting**, or a submit call that fails without proof of refusal (only 400, 401, 403, 404, 413, 422 and 429 count as refusals), leaves the batch `submitting`. The next check reads the provider's batch list. Request count and creation time only narrow the search; a listed batch is adopted only when, after it ends, its results carry exactly this batch's custom IDs (each with 48 random bits). While a possible match is still processing the row waits (a batch ends within 24 hours). With no possible match after 10 minutes, it becomes `submission_unknown`: its requests count as billed and its packets are retried only when a person resumes with `retryUncertain`, which can pay twice if the batch did exist. Nothing is ever resubmitted automatically. A test-model run (no cost) simply queues such packets again, and also re-queues batches its worker lost in a restart.
- **Paid economy is behind a flag.** Confirming with `execution: "batch"` answers 409 `{ code: "economy_disabled" }` unless the server sets `ALLOW_ECONOMY_ANALYSIS=true`, and the worker runs a paid economy run only with that flag and `ALLOW_PAID_CALLS=true` (otherwise `blocked_credentials`). Every report carries `economyAvailable`. Mock economy runs need neither.
- **The limit is Veridict's, not the provider's.** Each request reserves its worst case (input at the highest input rate, output at `max_tokens`) at batch prices before its batch is sent; results settle at the recorded cost, errored, expired and cancelled requests release, and uncertain ones are charged in full. Recorded spending therefore can't pass the limit, but Anthropic doesn't enforce it: set a workspace spend limit in the Console as well.
- **Results must be imported within 29 days** of the batch's creation, after which the provider deletes them. A run imports as soon as a batch ends; `batches.resultsExpireAt` shows the deadline of any finished batch not yet imported.

| Status | Meaning | What the UI offers |
|---|---|---|
| `queued`, `retrieving` | Working; nothing spent | Progress, Cancel |
| `awaiting_confirmation` | The estimate is in `estimate`; nothing has been sent | Confirm with a budget (default `estimate.recommendedBudgetUsd`), Cancel |
| `adjudicating` | Reading packets; the counts in `packets` and `candidates` change | Progress, Cancel |
| `completed` | Every packet was read in full. **Check `coverageState`**: it can still be `processed_with_unread` | Findings |
| `incomplete` | Some packets were not fully answered; they are listed in `unresolved` | Findings so far, Resume |
| `blocked_budget` | Stopped before a packet whose worst case would pass the budget | Resume with a higher budget |
| `blocked_credentials` | The server can't make paid calls | Message only |
| `failed` | Several packets failed in a row, or the stored evidence changed during retrieval (`error`) | Resume, or start a new run |
| `cancelled`, `interrupted` | Stopped by a person, or by a worker shutdown or crash | Resume |

## Endpoints

| Method and path | Body | Success | Errors |
|---|---|---|---|
| `POST /cases/:id/case-runs` | `{ mode: "live" \| "mock", execution?: "standard" \| "batch" }` (execution: mock only) | 202 `{ caseRun }` | 400 bad body (a budget here is refused; it comes with confirmation), 403 access, 404 case, 409 `{ caseRunId }` when a run of this case is still active |
| `GET /cases/:id/case-runs` | | 200 `{ caseRuns: CaseRunReport[] }`, newest first | 400 |
| `GET /case-runs/:id` | | 200 `{ caseRun }` | 404 |
| `POST /case-runs/:id/confirm` | `{ budgetUsd, execution?: "standard" \| "batch", retentionAcknowledged?: boolean }` (budget more than 0, at most `MAX_CASE_RUN_BUDGET_USD`) | 202 `{ caseRun }` | 400 (with `code: "retention_not_acknowledged"` for economy without the acknowledgement), 403, 404, 409 when not `awaiting_confirmation` |
| `POST /case-runs/:id/resume` | `{ budgetUsd?, retryUncertain? }` | 202 `{ caseRun }` | 400 (a lower budget, or a bad body), 403 live without access, 404, 409 when not stopped |
| `POST /case-runs/:id/cancel` | | 202 `{ caseRun }` | 404, 409 when not active |
| `GET /case-runs/:id/findings` | | 200 `{ complete, incompleteReasons, findings: CaseRunFinding[] }` | 404 |

**Polling.** Poll `GET /case-runs/:id` every few seconds while the status is `queued`, `retrieving` or `adjudicating`. Stop at any other status. Progress is shown as counts, never a percentage: `packets.adjudicated` of `packets.total`, and `candidates.adjudicated` of `candidates.total`.

**Cancel.** No new packet starts after a cancel; the packets in flight (several when the worker runs packets in parallel) finish and are kept. A run with no worker attached becomes `cancelled` at once. An economy run stays `adjudicating` with `cancelRequested: true` until its next check has asked the provider to cancel its open batches and imported what they finished (requests already running may still complete and be billed); then it becomes `cancelled`.

## `CaseRunReport`

```ts
type CaseRunReport = {
  id: number; caseId: number; status: CaseRunStatus; mode: "live" | "mock"; error: string | null;
  execution: "standard" | "batch"; retentionAcknowledgedAt: string | null;
  economyAvailable: boolean;                // paid economy can be confirmed on this server (ALLOW_ECONOMY_ANALYSIS)
  batches: null | {                         // economy runs only: provider batches by state, requests by outcome
    total; submitting; processing; awaitingImport; imported; notSubmitted; unknown: number;
    oldestOpenSince: string | null; resultsExpireAt: string | null; requests: Record<string, number>;
  };
  model: string; promptVersion: "packet-v1"; effort: string; config: object; sourceHash: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null; updatedAt: string; confirmedAt: string | null; cancelRequested: boolean;
  estimate: null | {                        // set after retrieval
    packets: number; listedPairs: number; splitPackets: number; oversizePackets: number;
    expectedUsd: number; noCacheUsd: number; largestPacketWorstCaseUsd: number; recommendedBudgetUsd: number;
    economy?: {                             // the same projection at batch prices (absent on older runs)
      expectedUsd: number; noCacheUsd: number;   // cache hits in a batch are best effort: show the range
      worstCaseUsd: number; worstCasePerBatchUsd: number; recommendedBudgetUsd: number; batchSize: number; discount: number;
    };
    assumptions: object; note: string;      // a projection, not a measurement
  };
  coverageState: "complete" | "processed_with_unread" | "partial";
  complete: boolean;                        // coverageState === "complete" && status === "completed"
  incompleteReasons: string[];              // plain sentences, ready to show
  candidates: {                             // every retrieved pair is counted in exactly one of the first six
    total: number; adjudicated: number;
    incomplete: number;                     // read, but its packet ended incomplete or failed: no verdict
    pending: number;                        // not read yet
    deferred: number;                       // retrieval triage set it aside (deferredByStage says which stage); unread
    uncovered: number;                      // in no packet; unread
    excluded: number;                       // its stored lines could not be rebuilt
    deferredByStage: Record<string, number>; sameWitness: number; crossWitness: number;
  };
  packets: { total; adjudicated; incomplete; failed; notStarted; inProgress; uncertain; retryable; storedRepliesNotParsed; modelReplies: number };
  unresolved: { packetId: string; status: "incomplete" | "failed"; pairs: { a: string; b: string; status: string }[] | null; note: string | null; uncertain: boolean | null }[];
  findings: { type: string; priority: string; scored: boolean; n: number }[];   // counts by lane
  requests: { total; answered; failedNotBilled; uncertain; open: number };
  cost: { recordedCalls: number; costUsd: number; inputTokens: number; outputTokens: number; budget: { limitUsd; spentUsd; reservedUsd: number } | null };
};
```

## How to show incomplete work

- **`coverageState`** is the headline:
  - `complete`: every retrieved pair has a verdict.
  - `processed_with_unread`: every packet was read, but retrieval set some pairs aside. Say so, with `incompleteReasons`.
  - `partial`: work is left.
- **Unread is never compatible.** Never show `deferred`, `uncovered`, `pending` or `incomplete` pairs as "no contradiction".
- **`uncertain` packets** failed after the provider may have received the request, so it may have been billed. Resume never retries them unless `retryUncertain: true` is sent. If the UI offers this, it should warn that the request could be charged twice.
- **`failed` packets that aren't uncertain**, and `incomplete` packets, are retried by any resume.

## `CaseRunFinding`

```ts
type CaseRunFinding = {
  id: number; crossWitness: boolean; type: string; priority: string; score: number | null; band: string | null;
  unscoredReason: string | null; evidenceStatus: string; reviewState: string;
  verification: { a: { status: string | null; lineIds: number[] }; b: { … } };   // code: lines each citation was found on
  a: Side; b: Side;
  model: { origin: "model" | "fixture"; model: string; promptVersion: string; outcome: string | null; verdict: unknown };  // label as model output
};
type Side = { exchange: string; depositionId: number; witnessId: number | null; witness: string | null; takenOn: string | null;
              range: string | null;                                  // "12:04–12:09"
              lines: { id: number; at: string; text: string }[] };   // stored transcript lines: the only quotations to show
```

- Highlight `verification.*.lineIds` within `lines` to show where the cited phrase was found.
- A `fixture` origin means a mock run: label it as such, never as live output.
- Review decisions use the existing `PATCH /findings/:id/review`. Case-run findings are ordinary `findings` rows, so `scopeToOrg` already covers them.

## Effect on existing screens

The existing endpoints are unchanged:

- **Case summaries, the workspace and the PDF report** count and list findings through `analyses`, so they don't include case-run findings.
- **`GET /findings/:id`** serves pairwise-analysis findings only, and doesn't understand case-run findings. Use `GET /case-runs/:id/findings`, which returns both passages in full.
- **`PATCH /findings/:id/review`** works for both kinds of finding.

## Not in this contract yet

- An estimate before any run exists. Today the estimate is the `awaiting_confirmation` stage of a live run, because building the pool is too heavy for an API request.
- Budgets: a confirmed or resumed budget can be at most `MAX_CASE_RUN_BUDGET_USD` ($250), apart from the $20 ceiling of a two-session check.
- Findings filters or paging: the list returns everything, in retrieval order (the same whatever order parallel packets finished in).
