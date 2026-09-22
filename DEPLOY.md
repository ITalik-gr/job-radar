# Deploying to Cloudflare

Goal: the radar works without a laptop running, is reachable from a phone, and cron
does not depend on anyone being awake.

One worker serves both the API and the frontend. The database is D1. The scheduler
is Cron Triggers.

## If the build hangs

Where it got stuck matters, these are different ailments.

**Hangs on `Installing`** is `better-sqlite3` compiling through node-gyp. Fixed by
the `--ignore-scripts` flag, already in place in the workflow and in the build
command.

**Hangs on `Initializing`** (before `Cloning`, logs show only
`Initializing build environment...`) is not about the repo: the code has not even
been downloaded at that point, so there is nothing to change in it. On Cloudflare
this means a broken build token, see the "Workers Builds" section below. This is
exactly why deployment moved to GitHub Actions.

## The most common error in production

`Failed query: select ... params:` on any query means **the remote database has no
tables**. Migrations have to be applied separately, deploying the worker does not
run them.

```bash
pnpm wrangler d1 migrations apply job-radar --remote
pnpm cf:doctor https://<your-worker>.workers.dev/ --token <RADAR_TOKEN>
```

`doctor` shows which tables exist, which are missing, and what to do. `GET /api/health?deep=1`
gives the same thing, and it is available without a token.

Checking directly:

```bash
pnpm wrangler d1 execute job-radar --remote --command "select name from sqlite_master where type='table'"
```

There should be 10 tables: companies, company_state, contacts, llm_cache, llm_usage,
outreach, queue_items, runs, snapshots, vacancies.

## One time only

```bash
pnpm wrangler login

# 1. Database
pnpm wrangler d1 create job-radar
# the response will contain database_id, put it into wrangler.local.jsonc
# (copy from wrangler.local.example.jsonc, it is gitignored)

# 2. Secrets
pnpm wrangler secret put RADAR_TOKEN          # make up a long string, this is the radar's password
pnpm wrangler secret put ANTHROPIC_API_KEY
pnpm wrangler secret put TELEGRAM_BOT_TOKEN
pnpm wrangler secret put TELEGRAM_CHAT_ID

# 3. Database schema
pnpm cf:migrate

# 4. Deploy
pnpm deploy
```

After deploying, the worker lives at `https://<your-worker>.workers.dev`.

## Deploy on push, GitHub Actions

The main path. File `.github/workflows/deploy.yml`, triggers on push to `main` and
with the Run workflow button. Steps: install dependencies without scripts, check
types (backend and frontend), build the frontend, `wrangler deploy`.

Types are checked before deploying on purpose: there is one worker and it is
production, cheaper to stop a broken build in CI.

**What needs to be set once** in GitHub, Settings, Secrets and variables, Actions:

| secret | where to get it |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com, My Profile, API Tokens, **Edit Cloudflare Workers** template |
| `CLOUDFLARE_ACCOUNT_ID` | `pnpm wrangler whoami`, Account ID column |

The token needs to cover Workers Scripts (edit), Workers KV (edit), D1 (edit) and
Account Settings (read). The Edit Cloudflare Workers template gives all of that.

**Why `--ignore-scripts`:** among the dependencies is `better-sqlite3`, a native
driver for local work. In CI it compiles through node-gyp, taking several minutes or
hanging outright, and the worker does not need it: there the database is D1. With
this flag the build takes seconds.

Important: **D1 migrations are not part of this chain**, and that is deliberate.
Applying the schema automatically on every push is dangerous. After a schema change
(that is, after `pnpm db:generate`), run this once from your laptop:

```bash
pnpm wrangler d1 migrations apply job-radar --remote
```

For personal values that must not sit in the repo (database id, From name, AI
Gateway settings), see the "Personal values" section below.

## After the overnight session on 09/04: mandatory migration

New tables and columns appeared. **Without the migration, production will break**,
and not partially either, on any request touching companies: the code reads
`companies.kind`, `copyright_year` and `last_post_at`, and they are not there yet.

