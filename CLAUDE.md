# CLAUDE.md: Lead Radar

An internal tool for finding clients. Not a product, not a portfolio.

The owner sells development services (sites, web apps, integrations). The radar finds
founders, small and medium businesses, agencies and studios worth writing to, keeps memory
of who was contacted and who said no, and prepares letters from the owner's own templates.

Formerly "Job Radar", a vacancy search tool. Vacancies are being removed, see section 10.
Code, package and worker names still say `job-radar`, renaming them is a separate step.

Talk to the owner in Ukrainian in chat. Code and documentation are in English: comments,
names, `.md` files. Rule 8 below.

The repository is public (MIT). Anyone can fork it and run their own copy.

---

## 0. HARD RULES

1. **NO em dashes in any text, comments, README, UI copy, letters.** Only commas, colons,
   parentheses. The mail layer strips them as a last line of defense.
2. **Every source adapter has a smoke test on a saved HTML/JSON fixture.** Without a test, an
   adapter is not considered done. Reason: scrapers break silently, return zero results and
   still look like they are working.
3. **An empty result is a failure, not a success.** If an adapter returned 0 records where it
   used to return more than zero, that is a `WARN` in the log and a red marker on the Sources
   page. Never stay silent about it.
4. **Catalogs behind Cloudflare are collected by the extension in the owner's own browser.**
   Automatic pagination is allowed, with pauses and a page limit per run. Forbidden: solving
   CAPTCHAs, forging sessions and tokens, going in under someone else's account, hitting a
   site faster than a human scrolls (pause no shorter than 3 seconds, no more than 50 pages
   per run).
5. Respect `robots.txt`, use your own User-Agent with a contact, no more than 1 request per
   domain per second. Paid or keyed APIs (Google Places, PageSpeed) are used within their
   terms and quotas.
6. **Do not make up data.** If a field did not parse, it is `null`, not a guess. This applies
   to the model too: it classifies the text it was given, it does not invent names, emails or
   numbers.
7. Secrets only in `.env` or worker secrets, never in code, never in commits, never in the
   database (the Gmail refresh token included: a database backup must not be mailbox access).
8. **English in code and documentation.** Comments, names, log messages, `.md` files.
   Ukrainian stays for chat with the owner, for letter templates, and for personal files that
   are not committed. Interface language: not decided yet.
9. **Nothing personal about the owner in the repository.** No name, email, phone, signature
   in code defaults, worker address or account ids. All of that lives in `.env`,
   `wrangler.local.jsonc` (gitignored) and the database.
10. **No automatic sending.** Every letter is sent by a human click, one at a time. No
    "autopilot", not even behind a flag. Section 7 has the full list of send guards.

---

## 1. STACK

Chosen for what the owner already knows.

- **Language:** TypeScript, Node 22, ESM
- **DB:** SQLite through Drizzle locally (`data/radar.db`), D1 on the worker. One schema
- **Runtime:** one Cloudflare Worker in production (API, UI, cron, MCP), Node locally.
  Hono runs in both
- **HTTP:** `undici` fetch, `p-limit`, `p-retry`. Parsing with `cheerio`
- **Models:** the model only classifies and extracts, it never writes letters.
  - **Clef** (Cloudflare decision models on Workers AI): the default for classification.
    Calibrated, schema-bound scores, cheap (Clef-flash about $0.04 per million input
    tokens). Used for: company segment and industry, "is this tender about software
    development", lead fit. `@cf/cloudflare/clef-omni` when an image (site screenshot)
    is part of the input. Verify exact model ids in the Workers AI catalog before wiring
  - Anthropic Haiku stays as a fallback provider behind `LLM_PROVIDER`
  - `@cf/baai/bge-m3` for company vectors ("find similar")
  - The cache is keyed by model and input hash, so providers never mix answers.
    Shared model access lives in `src/lib/llm.ts`
- **Frontend:** React + Vite + TypeScript, **Mantine** for every interface element,
  TanStack Query, `recharts`, `lucide-react`. Tailwind without preflight, layout only. No
  home-made wrapper components where Mantine already has one
