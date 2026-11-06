# Exact-request reuse

**Design:** `DESIGN.md`, "Implementation note: exact-request reuse". **API:** `docs/case-run-api.md`.
**Migration:** `0041_exact_request_reuse`. No paid call was made to build or test it.

A live case run reuses the recorded response of an identical request from an earlier live run of the same case,
instead of paying for it again. Carried-forward reuse (reusing an answer when the evidence changed) is not
implemented.

## When a request is reused

| Part | What it covers | Where |
|---|---|---|
| Request fingerprint | SHA-256 of canonical JSON: `packetRequestParams` (model, max_tokens, system prompt with cache control, effort, output schema, packet text), the adjudicator's model id and effort, the contract, the key version (`exact-request-v1`) and the compatibility version (`REUSE_COMPATIBILITY_VERSION`) | `adjudicate/requestReuse.ts` |
| Evidence key | SHA-256 of each shown deposition (id, witness, parser version, evidence epoch) and each passage's stored line ids | the same file |
| Model identity | The source was requested with, and answered by (`llm_calls.model`), exactly the model id this run requests | `jobs/requestReuse.ts` |
| Source eligibility | Same case, a live run, `completed`, no `error_kind`, a recorded `llm_calls` row with raw text, both keys equal | the same file |
| Never a source | Sent, failed, partial, aborted, uncertain or unsubmitted requests, requests in an open batch, reused rows, mock and test-model runs, other cases, requests recorded before migration 0041 | the same file |

**A hit** records a `reused` request row (no call, no reservation, cost 0, enforced by the database check
`adjudication_requests_reused_check`), points the ledger entry at the source call, and parses the stored text
again through `applyReply`. Every reused response is verified, safeguarded and scored by current code, and its
findings belong to the new run.

**Invalidating everything at once:** bump `REUSE_COMPATIBILITY_VERSION` in `adjudicate/requestReuse.ts`. Do this
whenever a model may have changed behind the same id.

**Switches:**
- `REQUEST_REUSE=off` turns reuse off for the server (the worker turns it on otherwise).
- **Run fresh analysis** (`POST /case-runs/:id/confirm` with `fresh: true`): shown at the review step only when
  reuse is expected. The run reuses nothing and pays for every request, under the same limit and authorization.
  Its own answers can serve later runs. The result page says "Fresh analysis".

## The estimate

The estimate builds every planned request exactly as the run will send it and looks each one up with the run's
own rule. It shows the requests expected to be reused, the expected new cost and the cost expected to be avoided,
worded as an expectation. Both ends of the cost range are scaled by the share left to pay. The recommended limit
and the server's reservations still cover the whole run, so a reuse that misses is paid within the limit.

## Tests

- `tests/db/caseRunReuse.test.ts` (13, fake providers, disposable database): a repeated run reuses everything at
  $0 with the same findings; a fresh analysis pays for everything and then serves later runs; another model id
  is never reused; the estimate predicts exactly the reuse the run gets; reused text is re-verified; changed
  evidence misses; a different model, effort or contract misses; case scope, mock runs and the server switch;
  crash recovery after a hit; concurrent runs; Economy (no batch on repeat, open batches never a source); human
  reviews untouched; a deposition added to a case.
- `tests/adjudicate/requestReuse.test.ts` (7): fingerprint, evidence key, switches and estimate.
- `tests/client/caseRuns.test.ts`: the review step and result labels.
- Full suite on the integration branch (merged with main 1fd75b7): 1,502 passed, 59 skipped. Typecheck clean, client builds.

**Browser check** (Hutchinson case, disposable database, fake providers, no API key): a repeated Fast run reused
the 300 packets the estimate expected and paid only for the 35 the first run never answered; a repeated Economy
run reused 335 of 335 with no batch and $0; an interrupted Fast run resumed with no duplicate verdicts and did not
re-send its 4 possibly billed requests. Economy crash recovery was not checked in the browser (the fake batch
provider loses its batches on restart); the batch tests cover it.

## Measured on the experiment branch

Simulated full-case runs (production code, fake provider, real stored testimony) before integration:

| Case | Run | Sent | Reused |
|---|---|---|---|
| 20 sessions | first run, without its last deposition | 644 | 0 |
| 20 sessions | after the deposition is added | 327 | 337 (51%) |
| 20 sessions | identical repeat | 0 | 664 (100%) |
| 3 sessions (case 19) | first run, without its last deposition | 2,218 | 0 |
| 3 sessions | after the deposition is added | 2,743 | 128 (4.5%) |
| 3 sessions | identical repeat | 0 | 2,871 (100%) |

With measured packet-v1 rates, re-running an unchanged case 19 drops from about $47.73 (Fast) or $23.9 (Economy)
to $0, and from about 64 minutes to about 1 minute of re-verification. Adding a deposition saves about half the
requests in a 20-session case and little in a 3-session case, because a new deposition reshuffles most of a small
case's retrieval.

## Remaining risks

- **Model ids must be fixed.** If a provider changes a model behind the same id, someone has to bump
  `REUSE_COMPATIBILITY_VERSION`.
- **Reuse gives the same reading every time.** A re-run is no longer a second opinion (same-input variation was
  about 7–9% of pairs). Use Run fresh analysis for a new reading.
- **An expected reuse can still miss** (for example, evidence changes after the estimate). That request is charged
  within the limit.
- **Concurrent first runs of one case** both miss and both pay. That costs money but corrupts nothing.
- **Isolation is per case.** There is no cross-case sharing; adding any would need a security review.
- **The first run after deployment pays in full:** requests recorded before 0041 have no fingerprint.
- **Stored responses stay in `llm_calls`,** as they already do for crash recovery. Reuse adds no new retention.
