# Deploying to Cloudflare

The radar runs as one Cloudflare Worker: it serves the API and the interface, keeps
its data in D1, runs the schedule on Cron Triggers, and computes company vectors with
the Workers AI binding. Once deployed it needs no laptop: it collects, scores, sends,
reads replies and messages you in Telegram on its own.

## First deploy

```bash
pnpm install
cp .env.example .env        # fill in what you have, see "Secrets" below
pnpm wrangler login
pnpm cf:setup --dry-run     # optional: see what it would do
pnpm cf:setup
```

`cf:setup` is safe to run again, it reuses whatever already exists:

1. checks the wrangler login
2. finds the D1 database `job-radar` or creates it, and writes its id into
   `wrangler.local.jsonc`
3. applies migrations
4. builds the frontend and deploys, uploading in the same step every secret the worker
   does not have yet: a generated `RADAR_TOKEN`, and from `.env` the model key, Telegram,
   mail provider keys
5. prints the worker URL and, on the first run, the `RADAR_TOKEN`

Then:

1. Open `https://<your-worker>.workers.dev/?token=<RADAR_TOKEN>`. The browser keeps the
   token, the phone too after the same link once.
2. Add your worker URL to `wrangler.local.jsonc` as `WEB_URL` (links in Telegram point
   there) and run `pnpm deploy`.
3. Optional pieces below: GitHub Actions, mail, Telegram commands, AI Gateway.

The workers.dev subdomain is asked for once per Cloudflare account, the first time
anything is deployed on it. Pick any.

## What goes where

| where | what | committed |
| --- | --- | --- |
| `wrangler.jsonc` | worker name, bindings, cron, model names | yes, same for everyone |
| `wrangler.local.jsonc` | your database id and plain values that identify you | no, gitignored |
| worker secrets | keys and tokens | no, only on Cloudflare |

`pnpm deploy` merges the two config files into `wrangler.deploy.json` and deploys that
(`scripts/wrangler-config.mjs`). `wrangler.local.example.jsonc` shows every field.

Plain values in `wrangler.local.jsonc`, under `vars`:

| var | what for |
| --- | --- |
| `WEB_URL` | your worker URL, used in Telegram links |
| `GMAIL_FROM_NAME` | the name letters are signed with |
| `GMAIL_REDIRECT_URI` | `https://<your-worker>/api/gmail/callback`, only for Gmail |
| `MAIL_PROVIDER` | `gmail` (default) or `resend` |
| `CF_AI_ACCOUNT_ID`, `AI_GATEWAY_ID` | only for AI Gateway, see below |

Why these are vars in a local file rather than secrets: a deploy deletes every var that
is missing from the config, and a secret cannot take the name of an existing var. Keeping
them in a file only you have avoids both traps. Why the database id is there at all:
without it wrangler resolves the database through the D1 API on every deploy, which the
deploy token then needs permissions for.

### Secrets

Set once, survive every deploy. `cf:setup` uploads the ones it finds in `.env`; any of
them can also be set by hand with `pnpm wrangler secret put NAME`.

| secret | needed for |
| --- | --- |
| `RADAR_TOKEN` | the interface password. Without it the worker, and your contacts database, is open to anyone |
| `ANTHROPIC_API_KEY` | vacancy classification. Not needed with `LLM_PROVIDER=workers-ai` |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | the twice-weekly summary |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GMAIL_FROM_EMAIL` | sending through Gmail |
| `GMAIL_REFRESH_TOKEN` | Gmail, obtained after connecting the mailbox, see below |
| `RESEND_API_KEY` | sending through Resend instead |
| `ANTHROPIC_BASE_URL` | only for AI Gateway |

## Deploy on push with GitHub Actions

`.github/workflows/deploy.yml` deploys every push to `main`: install without scripts,
type check, build the frontend, build the deploy config, check the Cloudflare
credentials, deploy, then check the production schema.

Set in GitHub, Settings, Secrets and variables, Actions:

| name | kind | value |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | secret | dash.cloudflare.com, My Profile, API Tokens, Create Token, template **Edit Cloudflare Workers** |
| `CLOUDFLARE_ACCOUNT_ID` | secret | `pnpm wrangler whoami` |
| `WRANGLER_LOCAL_JSONC` | secret | the whole content of your `wrangler.local.jsonc` |
| `WEB_URL` | variable | your worker URL, for the schema check after deploy |

Update `WRANGLER_LOCAL_JSONC` every time you change the local file.

Not the Workers AI token from `.env` (`CF_AI_API_TOKEN`): it can run models but cannot
deploy, and wrangler answers it with `Authentication error [code: 10000]`. The workflow
checks the token before deploying and says so plainly.

**Migrations are not part of CI**, on purpose: applying a schema automatically on every
push is how production data gets damaged. After a schema change (`pnpm db:generate`),
run once from your laptop:

```bash
pnpm cf:migrate
```

If you forget, the schema check at the end of the workflow fails and says so.

## Mail on the worker

**Resend** is the simple option: an API key and a verified domain. Put `RESEND_API_KEY`
and `GMAIL_FROM_EMAIL` (an address on that domain) in secrets, `MAIL_PROVIDER: "resend"`
and `GMAIL_FROM_NAME` in `wrangler.local.jsonc`. Resend only sends, so replies are not
detected: mark them on the Outreach page by hand.

**Gmail** threads properly and lets the radar notice replies and bounces. One time:

1. Google Cloud console: a project, the Gmail API enabled, an OAuth client of type
   "Web application" with the redirect URI `https://<your-worker>/api/gmail/callback`
