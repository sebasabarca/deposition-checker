# Veridict (Deposition Checker)

Veridict finds places where deposition testimony may conflict: the same witness across sessions, or two witnesses against each other. It shows each potential contradiction as the two passages of stored testimony side by side, cited by page and line.

**How it works:**
- **Retrieval.** Code finds candidate pairs of exchanges across sessions.
- **Classification.** Claude classifies each pair, for example as a direct contradiction, an inferential one, or likely compatible.
- **Verification and scoring.** Code checks every citation against the stored transcript, checks who said what, and scores the evidence with a fixed rubric. Claude never returns a score.
- **Unverified findings** are kept apart for manual checking.

The app never says a witness lied, and it draws no legal conclusions.

## Quick start

These steps were run on a fresh clone with a brand-new database on November 4, 2026 (macOS, Node 24.22, npm 11.19, Docker Desktop with Compose v2). They need no API key and cost nothing.

### Prerequisites

- **Operating system:** macOS (tested). Linux should work the same way but hasn't been tested. On Windows, use WSL2 (not tested).
- **Node.js 22.12 or newer**, with npm. Node 24 is recommended, and `.nvmrc` selects it.
- **Docker** with Compose v2, which runs PostgreSQL 16 for you. Nothing else needs installing.
- **An Anthropic API key, only for paid analyses.** Everything below works without one.
- **Optional:** `brew install tesseract poppler` to read scanned PDFs. Without them, scanned pages are marked "needs OCR".

### Install and start

```bash
git clone https://github.com/sebasabarca/deposition-checker.git
cd deposition-checker
nvm install && nvm use          # or any Node 22.12+; skip if you don't use nvm
npm install                     # also installs the client (client/)
cp .env.example .env            # the defaults work as they are with the Docker database
npm run db:up                   # starts PostgreSQL in Docker and creates the dev and test databases
npm run db:migrate              # creates the tables (every migration in drizzle/)
npm run dev                     # API on :3001, background worker, and the app
```

Open **http://localhost:5173**.

`npm run dev` starts three processes in one terminal, with prefixed output:
- `[server]` is the API;
- `[worker]` is the background worker, which reads uploads and runs analyses;
- `[client]` is the web app.

All three must stay running. `npm start` and `npm run worker` start the API and worker separately if you prefer.

npm 11 may warn that some packages' install scripts were not run (esbuild, onnxruntime-node and others). The app, the tests and the build work without them, so you can ignore the warning.

### Environment variables (`.env`)

| Variable | Needed? | What it is |
| --- | --- | --- |
| `DATABASE_URL` | Yes (default works) | The app's database. The default points at the Docker database. |
| `TEST_DATABASE_URL` | For database tests | A separate database that tests **empty on every run**. Its name must end in `_test`. |
| `ANTHROPIC_API_KEY` | Paid analyses only | Read only by the server and worker; never sent to the browser. Leave the placeholder to stay free. |
| `ALLOW_PAID_CALLS` | Paid analyses only | Must be `true` for any model call. Keep it `false`: with `false`, nothing can be sent to a model or charged. |
| `APP_URL` | Default works | Where links in emails point. |
| `RESEND_API_KEY`, `EMAIL_FROM` | No | Without them, emails (account verification, password reset) are printed in the `npm run dev` terminal instead of sent. |
| `CASE_RUN_*`, `PROVIDER_*` | No | Concurrency and provider rate limits for whole-case analyses, and the batch size, batches in flight and check interval of Economy runs (`CASE_RUN_BATCH_*`). Conservative defaults; see the comments in `.env.example`. |

## First-time walkthrough

### 1. Create an account

1. In the app, choose **Create an account**.
2. Find the verification link. No email service is configured in development, so the link is printed in the `npm run dev` terminal: look for a line containing `verify?token=`. Open that link in the same browser.
   - Or mark the account verified from a second terminal: `npm run admin -- verify you@example.com`.
3. A short tour opens the first time. Use **Skip** to close it.

### 2. Create a case and upload two depositions

The repository includes invented, synthetic transcripts you can upload: `data/eval/independent-cross-v1/transcripts/`, from the fictional case *Delgado v. Northbay Logistics*. For example:

| File | Witness | Date taken (from its cover) |
| --- | --- | --- |
| `A01_witness1.txt` | Raymond Oduya | October 7, 2025 |
| `A01_witness2.txt` | Carla J. Brennick | October 9, 2025 |

1. **Cases → New case**, then name it.
2. On the case page, choose **Add deposition**. Enter the witness, choose the file, then **Add deposition**. Repeat for the second file.
3. The worker reads each file into page:line references. Wait until both show **Ready**: a few seconds for these files.
4. Each session needs its date. Use **Enter date** in its row.
   - Known issue: for these files the app may suggest a date taken from inside the testimony, labelled "the transcript says". Check it against the cover date.

PDF, text (`.txt`, `.asc`), RTF and Word (`.docx`) are accepted, up to 50 MB each.

### 3. Compare two depositions

