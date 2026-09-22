# Job Radar

A local job search tool. Rules and boundaries of the project: `CLAUDE.md`.

Built for a single owner: your own database, your own mailbox, your own model key. If
you cloned this repo for yourself, start with [FORK.md](FORK.md): it lists what needs
to be rewritten for you, and what happens if you skip that.

## Two modes

**Deployed worker.** Address is different for everyone. First entry with a token:
`https://<your-worker>/?token=<RADAR_TOKEN>`, after that the token lives in the browser.

| mode | when | how |
| --- | --- | --- |
| local | development, debugging adapters | `pnpm start` plus `pnpm dev:web` |
| Cloudflare | daily use, access from the phone, cron without a laptop | `pnpm deploy`, details in `DEPLOY.md` |

Same code either way: Hono works both in Node and on Workers, the Drizzle schema is the
same for SQLite and D1. The native driver `better-sqlite3` lives separately in
`db/client.node.ts`, so it does not end up in the worker bundle.

## Quick start

```bash
pnpm install
cp .env.example .env        # fill in ANTHROPIC_API_KEY and USER_AGENT_CONTACT
pnpm start                  # migrations, API on :3000, scheduler
pnpm dev:web                # interface on :5173, in another terminal
```

Then open `http://localhost:5173`. If the database is empty, you can fill it like this:

```bash
pnpm cli import:csv imports/seed-companies.csv   # 10 companies with known ATS
pnpm cli source:sync greenhouse                  # fetch vacancies and classify
pnpm cli source:sync ashby
pnpm cli catalog:dou -n 40 --business "Tech Product,Startup"
pnpm cli discover -n 25                          # career pages for the rest
pnpm cli queue                                   # the same thing the web sees
```

## Commands

| Command | What it does |
| --- | --- |
| `pnpm start` | API and scheduler in one process |
| `pnpm dev` | the same, restarting on changes |
| `pnpm dev:web` | interface on `localhost:5173`, `/api` proxies to 3000 |
| `pnpm test` | tests |
| `pnpm typecheck` | type checking |
| `pnpm db:generate` | generate a migration after changing `src/db/schema.ts` |
| `pnpm db:migrate` | apply migrations |

### CLI

| Command | What it does |
| --- | --- |
| `pnpm cli db:stats` | how many records are in each table |
| `pnpm cli sources:list` | list of adapters |
| `pnpm cli source:run <id>` | run an adapter and show what it found, without writing |
| `pnpm cli source:sync <id>` | fetch, classify and save (`--skip-llm`, `--no-detail`) |
| `pnpm cli companies:add <domain>` | add a company (`--ats`, `--slug`) |
| `pnpm cli import:csv <files...>` | import companies from a CSV |
| `pnpm cli import:clutch <files...>` | import saved Clutch or TechBehemoths pages |
| `pnpm cli bookmarklet` | bookmarklet code that collects a catalog straight from the open page |
| `pnpm cli catalog:dou` | collect companies from DOU (`--business`, `--domains`, `-n`) |
| `pnpm cli discover` | find career pages and stack (`--domain`, `--all`) |
| `pnpm cli classify:pending` | catch up classification on vacancies missing it |
| `pnpm cli queue` | today's vacancy queue |
| `pnpm cli studios` | queue of studios and agencies (`--min`, `--country`, `-q`, `--all`) |
| `pnpm cli score:explain <vacancy\|company> <id>` | breakdown of the score by points |
| `pnpm cli score:recalc` | recalculate after changing `config/scoring.json` |
| `pnpm cli stats` | top technologies, salary ranges, lifetime, funnel |
| `pnpm cli page:normalize <file or URL>` | what remains of a page after cleanup |
| `pnpm cli page:check <domain> [url]` | snapshot of a career page and a diff against the previous one |
| `pnpm cli notify:check` | check the Telegram connection and show the chat_id |
| `pnpm cli notify <kind>` | `digest`, `highscore`, `followups`, `broken`, `test` (`--dry`) |
| `pnpm cli llm:budget` | how many model calls are left for today |
| `pnpm cli runs:last` | latest adapter runs |

## Vacancy sources

