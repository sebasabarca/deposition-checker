# Deploying Veridict

One Docker image runs both processes: the web server (the API and the built client, on port 3001)
and the worker (parsing, OCR and analyses). They share Postgres and the uploads volume.

## On one host with Docker Compose

```sh
cp .env.example .env
# Set POSTGRES_PASSWORD (long and random) and ANTHROPIC_API_KEY.
# Set ALLOW_PAID_CALLS=true only when live checks should call Claude.
docker compose -f compose.prod.yml up -d --build
```

`migrate` applies the database migrations and exits; `web` and `worker` start after it succeeds.
Uploaded files live in the `uploads` volume and the database in `pgdata`: back up both.

Put a TLS-terminating proxy (Caddy, nginx or a cloud load balancer) in front of port 3001. The
compose file already sets `COOKIE_SECURE=true` (the session cookie is sent only over HTTPS) and
`TRUST_PROXY=1` (one proxy hop). The proxy must allow request bodies of 50 MB for uploads.

## First account

Open the site and create the first account. It takes over every case already in the database.
After that, sign-up is closed unless `ALLOW_SIGNUP=true`; each account created then gets its own
firm, which sees only its own cases.

## Health

`GET /api/health` answers 200 while the database is reachable, 503 otherwise. The compose file
uses it as the web container's health check.

## What is not covered yet

- Sign-in rate limits are kept in memory per web process. Run one web process, or move them to
  Postgres before scaling out.
- There is no password reset or user management screen; accounts are created by sign-up.
- Uploaded files are on a local volume. Moving to object storage means changing
  `server/src/ingest/uploads.ts`.