There are two ways to compare two depositions.

- **Free, with the test model.** On the case page, under **Whole-case analysis**, choose **Run with the test model (free)**. On a case holding two depositions, this compares exactly those two through the real pipeline: retrieval, evidence packets, citation checks and scoring. A deterministic stand-in replaces the model.
  - Its results are labelled **Test model results** on every finding.
  - They show how the app works; they are not an analysis of the testimony.
- **Paid, with Claude.** Tick two sessions on the case page: two of one witness, or one each of two witnesses. A bar at the bottom shows the estimated cost and a **Check these sessions** or **Compare these witnesses** button.
  - This needs paid access for your account and a configured API key (see step 5).
  - Paid two-session checks were not exercised in the verification above.

### 4. Review contradictions

When a run shows **Finished**, choose **View findings**. Findings are grouped into lanes: potential contradictions, needs context, unverified, and compatible or dismissed. Each finding shows:

- **The two passages:** the stored transcript lines, side by side at page:line, with the cited lines highlighted;
- **The checks:** whether code verified each citation against the stored text;
- **The model's reading:** the model's explanation, labelled as the model's (or as test model output).

**Read in full** opens the deposition at the cited page. Everything is stored: reload the page or come back later, and the run and its findings are still there. The case page shows the latest whole-case run, with **Earlier runs** below it; two-session checks are listed under **Analyses**.

### 5. Analyze an entire case, with a cost estimate first

**Analyze entire case** (or **Analyze case** at the top of the case page) compares every session with every other, same witness and across witnesses.

1. **Preparing.** Veridict finds the candidate pairs and builds evidence packets. Nothing is sent to a model at this stage.
2. **Estimate.** It shows the estimated cost, a recommended spending limit, and the number of packets and pairs, with a warning:
   - larger cases cost more;
   - the run stops at your limit;
   - unread pairs are never counted as reviewed.
3. **Choose the mode.** **Fast analysis** or **Economy analysis**, each with its own estimate (see below).
4. **Confirm.** Nothing is charged until you enter a spending limit (at most $250), tick **I authorize Veridict to spend up to $…** (and, for Economy, the data-retention box), and choose **Start fast analysis** or **Start economy analysis**.
5. **Progress and control.** While the run is in progress, the panel shows packets read, pairs with a verdict, and the amount spent (Economy also shows its provider batches). **Cancel** stops it, and **Resume** continues a stopped run, with a higher limit if it stopped at the old one. You can leave the page: the run continues on the server.

The cost depends on the case. On the project's six-document real test corpus, the estimate was about $60 in Fast mode and about $30–$43 in Economy; a small case like the two files above estimates about $1 (Fast) or $0.50–$0.67 (Economy).

#### Fast or Economy

Both modes read the same prepared evidence packets with the same model, prompt, citation checks and scoring, so the same replies give the same findings. They differ in transport, time and price:

| | Fast | Economy |
|---|---|---|
| How | Parallel requests to the Messages API | Anthropic's Message Batches API, about 100 packets per batch |
| Price | Standard | Half price on every token type. The estimate is a range because the provider's prompt cache is best effort in batches |
| Time | Minutes | Set by Anthropic: most batches finish within an hour, every batch within 24 hours. Findings appear as each batch finishes |
| Spending limit | Each request in flight holds its largest possible cost | Each request in a running batch holds its largest possible cost until it returns, so the recommended limit is higher than the expected spend. A lower limit still works, with fewer packets at a time and a longer run; it never raises the charge |
| Data retention | The account's normal retention | **Anthropic stores batch inputs and results for 29 days, and batches aren't covered by zero data retention.** Economy asks you to acknowledge this before it starts. Check it against your client obligations before using Economy on real testimony |
| Cancel | Stops at once; requests in flight finish | Asks Anthropic to cancel the open batches; requests already running may still finish and are charged. The panel shows "Cancelling…" until the next check, within about a minute |
| If the server restarts | A request in flight may have been charged; it is never resent automatically | Nothing is lost; the run continues from the database |

Economy never switches to Fast on its own. An expired or failed batch request isn't charged and is retried once; a request whose outcome is unknown is counted as charged and retried only if you ask. **Test economy mode (free)** runs the whole economy flow with the test model and a simulated batch provider.

**Preparing an estimate needs paid access for the account.** New accounts don't have it. To try the whole flow without any possibility of a charge, grant access while keeping `ALLOW_PAID_CALLS=false`:

```bash
npm run admin -- grant-analysis you@example.com
```

Confirming then stops at once with **Paid calls are off on this server: nothing was sent and nothing was charged**.

**Running a real paid analysis** needs a real `ANTHROPIC_API_KEY` and `ALLOW_PAID_CALLS=true`, then a restart of `npm run dev`. Set a spending limit you're willing to pay. It is a hard stop, enforced before every request.

**Coverage** is always shown in one of three states:
- **Complete coverage:** every candidate pair was read.
- **Read, with pairs set aside:** every packet was read, but retrieval set some pairs aside. The reasons are listed.
- **Partial: work left:** some pairs haven't been read yet.