| migration | what it adds |
| --- | --- |
| `0005` | tables `settings` (rules from the interface) and `templates` (letter templates) |
| `0006` | `companies.kind`: studio, design, startup, product, outstaff |
| `0007` | `companies.copyright_year`, `last_post_at`: signs of the site being alive |
| `0008` | `templates.for_kind`: which company type a template is tailored to |
| `0009` | `outreach.contact_name`, `contact_email`: who exactly was written to |

```bash
pnpm wrangler d1 migrations apply job-radar --remote
pnpm cf:doctor https://<your-worker>.workers.dev/ --token <RADAR_TOKEN>
```

`doctor` must show 12 tables.

After the migration, existing companies need their kind set once, this cannot be
done through the interface, only via CLI against the local database:
`pnpm cli kinds`. On production the kinds get set on their own the next time the
sources run, because `upsertCompany` computes them every time.

## Workers Builds, Cloudflare's built-in builder

The second path, not used right now. It used to hang on
`Initializing build environment...` and never got further. The `Initializing` stage
is issuing a build runner, the repo has not been cloned yet at that point, so the
cause is always on Cloudflare's side, not in the code. Per the docs, this happens
when the **build token has been deleted or reissued**: the build settings still
reference a token that no longer exists.

If you ever go back to it:

1. Dashboard, Workers and Pages, worker `job-radar`, Settings, Build
2. Check that the worker's name in the dashboard matches `name` in `wrangler.jsonc`, that is `job-radar`
3. In the Build token field, create a **new** token and select it, do not reselect the old one
4. If that does not help, remove and set up the GitHub integration again

| field | value |
| --- | --- |
| Build command | `pnpm install --frozen-lockfile --ignore-scripts && pnpm build:web` |
| Deploy command | `npx wrangler deploy` |
| Root directory | `/` |
| Build variables | not needed, secrets live separately |

Not worth keeping both paths enabled: every push would trigger two deploys, and the
later one is not necessarily newer by commit.

Secrets (`RADAR_TOKEN`, `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`)
are set once through `wrangler secret put` or in the dashboard, Settings, Variables
and Secrets. They are not in the repository and are not overwritten by a deploy.

## Personal values: wrangler.local.jsonc

