# Case-run API: contract for the frontend

A **case run** analyses every witness and session of a case at once. Code is in `server/src/jobs/caseRun.ts`, routes in `server/src/api/caseRuns.ts`, and the response type is `CaseRunReport` in `caseRun.ts`. The client keeps its own copy of server response types in `client/src/types.ts`, so add these there when the screen is built.

Every route is under `/api`. They sit behind the existing sign-in, `sameOrigin` and `scopeToOrg` middleware, so a run in another organization's case answers 404.

- Starting a live run or confirming one needs a verified email and paid access (`analysisAccess`): the same rule as live analyses.
- A mock run never needs paid access.
- Resuming needs paid access only when the run is live; the route checks the run's stored mode.
- Requests only read and write rows and queue a job. All work runs in the worker.

## Lifecycle

```
POST /cases/:id/case-runs {mode:"live"}
  queued → retrieving → awaiting_confirmation (estimate ready; nothing sent, nothing spent)
POST /case-runs/:id/confirm {budgetUsd}
  queued → adjudicating → completed | incomplete | failed | blocked_budget | cancelled | interrupted
POST /case-runs/:id/resume {budgetUsd?, retryUncertain?}   (from incomplete, failed, blocked_*, cancelled, interrupted)
  queued → adjudicating → …
```

A mock run (`{mode:"mock"}`) skips confirmation. It goes straight to adjudication with the deterministic mock: no model, no cost, and verdicts labelled `fixture`.

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
| `POST /cases/:id/case-runs` | `{ mode: "live" \| "mock" }` | 202 `{ caseRun }` | 400 bad body (a budget here is refused; it comes with confirmation), 403 access, 404 case, 409 `{ caseRunId }` when a run of this case is still active |
| `GET /cases/:id/case-runs` | | 200 `{ caseRuns: CaseRunReport[] }`, newest first | 400 |
| `GET /case-runs/:id` | | 200 `{ caseRun }` | 404 |
| `POST /case-runs/:id/confirm` | `{ budgetUsd }` (more than 0, at most `MAX_BUDGET_USD`) | 202 `{ caseRun }` | 400, 403, 404, 409 when not `awaiting_confirmation` |
| `POST /case-runs/:id/resume` | `{ budgetUsd?, retryUncertain? }` | 202 `{ caseRun }` | 400 (a lower budget, or a bad body), 403 live without access, 404, 409 when not stopped |
| `POST /case-runs/:id/cancel` | | 202 `{ caseRun }` | 404, 409 when not active |
| `GET /case-runs/:id/findings` | | 200 `{ complete, incompleteReasons, findings: CaseRunFinding[] }` | 404 |

**Polling.** Poll `GET /case-runs/:id` every few seconds while the status is `queued`, `retrieving` or `adjudicating`. Stop at any other status. Progress is shown as counts, never a percentage: `packets.adjudicated` of `packets.total`, and `candidates.adjudicated` of `candidates.total`.

**Cancel.** No new packet starts after a cancel; the packets in flight (several when the worker runs packets in parallel) finish and are kept. A run with no worker attached becomes `cancelled` at once.

## `CaseRunReport`

```ts
type CaseRunReport = {
  id: number; caseId: number; status: CaseRunStatus; mode: "live" | "mock"; error: string | null;
  model: string; promptVersion: "packet-v1"; effort: string; config: object; sourceHash: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null; updatedAt: string; confirmedAt: string | null; cancelRequested: boolean;
  estimate: null | {                        // set after retrieval
    packets: number; listedPairs: number; splitPackets: number; oversizePackets: number;
    expectedUsd: number; noCacheUsd: number; largestPacketWorstCaseUsd: number; recommendedBudgetUsd: number;
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
- Concurrency: packets are read one at a time.
- Findings filters or paging: the list returns everything, in retrieval order (the same whatever order parallel packets finished in).