## What is real, what is an example, and what is a test

| Label in the app | What it is |
| --- | --- |
| No label (model name shown) | Output from a real Claude call, recorded with its token use and cost. |
| **Test model results / Test model output** | The free deterministic stand-in. It exercises the pipeline only and says nothing about the testimony. |
| **Example** (and "No model was called for it") | Hand-written example assessments in the sample case below. No model produced them. |
| **Verbatim testimony** | Always the stored transcript lines, never text a model wrote. |

## Sample case (prepared demo)

A self-contained case that needs no other data and no model: two invented witnesses (Elena Marsh and Owen Calder), two sessions each, about a fire at an invented warehouse. Run it once your account exists, with `npm run dev` running:

```bash
npx tsx scripts/demo-case.ts --email you@example.com
```

Open **"Sample case: Harbor Street warehouse fire"**. It holds two example analyses with eight hand-written findings, and an example whole-case analysis (**Open case analysis**).

- **Invented testimony:** each session's original text says so.
- **Real checks:** every finding still goes through the real checks. Citations are matched to the stored lines, the speaker is checked, and code calculates the score.
- **Page and line numbers:** these come from laying the text out at 25 lines per page. They are not a real transcript's pagination.

Running the command again changes nothing; delete the case from its page to remove it.

## Tests

```bash
npm test                         # every test; database tests use TEST_DATABASE_URL (emptied on each run)
npm run typecheck                # server, scripts and tests
npm run build --prefix client    # typechecks and builds the web app
```

On a fresh clone with the Docker database: **1,308 passed, 59 skipped**. The skipped tests need private real transcripts that aren't in the repository (`data/raw/`, git-ignored); they print why they skip. No test calls a model or needs an API key.

`npx tsx scripts/evidence.ts eval-real` and `npx tsx scripts/facts.ts eval-real` need the same private files, and say which are missing.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `npm install` says the engine is unsupported | Use Node 22.12 or newer (`nvm install && nvm use`). |
| `npm run db:up` fails: port 5432 already in use | Another PostgreSQL is running. Stop it, or map another port in a `compose.override.yml` (`ports: !override ["5433:5432"]`) and change both URLs in `.env` to `5433`. |
| `npm run db:up` says Docker isn't running | Start Docker Desktop, then run it again. |
| The app says "The server can't be reached" | The API isn't running: check the `[server]` lines in the `npm run dev` terminal. |
| Uploads stay "Processing" | The worker isn't running: check the `[worker]` lines. |
| A check can't start: "Date needed" | Enter each session's date on the case page. |
| "Paid checks aren't enabled for this account" | Expected for new accounts. Use the free test model, or `npm run admin -- grant-analysis <email>`. |
| No verification email arrives | In development it is printed in the `npm run dev` terminal, or use `npm run admin -- verify <email>`. |
| Database tests are skipped | Set `TEST_DATABASE_URL` in `.env` (the default works with `npm run db:up`). |

## Safety

- Never commit `.env`, API keys, passwords or real deposition files. `.env` and `data/raw/` are git-ignored.
- `.env.example` holds placeholders only.
- Keep `ALLOW_PAID_CALLS=false` unless you mean to spend. Any paid run also needs an account with paid access and an explicit spending limit.
- Accounts you create locally are local test accounts; there is no shared or production account.

## More documentation

- `docs/setup.md`: development setup in more detail.
- `docs/commands.md`: every script, and which ones are paid.
- `docs/architecture.md`: what each module does.
- `docs/case-run-api.md`: the whole-case analysis API.
- `DESIGN.md`: the design.

## Known limitations

- **Paid analyses haven't been re-verified here.** The paid two-session check and a paid whole-case run need a funded API key. They were not run in the November 4 verification; only their confirmations and safeguards were.
- **Free mode on fresh uploads.** The free test model exercises the pipeline but doesn't judge testimony. The older "demo" mode of two-session checks only replays stored assessments, so it finds nothing on new uploads, and the app doesn't offer it.
- **Session date suggestions** can pick a date from the testimony instead of the cover. Always confirm the date.
- **Whole-case limits are per worker process:** with several workers, divide the `PROVIDER_*` limits between them.

## How I used AI

I used Claude to help draft and review code. I made the design decisions, tested every rule against the sample transcripts and a larger test transcript, and changed AI suggestions when they failed on real data. For example, a suggested rule to mark any quote with several times as uncertain would have broken the "Around 10, maybe 10:30" case, so I replaced it with the 60-minute rule.

## Evidence strength

Direct findings use the `evidence-strength-v1` checklist, 20 points per check: quotations match (20, or 10 if approximate), the statements are the witness's (20), clear assertions (10 per side), same subject per the model (20), and a conflict that holds without missing context per the model (direct 20, inferential 10). It is not a probability that the witness contradicted themselves, and it sets neither the lane nor the priority: High needs a direct classification, one subject and at least one plain assertion, and other conflicts are Medium.