- **MCP:** a remote MCP server on the same worker (section 8)
- **Mail:** Gmail API (sends and reads replies) or Resend (sends only)
- **Notifications:** Telegram through `grammY`, digest and alerts only
- **Scheduler:** Cron Triggers on the worker, `node-cron` locally. No Docker, Redis, queues
- **Logs:** `pino`

Run: `pnpm start` (API + scheduler), `pnpm dev:web`, `pnpm cli <command>`, `pnpm deploy`.
Deploy details and known traps: `DEPLOY.md`.

---

## 2. STRUCTURE

```
/src
  /db          schema.ts, migrations, client
  /sources     adapters, one file per source
    /catalogs  company sources (DOU, YC, Awwwards, Places, ...)
    /leads     demand sources (Prozorro, ...)
    registry.ts
  /pipeline    discover, enrich, audit, classify, score, dedupe, outreach, send
  /api         Hono routes
  /mcp         MCP server: tools over the same pipeline functions the API uses
  /notify      telegram.ts
  /cli         commands
  /lib         normalize, http, log, mail
/web           React application
/extension     Chrome extension for catalogs behind Cloudflare
/fixtures      saved HTML/JSON for adapter tests
/imports       manual dumps (Clutch pages, CSV)
```

---

## 3. DATA MODEL

The company is the lead. Everything hangs off it.

```ts
companies
  id, name, domain (unique when not empty; '' for a business without a site),
  registry_code (ЄДРПОУ), place_id (Google), both unique when set,
  country, city,
  kind,           // the segment: studio | design | startup | product | outstaff | smb
                  // | ecommerce | public | unknown. Tags decide the first five; smb, ecommerce
                  // and public only a source or the owner sets, and an "unknown" from tags
                  // never overwrites them
  market,         // ua | intl (derived from country, stored for fast filters)
  industry,       // clinic, dental, beauty, legal, restaurant, retail, saas, fintech, ...
  size_hint, founded_year,
  rating, reviews_count, min_project, hourly_rate,  // catalog reputation
  extra,          // label-value pairs from a catalog with no column of their own
  phone, address,                                   // UA businesses
  sources: string[], tags: string[],
  tech_hints: string[],  // Next.js, WordPress, Tilda, Wix, Prom, Horoshop, ...
  hiring_devs, hiring_roles, hiring_seen_at,
                         // the only thing kept from vacancies; fades after 45 days
  copyright_year, last_post_at,
  first_seen, last_checked

site_audits      // the reason to write, see section 5
  company_id, checked_at, https, mobile_ok, perf_score, lcp_ms, cms,
  copyright_year, issues: string[], screenshot_url

leads            // explicit demand: a tender, a funding round, a public request
  id, company_id, source, external_id, url, title, text, budget, currency,
  deadline_at, first_seen, closed_at, fit (model score), status

company_state    company_id, status, updated_at, reason
  // new | interesting | contacted | replied | rejected_by_me | rejected_by_them
  // | blacklist | snoozed_until

contacts         id, company_id, name, role, email, phone, telegram, linkedin, source_url,
                 dead (hard bounce)

outreach         id, company_id, lead_id, contact_id, template_used, subject_final,
                 body_final, status, sent_at, reply_at, reply_type, followup_of, ...
                 // contact and template are snapshots: history must stay readable

templates        id, slug, name, kind, for_kind (segment), target_type, language, subject,
                 body, archived

saved_filters    id, name, query (json)   // "UA, SMB, slow site, has email"

runs, settings, send_log, llm_cache, llm_usage
```

Nothing is deleted, rejected records included. `vacancies`, `queue_items`, `snapshots`,
`facts` and `templates.intro` stay in the database as an archive; no code writes them.

---

## 4. SOURCES

### Ukraine (priority)
- **Prozorro** (public API, no key): tenders with CPV 72xxxxxx and words like "веб-сайт",
  "портал", "розробка". The buyer is the lead, the tender is a `leads` row with a deadline.
  Suppliers who win such tenders are agencies: potential subcontracting partners
- **Google Places API** (key, free monthly quota): businesses by niche and city (dental,
  clinics, beauty, legal, repair, restaurants, retail) with their site and phone. Every one
  with a site goes through the site audit
