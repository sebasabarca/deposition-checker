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

## A public read-only demo (guest mode)

Guest mode publishes one finished analysis for anyone to look at, with no account and no way to change
anything or reach a model (`server/src/guest.ts`). The sign-in page offers only "Explore the demo"; every
request that would change something is refused, for every visitor; and the web server and the worker refuse
to start if `ANTHROPIC_API_KEY` is set. Build its database from a copy, never from the working database:

```sh
npx tsx scripts/db-snapshot.ts dump --db <your db> --out data/raw/guest-demo/source.dump
npx tsx scripts/db-snapshot.ts restore --file data/raw/guest-demo/source.dump --into <name>_rehearsal_guest
npx tsx scripts/guest-demo.ts --db <name>_rehearsal_guest --case <id> --run <id> \
  --email guest@demo.example.test --uploads-out data/raw/guest-demo/uploads
npx tsx scripts/db-snapshot.ts dump --db <name>_rehearsal_guest --out data/raw/guest-demo/guest.dump
```

`guest-demo.ts` keeps that case and that completed analysis only: every other case, analysis, account,
session and unused cost record is deleted from the copy, and it prints what is left so you can check it.

Deploy it with `compose.guest.yml`: Postgres, the web server and Caddy, which gets and renews the HTTPS
certificate itself (`deploy/Caddyfile`). There is no worker, the model key is fixed to empty in the compose file
(never read from `.env`), and only Caddy publishes ports (80 and 443). On a fresh Ubuntu 24.04 server with at
least 2 GB of memory, after pointing a DNS `A` record for the demo's name at the server (on Cloudflare, "DNS
only", so Caddy can get its certificate):

```sh
# On your computer: copy the demo database and transcripts to the server.
scp data/raw/guest-demo/guest.dump root@<server>:/root/
scp -r data/raw/guest-demo/uploads root@<server>:/root/

# On the server.
apt update && apt install -y docker.io docker-compose-v2 git ufw
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
git clone https://github.com/sebasabarca/deposition-checker.git veridict && cd veridict
printf "POSTGRES_PASSWORD=%s\nDEMO_DOMAIN=demo.yourdomain.com\n" "$(openssl rand -hex 24)" > .env
docker compose -f compose.guest.yml up -d db && sleep 10
docker compose -f compose.guest.yml exec -T db pg_restore -U veridict -d veridict --no-owner --no-privileges < /root/guest.dump
docker compose -f compose.guest.yml up -d --build
docker compose -f compose.guest.yml cp /root/uploads/. web:/app/data/uploads/
```

The server's `.env` holds only the database password and the demo's name: no model key, ever. To update the
code later: `git pull && docker compose -f compose.guest.yml up -d --build`.

## Health

`GET /api/health` answers 200 while the database is reachable, 503 otherwise. The compose file
uses it as the web container's health check.

## What is not covered yet

- Sign-in rate limits are kept in memory per web process. Run one web process, or move them to
  Postgres before scaling out.
- There is no user management screen; administration is `npm run admin`.
- Uploaded files are on a local volume. Moving to object storage means changing
  `server/src/ingest/uploads.ts`.