| id | what it is | needs a slug |
| --- | --- | --- |
| `greenhouse` | `boards-api.greenhouse.io`, JSON | yes |
| `lever` | `api.lever.co`, JSON | yes |
| `ashby` | `api.ashbyhq.com/posting-api`, JSON | yes |
| `remoteok` | `remoteok.com/api`, JSON (their RSS returns 410) | no |
| `rss:weworkremotely` | Front-End Programming feed | no |
| `rss:himalayas` | general vacancy feed | no |
| `rss:remotive` | general vacancy feed | no |

## Catalog collector: Chrome extension

No need to download pages by hand. `extension/` is an extension: `chrome://extensions`,
developer mode, "Load unpacked", pick the `extension` folder from this project. Then just
browse the catalog, every opened page collects itself. Details: `extension/README.md`.

**Right after installing, open the popup and fill in your API address**, for example
`http://localhost:3000`, and if `RADAR_TOKEN` is set, that too. The defaults currently
point at the author's own worker address, and until you change it the companies you
collect go to someone else, silently: the popup will show "connected" and growing
counters, because the other server really does respond. This is a known problem,
described in [FORK.md](FORK.md).

Supported catalogs: Clutch, GoodFirms, DesignRush, Sortlist, The Manifest, UpCity,
TechBehemoths, DOU. An unrecognized catalog is parsed through JSON-LD.

Alternative without installing anything: `pnpm cli bookmarklet` prints bookmarklet code
with the same logic.

```
Job Radar: 80 on the page, 79 with a domain
12 new, 67 updated, 1 without a domain
```

Why a collector rather than a scraper: Clutch, GoodFirms, DesignRush, Sortlist and
TechBehemoths sit behind Cloudflare and serve a challenge even on `robots.txt`.
Bypassing that is forbidden by rule 4 in `CLAUDE.md`. But a page you already opened
in your own browser is parsed by the browser itself, and there is nothing to bypass.
The collector knows the card markup of Clutch and similar sites, and if it does not
recognize one, it falls back to the JSON-LD `ItemList` that most catalogs emit.

## Company catalogs

| source | mode | why |
| --- | --- | --- |
| DOU | automatic, `catalog:dou` | open HTML, `robots.txt` allows it |
| Clutch | manual import of saved pages | Cloudflare with bot detection |
| TechBehemoths | browser collector | serves a Cloudflare challenge even on `robots.txt` |
| GoodFirms, DesignRush, Sortlist, The Manifest, UpCity | browser collector | same thing, 403 on any request |
| Wadline, Awwwards | not yet | data is rendered client-side, no company domain in the HTML |

DOU shows 20 companies per page, and the "more" button is a POST with a CSRF token.
Instead of simulating a session, we go around it via combinations of filters
(`business` and `domain`). Domain, size and city sit on the company page, so the
second step walks profiles with a one-second pause.

Clutch hides the domain in the `u` parameter of the `r.clutch.co` redirect. If no
cards were recognized in a file, that is an error in the report, not a silent zero.

## Change detection

- **ATS** sources give stable `external_id`s, so appearance and closure are counted by
  comparing sets of ids (`diffByExternalId`). No need to hash the text.
- **Own career pages** go through normalization (`pipeline/normalize.ts`), a block diff
  (`pipeline/diff.ts`) and a snapshot write (`pipeline/snapshots.ts`), no more than five
  per company.

Fixtures for the diff: `fixtures/careers/acme-v1.html`, `acme-v1-noise.html` (the same
set of vacancies, different dates, counters, build hashes), `acme-v2.html` (minus one,
plus one). The test requires that the noisy version produce the same hash.

## Selection settings

All lists and weights live in `config/scoring.json`, no need to touch the code. The
file is re-read on the fly (no more often than every 5 seconds), and after editing it
you need to recalculate the scores:

```bash
pnpm cli score:recalc                  # recalculate everything with the new rules
pnpm cli score:explain vacancy 123     # why exactly this score
pnpm cli score:explain company 45
```

What is configurable there:

| section | why |
| --- | --- |
| `roleGate` | the vacancy title has to be an engineering one. Without this, "Sr. Manager, Accounting" scores points from the company description text where React and Next.js are mentioned |
| `geo` | Kyiv, relocation is not possible. "Remote (US)", "San Francisco, hybrid" and any location naming a place with no sign of being remote gets filtered out, no matter what the remote flag says |
| `experience` | 5+ years is -4, 7+ is -8, a lead title is separate |
| `stopWords` | technologies and fields that are not needed |
| `weights` | weights for technologies. The title weighs three times as much, points from the text are capped at `bodyCap` |
| `companies` | scoring for studios: size, services, site stack, country, rate |

## How much the model costs

Classification runs on Haiku. Deterministic filters (stop words, role, geo, company
size) run BEFORE the model call, so we only pay for what has a chance of making it
into the queue. Numbers, causes and what can still be squeezed: `COSTS.md`.

## Classification and scoring

1. Stop words on the block's short text, before any network call
2. Loading the full vacancy page, if the block is shorter than 400 characters
3. Stop words again on the full text
4. LLM (`claude-haiku-4-5-20251001`), strict JSON, Zod, one retry, then `needs_review`
5. Deterministic scoring in code, `score = sum of weights + llm_relevance / 20`

Cache in `llm_cache` keyed by the hash of the text that went into the model. Daily
ceiling in `LLM_DAILY_CALL_LIMIT`, counter in `llm_usage`. Everything below
`SCORE_THRESHOLD` stays in the database, it just is not shown in the queue.
Vacancies are never deleted, closed ones get `closed_at`.

## Interface

Pages: **Queue** (vacancies), **Studios** (who to pitch services to), **Companies**,
**Contacts**, **Statistics**, **Sources**.

**Studios** is a separate queue from vacancies: a small agency does not need a
vacancy, it needs a contractor. The score is computed from size (10 to 49 is best),
service profile (web development and design are a plus, SEO and advertising are a
minus), site stack (React and Next.js are a plus, WordPress is a minus), country and
rate. The "Why this score" button shows the breakdown by points.

The queue is a fixed daily snapshot in `queue_items`, not a live query: without
fixing it, a new vacancy with a higher score would push out one you have not gotten
to yet. A decision removes the card, and the slot is not reassigned until the next
day. What was shown in the last 30 days does not return to the snapshot.

## Telegram and schedule

Telegram is only for alerts and reminders, there is no state management there on
purpose.

| when | what |
| --- | --- |
| every 6 hours | ATS and RSS, catch-up classification |
| Monday 04:00 | DOU catalog |
| Tuesday 05:00 | career page discovery |
| Mon and Thu 10:00 | one Telegram digest: queue, finds with score 12+, drafts, follow-ups, broken sources |

The bot cannot message first: you have to open a chat with it and press Start first,
otherwise Telegram returns `chat not found`. Check with: `pnpm cli notify:check`.

Bot commands (read only, actions happen in the web app): `/help` describes the whole
system, `/status` what is in the database right now, `/queue` top cards,
`/followups` who is due for a reminder. Polling is switched off with the
`TELEGRAM_BOT=off` variable.

If `pnpm start` says `EADDRINUSE`, an old process is still running somewhere:

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN     # see who
kill $(lsof -t -iTCP:3000 -sTCP:LISTEN)
API_PORT=3001 pnpm start             # or just a different port
```

## When something stops working

The first thing to check is whether the database has fallen behind the code:

```
http://localhost:3000/api/health?deep=1
```

A `migrations.behind` field above zero means the code is newer than the schema, and
pages will fail at the first new column. Fixed by `pnpm db:migrate` locally or
`pnpm cf:migrate` on the worker. `pnpm start` and `pnpm dev:api` apply migrations
themselves, so falling behind mostly happens on the deployed instance.

## Stage status

- [x] Stage 1: scaffolding, database, schema, `lib/http`, `lib/log`, CLI, tests
- [x] Stage 2: ATS adapters (Greenhouse, Lever, Ashby), RemoteOK, RSS feeds
- [x] Stage 3: normalization, block diff, snapshots
- [x] Stage 4: LLM classification, Zod validation, scoring, dedup
- [x] Stage 5: Hono API, frontend (Queue, Companies, Contacts)
- [x] Stage 6: company catalogs (DOU, manual Clutch import)
- [x] Stage 7: Statistics, Sources, discovery, Telegram, cron