- **Freelance marketplaces are out** (Freelancehunt, Upwork, Fiverr): bidding platforms do
  not fit the positioning, and the owner's reasons are in `CLAUDE.local.md`
- **DOU** companies (exists), extended past IT categories
- Later: AIN.ua and dev.ua funding news (founders with fresh money), Brave1 and Ukrainian
  Startup Fund catalogs, Prom.ua stores with their own site, the state register by KVED for
  the director's name

### International
- YC, HN "Who is hiring" (exist): founders and small startups
- Clutch, GoodFirms, DesignRush, Sortlist, TechBehemoths via the extension; Awwwards (exists):
  agencies and studios for white-label work
- Later: Product Hunt launches, BetaList, funding news RSS

How each one works, and the traps:
- **Prozorro** (`src/sources/leads/prozorro.ts`): the official API cannot filter by CPV, so the
  prozorro.gov.ua search (POST, exact CPV codes) finds open tenders, a title filter drops
  licences and support, then the site summary gives the internal id and the official API the
  buyer's ЄДРПОУ and contact person. Daily
- **Google Places** (`src/sources/catalogs/places.ts`): Text Search, niches and cities in
  `config/places.json`, a few queries per run rotated, a monthly call cap. Weekly, off without
  `GOOGLE_PLACES_API_KEY`. A social profile is not a site. The fixture is made up from the
  documented shape, replace it with a recorded one once the key exists
- **Funding news** (`src/sources/leads/funding.ts`): AIN.ua forbids its RSS in robots.txt, so
  its investments section page is read; dev.ua RSS, Ukrainian news only. A news lead has no
  company until the owner (or the model in stage 5) names it. Daily

A company without a site has `domain = ''` and is identified by `registry_code` or `place_id`.
`domain` stays NOT NULL on purpose: making it nullable rebuilds the table, and on D1 a rebuild
cascades deletes into every child table. Anything that crawls must skip an empty domain:
`enrich({ domain: '' })` would otherwise pick companies on its own.

### Signal, not a source
ATS boards (Greenhouse, Lever, Ashby) and DOU vacancies only set `hiring_devs` on a known
company. No vacancy queue, no vacancy classification.

---

## 5. ENRICHMENT AND SITE AUDIT

For every company with a domain:
- **Stack hints** from HTML: `_next` Next.js, `__NUXT__` Nuxt, `wp-content` WordPress,
  `data-astro` Astro, Tilda, Wix, Prom, Horoshop markers
- **Liveness:** copyright year, last blog post date
- **Contacts:** names with titles from `/team`, `/about`, `/contacts` (CEO, founder, owner,
  director, CTO, marketing). A named contact is worth more than `info@`, the UI shows it first