2. Secrets `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GMAIL_FROM_EMAIL`; in
   `wrangler.local.jsonc` the same `GMAIL_REDIRECT_URI` and `GMAIL_FROM_NAME`; deploy
3. In the interface, the "mail" status row in the sidebar has a "connect" link. Google
   sends you back to a page that shows the refresh token once
4. `pnpm wrangler secret put GMAIL_REFRESH_TOKEN` and paste it

The token is never stored in the database: a backup with it inside would be access to
your mailbox. Limits, warmup and the rest: [OUTREACH.md](OUTREACH.md).

## Telegram commands

The summary on Monday and Thursday needs only the two Telegram secrets. The read-only
bot commands (`/status`, `/queue`) need a webhook, since a worker cannot poll:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<your-worker>/api/telegram/webhook"
```

The bot cannot write first: open the chat with it and press Start once.

## Extension

In the extension popup set the radar address to `https://<your-worker>.workers.dev` and
the token to your `RADAR_TOKEN`. Companies then go straight to the worker.

## AI Gateway in front of Anthropic

Optional and free: a cache, a hard spend limit, and a log of every model call.

1. Cloudflare dashboard, AI, AI Gateway, Create Gateway, name it `job-radar`
2. Secret `ANTHROPIC_BASE_URL` = `https://gateway.ai.cloudflare.com/v1/<account-id>/job-radar/anthropic`
3. In `wrangler.local.jsonc`: `CF_AI_ACCOUNT_ID` and `AI_GATEWAY_ID`

An empty `ANTHROPIC_BASE_URL` means direct calls, so nothing breaks without a gateway.

## Workers AI

The `AI` binding in `wrangler.jsonc` needs no setup on the worker. It computes company
vectors for "find similar", and with `LLM_PROVIDER=workers-ai` it also classifies
vacancies, paid from the plan's neuron quota instead of a per-token bill.

Locally there is no binding, so it needs a token in `.env`:

```
CF_AI_ACCOUNT_ID=<account id>
CF_AI_API_TOKEN=<token with Workers AI Read and Run>
```

The names are `CF_AI_*` on purpose: wrangler reads `.env` too, and a variable named
`CLOUDFLARE_API_TOKEN` there would replace your wrangler login with a token that can
only run models.

## Moving a local database to D1

```bash
pnpm cli export:sql /tmp/data.sql --tables companies,company_state,contacts,outreach
pnpm wrangler d1 execute job-radar --remote --file=/tmp/data.sql
```

Only data, no `CREATE TABLE`, so it does not collide with migrations. Vacancies and
snapshots are left out on purpose: they are large, and the worker collects them again
within a day.

## When something breaks

**Any query fails with `Failed query: select ...`**: the remote database has no tables,
or is behind the code. `pnpm cf:migrate`, then check:

```bash
pnpm cf:doctor https://<your-worker>.workers.dev --token <RADAR_TOKEN>
```

`GET /api/health?deep=1` answers the same without a token: `migrations.behind` above zero
means the schema lags behind the code.

**`Authentication error [code: 10000]` in CI**: the wrong token in `CLOUDFLARE_API_TOKEN`,
see the Actions section.

**Build hangs on install**: `better-sqlite3` compiling. The workflow passes
`--ignore-scripts`; the worker does not need the native driver, its database is D1.

**`/api/...` shows the interface instead of JSON in the browser**: `run_worker_first`
was removed from `assets` in `wrangler.jsonc`. Without it the static fallback answers
every browser navigation, the Google callback included.

## Useful commands

| command | what it does |
| --- | --- |
| `pnpm cf:setup` | create or reuse everything and deploy |
| `pnpm deploy` | build the frontend and deploy |
| `pnpm cf:migrate` | apply migrations to D1 |
| `pnpm cf:migrate:local` | the same for the local D1 of `wrangler dev` |
| `pnpm cf:dev` | the worker locally, port 8787 (needs `RADAR_TOKEN` in `.dev.vars`: the worker refuses API calls without a token) |
| `pnpm cf:tail` | live production logs |
| `pnpm cf:doctor <url> --token <token>` | check the database and routes in production |

## Limits and cost

- `pnpm cli` works with the local SQLite database only. On the worker every action is a
  button on the Operations page.
- Heavy runs are split by cron into separate invocations, because every invocation has a
  CPU limit. The free plan's limit is much lower than the paid one's; the author runs the
  radar on Workers Paid.
- Money goes to the model: Anthropic per token, or Workers AI from the plan's quota.
  Numbers in [COSTS.md](COSTS.md).
