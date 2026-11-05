# Deploying Veridict

One Docker image runs both processes: the web server (the API and the built client, on port 3001)
and the worker (parsing, OCR and analyses). They share Postgres and the uploads volume.

## On one host with Docker Compose

```sh
cp .env.example .env
# Set POSTGRES_PASSWORD (long and random) and ANTHROPIC_API_KEY.
# With ANTHROPIC_API_KEY set, whole-case analyses can be authorized by accounts granted paid access (npm run admin).
# Never set LOCAL_MODE here (compose.prod.yml doesn't pass it): it is for one person's own computer.
docker compose -f compose.prod.yml up -d --build
```

`migrate` applies the database migrations and exits; `web` and `worker` start after it succeeds.
Uploaded files live in the `uploads` volume and the database in `pgdata`: back up both.

Put a TLS-terminating proxy (Caddy, nginx or a cloud load balancer) in front of port 3001. The
compose file already sets `COOKIE_SECURE=true` (the session cookie is sent only over HTTPS) and
`TRUST_PROXY=1` (one proxy hop). The proxy must allow request bodies of 50 MB for uploads.

## Accounts

Anyone can register. A new account must verify its email before it can upload depositions or run
checks, and paid checks stay off until you grant them (credits will replace this):

```sh
docker compose -f compose.prod.yml exec web npm run admin -- grant-analysis someone@example.com
```

`npm run admin` also has `verify <email>` (when email isn't working) and `claim-cases <email>`,
which moves cases created before accounts existed into that account.

## Email

Verification and password-reset emails go through [Resend](https://resend.com). Set, in `.env`:

- `RESEND_API_KEY`: an API key with permission to send.
- `EMAIL_FROM`: the sender, on a domain verified in Resend, for example `Veridict <no-reply@mail.yourdomain>`.
- `APP_URL`: the public address of the site, for example `https://veridict.yourdomain`. Links in emails point here.

Tokens in links are single-use, expire (verification 24 hours, reset 1 hour), and are stored only as
hashes. They're never logged in production.

## Health

`GET /api/health` answers 200 while the database is reachable, 503 otherwise. The compose file
uses it as the web container's health check.

## What is not covered yet

- Sign-in rate limits are kept in memory per web process. Run one web process, or move them to
  Postgres before scaling out.
- There is no user management screen; administration is `npm run admin`.
- Uploaded files are on a local volume. Moving to object storage means changing
  `server/src/ingest/uploads.ts`.