- **Audit** (PageSpeed Insights API, free key): performance score, LCP, mobile, HTTPS. Plus a
  small list of concrete issues ("no mobile version", "loads 9 s on a phone", "copyright
  2019"). Issues feed the `{{finding}}` placeholder of a letter and the lead score

How the audit works (`src/pipeline/audit.ts`, `pnpm cli audit`, every 6 hours in a small batch):
one PageSpeed call per site, mobile, on `http://domain` so the final URL shows the https
redirect. Copyright year and platform come from enrichment, not a second crawl. Issues are
letter-ready phrases in the company's letter language, most convincing first, and only from
measured fields. Traps: the keyless PageSpeed quota is zero, so no key means the audit is off;
the key goes in the `x-goog-api-key` header, a failed URL lands in `runs`; a page Lighthouse
could not load gets an empty audit row so it waits 90 days instead of heading every batch;
a 429 or 403 stops the run. The success fixtures are made up, replace them with recorded ones.

A business with no site at all is also a lead ("you have no site"), as long as it has a
phone or an email.

---

## 6. SCORING AND FILTERS

Scoring is deterministic code, weights in `config/scoring.json` and the `settings` table
(editable from the Rules page and over MCP). The model contributes a classification, not a
verdict.

- Segment and industry fit (owner's chosen niches score higher)
- Site audit: a bad site is a plus (there is something to sell), a fresh Next.js site is a minus
- Explicit demand (`leads` row open, deadline in the future) is a big plus
- Named contact with email: plus. No way to reach: excluded from the queue
- Reputation for agencies: rating, reviews
- Blacklist and recent contact: excluded entirely

**Filters** on the Companies page and in MCP use one query shape: market, country, city,
segment, industry, source, tags, status, has email, has named contact, has site, audit
issues, score range, hiring signal, text search. Any combination can be saved as a named
filter.

**Queue:** a short daily list (`queue.size` in the rules, default 10), round robin across
segments, one card per company, only companies with a valid email or a phone
(`src/pipeline/daily-queue.ts`). Do not show `contacted` (unless older than 90 days),
`replied`, `rejected_*`, `blacklist`, active `snoozed_until`.

The filter shape lives in `src/pipeline/filters.ts` (Zod schema, URL form, SQL). The
Companies page, Leads, CSV export, saved filters and `search_companies` all go through it.

---

## 7. OUTREACH

Templates are written by the owner. **The model never writes or rewrites letter text.**
The AI first paragraph and the `facts` table are being removed.

**Placeholders:** `{{company}}`, `{{name}}`, `{{first_name}}`, `{{city}}`, `{{site}}`,
`{{industry}}`, `{{finding}}`, `{{lead_title}}`, `{{signature}}`, with a fallback form
`{{first_name|колеги}}`. A placeholder with no value and no fallback blocks the draft: a
letter saying "Привіт, ," must never exist.

Template choice is deterministic: by segment, by language (UA company means `uk`), by
whether there is a named contact or an open lead.

**Send guards** (`src/pipeline/send-guards.ts`, one function and one test each):
- daily limit is a constant in code (`DAILY_SEND_LIMIT`), warmup 5, then 10, then 20
- at least 3 minutes between letters
- only 08:00 to 22:00 local time, no weekends
- no second letter to a company sooner than 90 days, never to blacklist or rejected
- never to an address that hard bounced; stop everything when bounces exceed 3 percent
  over the last 50 letters
- no unfilled placeholder, at most 160 words, at most one link, no signature means blocked
- exactly one follow-up, 7 to 9 days later, same thread (`In-Reply-To`, `References`)
- atomic claim of a draft before delivery, so a double click never sends twice
- `text/plain` only, no tracking pixels, no shorteners, no UTM, no attachments

Cyrillic in subject and body has a dedicated encoding test, broken encoding is only visible
to the recipient.

---

## 8. MCP

A remote MCP server on the worker, so the owner can work with the radar from Claude Code,
claude.ai and Claude Desktop.

- Transport: streamable HTTP at `/mcp`
- Auth: OAuth for claude.ai and Desktop custom connectors (`workers-oauth-provider`), the
  `RADAR_TOKEN` bearer for Claude Code. Fails closed without a token
- Tools call the same pipeline functions as the API, no second implementation:
  `search_companies` (the filter shape from section 6), `get_company`, `set_status`,
  `add_note`, `add_contact`, `list_templates`, `get_template`, `upsert_template`,
  `preview_letter`, `create_draft`, `list_outreach`, `get_settings`, `update_settings`,
  `list_saved_filters`, `save_filter`, `daily_queue`, `list_leads`, `set_lead_status`,
  `run_source`, `stats`
- **No `send` tool.** Sending stays a human click in the web app (rule 10)
- Stateless: a fresh server per request, JSON answers, no sessions (`src/mcp/route.ts`).
  Notes from `add_note` are dated lines appended to `company_state.reason`.
  OAuth (`src/mcp/oauth.ts`, worker only, grants in `OAUTH_KV`): the consent page asks for
  `RADAR_TOKEN`, which is the only sign-in; Claude Code sends `RADAR_TOKEN` as the bearer.
  Locally `/mcp` takes only the bearer, and stays closed without a token.
  `search_companies` takes the section 6 filter plus `savedFilter`, `scope` (leads | all), `limit`
- Every write tool returns what changed, so the chat shows the diff

---

## 9. FRONTEND

Local `localhost:5173` or the worker URL with `RADAR_TOKEN`.

Pages: **Leads** (scored list with filters, route `studios` for now), **Startups**,
**Companies** (table, filters, saved filters, bulk status and tags, company card with audit,
contacts, leads, letter history), **Tenders** (open leads by deadline, funding news), **Sending** (drafts, daily counter, timer), **Outreach** (history,
replies, follow-ups), **Templates**, **Rules**, **Sources** (adapter health, run now),
**Operations**.

Style: dense, dark, no animations, no half-screen empty states. A redesign is planned as the
last stage.

---

## 10. ROADMAP

Work in stages, show the result after each one, do not start the next one without the
owner's confirmation.

1. ~~**Cleanup.**~~ Done 2026-10-20: vacancy pipeline, queue and stats removed, boards only
   feed companies and `hiring_devs`; AI paragraph and facts removed, placeholders with
   fallbacks; migration 0018 adds `market`, `industry`, `phone`, `address`, the hiring
   columns, `site_audits`, `leads`, `saved_filters`, `outreach.lead_id`
2. ~~**MCP**~~ Done 2026-10-21: 15 tools on the worker, bearer `RADAR_TOKEN` for Claude
   Code, OAuth for claude.ai and Desktop
3. ~~**Filters and the Companies page**~~ Done 2026-10-21: one filter shape for UI, export
   and MCP, saved filters, facets, bulk status and tags, daily slice on Leads (Today)
4. ~~**Ukrainian sources**~~ Done 2026-10-22: `prozorro`, `places`, `ain`, `devua` with
   fixture tests, a `lead` source kind, companies without a site (migration 0019: `registry_code`,
   `place_id`, `contacts.phone`, countries as ISO codes), Tenders page
5. **Site audit and lead scoring**, Clef for segment, industry and lead fit
6. **Design pass**
7. Later: Product Hunt, Brave1 and USF catalogs, state register, renaming the project

Open items carried over: send window and day boundary follow `TZ` instead of a hardcoded
Kyiv; worker crons are fixed UTC (digest shifts an hour after DST ends); the frontend was
never audited in a browser on empty data.

---

## 11. DECISIONS AND TRAPS

- **Fork, not a service.** The schema has no users, the mail tokens are the owner's, the
  send guards protect one person's sender reputation. Others fork and run their own copy
- **Scoring in code, lists in config.** Weights change weekly, a change must not be a release
- **Free filters before the model.** A model call happens only on what survives the
  deterministic filters; measured earlier, ordering alone cut calls by 85 percent
- **Daily slice is fixed.** The queue does not reshuffle under the owner's hands; unreviewed
  cards roll over to the next day first
- **A card action never downgrades** a contacted or replied company back to interesting
- **`run_worker_first: ["/api/*", "/mcp", "/.well-known/*"]`** in `wrangler.jsonc` is
  required, otherwise browser navigation there (the Gmail callback, the MCP OAuth flow and
  its discovery documents) gets the SPA instead
- **`CLOUDFLARE_API_TOKEN` in `.env` hijacks wrangler.** The radar's own variables are
  `CF_AI_ACCOUNT_ID` and `CF_AI_API_TOKEN` for that reason
- **CI installs with `--ignore-scripts`**, the worker does not need `better-sqlite3`
- **Migrations are never applied by CI.** `pnpm cf:migrate` by hand; `/api/health?deep=1`
  and the post-deploy CI step catch a schema behind the code
- **AI Gateway with authentication on** rejects every call with 401 unless
  `AI_GATEWAY_TOKEN` is set. `pnpm cli llm:ping` checks it
- **D1 parameter limit:** big `in (...)` lists go through `src/lib/chunk.ts`
- **Worker subrequest limit:** heavy runs are split across cron invocations and rotated

---

## 12. WHAT NOT TO DO

- No authorization beyond the single token, no multi-user, no roles
- No Docker, Redis, queues, microservices
- No letter generation by a model, in any form
- No automatic sending, no HTML letters, no open tracking, no attachments in cold letters
- No LinkedIn source (unavailable, see `CLAUDE.local.md`)
- No source without a fixture test
- No analytics beyond what the pages above need

## 13. ABOUT THE OWNER

The owner's profile (stack, services, niches, city, languages) lives in `CLAUDE.local.md`,
not committed. In a fork that is your own profile, and the weights in
`config/scoring.json` or on the Rules page are tuned to it.
