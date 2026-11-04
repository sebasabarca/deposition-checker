# Setting up Veridict for development

What was actually tested on November 3, 2026 (macOS, `docs/baseline-m1.md`):

- **Clean clone:** `npm ci`, typecheck, the tests without a database, and the client build. All passed.
- **Database, tests and evaluations:** migrations, the full test suite and the real-data evaluations passed against the existing Docker Postgres.
- **Not tested:** creating the Postgres volume from nothing, and the production image (`Dockerfile`, `compose.prod.yml`, see `docs/deploy.md`).

## 1. Tools

- **Node 24.** `.nvmrc` says 24, and pg-boss 12 needs at least 22.12. Run `nvm install && nvm use`. The scripts under `scripts/retrieval-*.ts` need Node 24.
- **Docker,** for Postgres 16 with pgvector.
- **Optional:** `brew install tesseract poppler` to read scanned PDFs. Without them, scanned pages stay `needs_ocr`.

## 2. Install and configure

```sh
npm install                 # also installs client/ (postinstall)
cp .env.example .env        # then set ANTHROPIC_API_KEY only if you will run approved paid commands
```

| Variable | Needed for | Default in `.env.example` |
|---|---|---|
| `DATABASE_URL` | the app, worker and scripts | local Docker database `deposition_checker` |
| `TEST_DATABASE_URL` | database tests and `eval-real`; **wiped on every run**, and its name must end in `_test` | `deposition_checker_test` |
| `ANTHROPIC_API_KEY` | paid model calls only | placeholder |
| `ALLOW_PAID_CALLS` | live analyses; leave `false` | `false` |
| `RESEND_API_KEY`, `EMAIL_FROM`, `APP_URL` | email (printed to the console in development when unset) | commented out |

## 3. Database

```sh
npm run db:up        # Postgres in Docker; the first start also creates deposition_checker_test
npm run db:migrate   # apply drizzle/ migrations to DATABASE_URL
```

The test suite creates its own tables in `TEST_DATABASE_URL`. After changing `server/src/db/schema.ts`, run `npm run db:generate`, review the SQL, then migrate.

## 4. Run and test

```sh
npm run dev                      # API :3001, worker, client http://localhost:5173
npm run test:fast                # unit tests related to your changes
npm run test:integration         # Postgres and real-file tests related to your changes
npm test                         # all tests (= test:full); database tests skip, saying so, without TEST_DATABASE_URL
npm run typecheck                # server, scripts and tests
npm run build --prefix client    # typechecks and builds the client
npx tsx scripts/evidence.ts eval-real   # Stage 1 real-data checks (needs private fixtures in data/raw/)
npx tsx scripts/facts.ts eval-real      # Stage 2 real-data checks (same)
```

The real-data fixtures are private testimony exports under `data/raw/` (git-ignored, see `data/eval/evidence-fixtures-v1.json`). On a machine without them, `eval-real` fails and names the missing files. That means "not run", not "failed".

## 5. Local MiniLM model (offline retrieval only)

The app doesn't need it. Only `scripts/retrieval-embed.ts` and the frozen benchmarks use it. Fetch it once, at the revision pinned in `server/src/retrieve/minilm.ts` (`MODEL_REVISION`), into the git-ignored `data/raw/models/`:

```sh
REV=751bff37182d3f1213fa05d7196b954e230abad9
for f in config.json tokenizer.json tokenizer_config.json special_tokens_map.json vocab.txt onnx/model.onnx; do
  curl -sSfL --create-dirs -o data/raw/models/Xenova/all-MiniLM-L6-v2/$f https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/$REV/$f; done
echo $REV > data/raw/models/Xenova/all-MiniLM-L6-v2/REVISION
```

Remote loading is disabled in code, so a missing or wrong revision is an error, never a silent download. The reranking experiment's models (`server/src/retrieve/rerankModels.ts`) are fetched the same way. The header of `scripts/retrieval-rerank.ts` has the commands.

## 6. Offline retrieval benchmark

Needs the frozen corpora under `data/raw/retrieval/` (private, git-ignored). The exact commands and expected results are in `docs/baseline-m1.md`. No database, model or API call is involved.

## 7. Hosted models (optional, paid)

Paid commands are listed in `docs/commands.md`. Each one needs `ANTHROPIC_API_KEY`, `ALLOW_PAID_CALLS=true` on that one command, an approved USD limit, and the developer's explicit approval. Never leave `ALLOW_PAID_CALLS=true` in `.env`.

## 8. Agent tools (optional)

- **Claude Code:** reads `CLAUDE.md`.
- **Codex:** reads `AGENTS.md`. Sign in with `codex login` using the developer's ChatGPT account; no OpenAI API key is needed. Check with `codex login status`.
- **Graphify:** `uv tool install graphifyy`, then `graphify update .` builds the local code graph in `graphify-out/`, git-ignored and offline. See the graphify section of `CLAUDE.md` for its limits.