Everything that identifies you or your Cloudflare account (database id, From name,
Gmail redirect URI, AI Gateway account and gateway name, your worker's URL) stays
out of `wrangler.jsonc`, which is committed and generic.

1. Copy `wrangler.local.example.jsonc` to `wrangler.local.jsonc` (gitignored) and fill it in
2. `pnpm deploy` builds `wrangler.deploy.json` from `wrangler.jsonc` plus `wrangler.local.jsonc`
   (`scripts/wrangler-config.mjs`) and deploys with it
3. For GitHub Actions, store the whole file as the `WRANGLER_LOCAL_JSONC` repository secret:
   ```bash
   gh secret set WRANGLER_LOCAL_JSONC < wrangler.local.jsonc
   ```
   CI writes it to `wrangler.local.jsonc` before building the deploy config. Without
   the secret, the generic config deploys as is, which is what a fresh fork gets by default.

Real secrets (API keys, tokens) still go through `wrangler secret put` as described
above, never through `wrangler.local.jsonc`.

## AI Gateway in front of Anthropic

Model calls can go through Cloudflare's gateway. This is free and gives three things
that are missing right now: a cache on top of the existing `llm_cache`, a hard spend
limit, and a log of every request with its response. Right now `llm_usage` only
shows a counter, that is, how many calls, but not what exactly went into the model
and why.

Classification quality does not change, it is the same model, only the address changes.

1. Cloudflare dashboard, AI section, AI Gateway, Create Gateway, name `job-radar`
2. Locally in `.env`:
   ```
   ANTHROPIC_BASE_URL=https://gateway.ai.cloudflare.com/v1/<CF_ACCOUNT_ID>/job-radar/anthropic
   ```
3. In production, the same thing as a worker variable:
   ```bash
   pnpm wrangler secret put ANTHROPIC_BASE_URL
   ```

An empty variable means a direct call, so nothing breaks if the gateway is not created.

## Finding similar companies through Workers AI

Company description vectors are computed by the `@cf/baai/bge-m3` model. It is
multilingual, and that matters here: the database has English studio descriptions
sitting next to Ukrainian vacancies from DOU.

Nothing to configure in production: `wrangler.jsonc` has the `AI` binding, no token
or outbound access needed. The "Compute similarity" button is in the Run menu.

Locally a token is needed, since there is no binding outside Workers:

```
CF_AI_ACCOUNT_ID=<CF_ACCOUNT_ID>
CF_AI_API_TOKEN=<token with Workers AI Read and Run permissions>

# The names are exactly CF_AI_*, not CLOUDFLARE_*. Wrangler reads .env and takes
# CLOUDFLARE_API_TOKEN from it as its own auth key, so a token issued only for
# Workers AI replaced the login and broke pnpm cf:migrate with 7403
# "account is not authorized to access this service".
```

Then `pnpm cli embed --limit 200` and `pnpm cli similar <id>`.

Cost: the free Workers AI quota is 10 thousand neurons a day, and the whole database
of four hundred companies fits into it with room to spare. Vacancy classification
stays on Anthropic: it needs strict JSON and the "whatever is not in the text is
null" behavior, and swapping out a proven model to save two dollars a month is not
worth it.

## Useful commands

| command | what it does |
| --- | --- |
| `pnpm deploy` | build the frontend and deploy (from a laptop) |
| `pnpm cf:migrate` | apply migrations to the remote database |
| `pnpm cf:migrate:local` | the same for the local D1 (`wrangler dev`) |
| `pnpm cf:dev` | worker locally against real D1, port 8787 |
| `pnpm cf:tail` | live production logs |
| `pnpm cf:doctor <url> --token <token>` | check the database and routes in production |

## First login

Open `https://<your-worker>.workers.dev/?token=<RADAR_TOKEN>`.
The token gets saved in the browser, after that you can log in without it. Same on the phone.

Without the token, the API returns 401. This is the only protection, and it is
enough for a tool meant for one person, but the token must not be put anywhere
public.

## Extension

In the extension popup, fill in:

- **radar address**: `https://<your-worker>.workers.dev`
- **token**: the same `RADAR_TOKEN`

After that the collector sends companies straight to the cloud, the local server is no longer needed.

## Telegram

Bot commands on Workers work through a webhook, there is no polling there:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<your-worker>.workers.dev/api/telegram/webhook"
```

Scheduled notifications (digest, follow-ups, alerts) work fine without the webhook too.

## Moving the local database to D1

`sqlite3 .dump` does not work: it contains `CREATE TABLE` statements that conflict
with already applied migrations. So there is a separate command that outputs only
the data:

```bash
# just companies and correspondence, the most important part, about 400 KB
pnpm cli export:sql /tmp/data.sql --tables companies,company_state,contacts,outreach
pnpm wrangler d1 execute job-radar --remote --file=/tmp/data.sql
```

A full export together with vacancies and snapshots weighs about 13 MB, which
already runs into the limits of a single `d1 execute`. It is simpler to collect
vacancies again with the "Refresh vacancies" button, they get refreshed every 6
hours anyway.

Or start with a clean database: the extension, the "Collect DOU" and "Find career
pages" buttons will fill it up over an evening.

## What stayed local

- `pnpm cli` only works with the local database. For the cloud version, actions are
  available through buttons in the interface
- Playwright, if it is ever needed, will not run on Workers. That would be a
  separate local workaround
- CPU limit per request: heavy runs (`source:sync` across hundreds of companies)
  are better left to cron, which splits the work into separate runs

## What this costs

Free plan: 100 thousand requests a day, 5 million D1 row reads a day, cron every few
hours. Free for one user. Only the Anthropic API for classification costs money.
