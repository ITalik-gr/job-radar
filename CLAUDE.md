# CLAUDE.md: Job Radar

An internal tool for job hunting. Not a product, not a portfolio.
Goal: every day, give a short list of relevant vacancies and companies worth writing to,
with memory of who has already been contacted and who was turned down.

Talk to the owner in Ukrainian in chat. Code and documentation are in English:
comments, names, `.md` files. Rule 8 below.

The project is getting ready for publication, branch `oss`. The plan and the list of what
still gets in the way: `FORK.md`.

---

## 0. HARD RULES

1. **NO em dashes in any text, comments, README, UI copy.** Only commas, colons, parentheses.
2. **Every source adapter has a smoke test on a saved HTML/JSON fixture.** Without a test, an
   adapter is not considered done. Reason: scrapers break silently, return zero results and
   still look like they are working.
3. **An empty result is a failure, not a success.** If an adapter returned 0 records where it
   used to return more than zero, that is a `WARN` in the log and a marker in the UI. Never
   stay silent about it.
4. **Catalogs are collected by an extension in the owner's own browser.** Pages are opened by
   a real Chrome profile, parsed by its content script, and the data goes into the database.
   Automatic pagination is allowed, with pauses and a page limit per run. What stays
   forbidden: solving CAPTCHAs, forging sessions and tokens, going in under someone else's
   account, hitting the site faster than a human scrolls (pause no shorter than 3 seconds, no
   more than 50 pages per run).
5. Respect `robots.txt`, use your own User-Agent with a contact, no more than 1 request per
   domain per second.
6. Do not make up data. If a field did not parse, it is `null`, not a guess.
7. Secrets only in `.env`, never in code and never in commits.
8. **English in code and documentation.** Comments, variable and function names, error
   messages in logs, `.md` files. Reason: the repository will be public, and code commented
   in a language the reader does not know is code with no comments at all. Ukrainian stays
   for the conversation with the owner in chat and for personal files that are not committed.
   Interface language is a separate question, it is in `FORK.md`, and it is not resolved yet.
9. **Nothing personal about the owner in the repository.** No name, no email, no phone, no
   signature in code defaults, no address of their worker. All of that is config and `.env`.
   Personal files (`DEV_CONTEXT.md` and the like) live outside git.

---

## 1. STACK

Chosen for what the owner already knows, so they can read and fix the code quickly.

- **Language:** TypeScript, Node 22, ESM
- **DB:** SQLite through Drizzle ORM (file `data/radar.db`). The schema is written so it can
  later move to Postgres without a rewrite
- **HTTP:** `undici` fetch, `p-limit` for concurrency, `p-retry` for retries
- **Parsing:** `cheerio` by default. `playwright` only where the page is empty without JS,
  and that has to be explicitly marked in the adapter's config
- **LLM:** Anthropic API, model `claude-haiku-4-5-20251001`, only for text classification.
  Alternative, turned on with `LLM_PROVIDER=workers-ai`: Cloudflare Workers AI
  (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`). Same prompt, same Zod schema, but the cost
  comes out of neurons on an already paid plan, not tokens. The cache is keyed by the model,
  so the two providers' answers do not mix. Company vectors for similarity search always run
  on Workers AI (`@cf/baai/bge-m3`)
- **Backend API:** Hono (the same one the owner uses in other projects)
- **Frontend:** React + Vite + TypeScript, components from **Mantine** (`@mantine/core`,
  `hooks`, `notifications`), charts with `recharts`, icons `lucide-react`, TanStack Query.
  Tailwind is wired in without preflight and used only for page layout: style reset and all
  interface elements come from Mantine. Do not write your own wrapper components while
  Mantine already has what is needed
- **Notifications:** Telegram through `grammY`, only reminders and alerts, not the main
  interface
- **Scheduler:** `node-cron` inside the process. No Docker, no Redis, no queues at this stage
- **Logs:** `pino`, to a file and to the console

Run with: `pnpm dev:api`, `pnpm dev:web`, `pnpm cli <command>`.

---

## 2. STRUCTURE

```
/src
  /db          schema.ts, migrations, client
  /sources     adapters, one file per source
    /catalogs  company sources
    /boards    vacancy sources
    registry.ts
  /pipeline    discover.ts, crawl.ts, diff.ts, classify.ts, score.ts, dedupe.ts
  /api         Hono routes
  /notify      telegram.ts
  /cli         commands
  /lib         normalize.ts, http.ts, log.ts
/web           React application
/fixtures      saved HTML/JSON for adapter tests
/imports       manual dumps (Clutch, etc.)
/data          radar.db
```

---

## 3. DATA SCHEMA

Two speeds of life: a company lives for years, a vacancy for days. Do not mix them.

```ts
companies
  id, name, domain (unique), country, city, size_hint,
  rating, reviews_count, min_project, hourly_rate, founded_year,
  extra,                      // "Other" block: label-value pairs from the catalog
                              // that have no column of their own. Scoring does not read it
  kind,                       // studio | design | startup | product | outstaff | unknown
  copyright_year, last_post_at, // signs of a site being alive, collected by enrichment
  sources: string[],          // which catalogs it came from
  careers_url, careers_kind,  // html | greenhouse | lever | rss | none
  tech_hints: string[],       // from heuristics over the site's HTML
  first_seen, last_checked, last_change_at

company_state
  company_id (unique), status, updated_at, reason
  // status: new | interesting | contacted | replied | rejected_by_me
  //         | rejected_by_them | blacklist | snoozed_until

contacts
  id, company_id, name, role, email, telegram, x_handle, linkedin, source_url

snapshots
  id, company_id, url, fetched_at, content_hash, text_normalized
  // only the last 5 per company, older ones are cleaned up

vacancies
  id, company_id, source, external_id, url, title, raw_text,
  stack: string[], seniority, remote, location,
  salary_min, salary_max, currency,
  first_seen, last_seen, closed_at,
  llm_relevance, score, dedupe_key

outreach
  id, company_id, vacancy_id, channel, sent_at,
  template_used, contact_name, contact_email, reply_at, reply_type, note
  // contact_* is a snapshot at the moment of the letter, not a link to contacts:
  // a contact can disappear from the site, but the history has to stay readable

runs
  id, started_at, finished_at, source, items_found, items_new, errors, status

settings
  key (unique), value (json), updated_at
  // rule edits from the interface. Override config/scoring.json.
  // Needed because Workers has no filesystem and the config is baked into the bundle

templates
  id, slug (unique), name, kind, for_kind, subject, body, note, archived,
  created_at, updated_at
  // kind: vacancy | studio | resume, decides where the template is offered
  // for_kind: which company type the text is aimed at. Empty means universal
  // slug lands in outreach.template_used as a snapshot at the moment of the letter. It does
  // not change by itself when the name is renamed, but an explicit edit of the key rewrites
  // the history too, so it never ends up pointing at nothing
  // Deleting a template erases the row, the history stays readable with the same snapshot
```

**Why `last_seen` and `closed_at` are critical:** the difference from `first_seen` gives the
vacancy's lifetime. A vacancy that hangs around for more than 120 days without closing is
likely a ghost job. This is a future dataset for a separate product of the owner's, so the
data is never deleted, not even rejected records.

---

## 4. SOURCES

Implement strictly in this order. Each next one only after the previous one has a test and
works.

### Priority 1: structured, do not break
- **Greenhouse:** `https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true`, clean
  JSON
- **Lever:** `https://api.lever.co/v0/postings/{slug}?mode=json`, clean JSON
- **Ashby:** public GraphQL/JSON endpoint by slug
- **Workable, Recruitee, Personio:** have predictable JSON routes
- **RSS feeds:** RemoteOK, WeWorkRemotely, Remotive, Himalayas

This gives the most coverage for the least effort. If a company's career page is a redirect
to one of these ATSes, we extract the slug and from then on work only through the API, the
HTML is left alone.

### Priority 2: company catalogs
- `dou.ua/companies`, the lightest and most relevant
- TechBehemoths, GoodFirms, DesignRush, Sortlist
- YC companies (public JSON)
- Wellfound
- **Awwwards** is wired in as the `awwwards` catalog. robots allows `/directory/`, but
  disallows search and `/websites/?`, so we only go to the catalog and to profiles. The
  studio's domain sits three levels down: catalog, profile, site
- Dribbble teams (design studios, often hiring frontend)

### Priority 3: vacancy boards
- Djinni, DOU (stable HTML). Both are wired in as **vacancy boards**: `djinni` and
  `dou:vacancies`. DOU's company catalog stays a separate source, `dou`
- **Getro**, the engine behind accelerator and fund boards. One adapter opens eight networks
  (Techstars, Accel, Lerer Hippeau, Craft Ventures, Uncork, Greycroft, Primary, Underscore).
  The list renders client side, but **search runs server side**, so we use narrow queries like
  `?q=frontend`. The company's domain is fetched with a separate request to the company page
- Otta

### Priority 4: companies' own career pages
For companies without an ATS. Discovery tries, in order: `/careers`, `/career`, `/jobs`,
`/vacancies`, `/join-us`, `/join`, `/work-with-us`, `/team/careers`, plus parsing the footer
and header for links whose text or href contains career/job/vacanc/join. Once a working URL is
found, it is saved in `careers_url`, no need to try again after that.

### Clutch and the rest of the catalogs behind Cloudflare
Clutch, GoodFirms, DesignRush, Sortlist, The Manifest, UpCity and TechBehemoths block server
requests. The working mode: the `extension/` extension in the owner's browser.

1. The owner opens the catalog in their own Chrome
2. The content script parses the visible page and sends companies to the API
3. Auto-crawl walks pagination on its own with pauses, until the pages or the limit run out
4. Duplicates by domain are merged into existing companies instead of creating new ones

Fallback paths still exist: `pnpm cli import:clutch ./imports/clutch/*.html` for saved pages
and `pnpm cli import:csv` for any list.

The same importer has to handle CSV with the columns `name,domain,country,note`, so any list
can be dropped in by hand.

---

## 5. PIPELINE

### 5.1 Normalization (the most important place in the project)

Before hashing, the page text is cleaned. If this is done poorly, the hash will change every
day and the system will drown in false notifications. This is the main reason such projects
die.

To strip:
- `<script>`, `<style>`, `<svg>`, `<noscript>`, comments
- dates and times in any format, relative time ("2 days ago", "just now")
- view counters, applicant counters, "N people applied"
- CSRF tokens, nonces, random hashes in attributes and classes
- cookie banners, chat widgets, footer with copyright and year
- query parameters in links (utm, ref, gh_src)

Then: `toLowerCase`, collapse whitespace, drop empty lines, no need to sort anything.

### 5.2 Block diff

A hash of the whole page says "something changed" but not what. So:

1. Pick out candidate blocks: list items, cards, links with a job-like href
2. Hash each block separately
3. Compare the set of hashes to the previous snapshot
4. New hashes mean new vacancies, missing ones mean closed ones (`closed_at = now`)

This gives vacancies appearing and closing with no separate logic needed.

### 5.3 Classification

The LLM is called **only on new or changed blocks**. Never on the whole page, never twice.

The prompt requires strict JSON, no preamble and no markdown fence:

```json
{
  "is_vacancy": true,
  "title": "Senior Frontend Developer",
  "stack": ["react", "typescript", "next.js"],
  "seniority": "senior",
  "remote": true,
  "location": "Berlin, hybrid",
  "salary_min": null,
  "salary_max": null,
  "currency": null,
  "english_level_required": "B2",
  "relevance": 0,
  "why": "one sentence in English"
}
```

Rules:
- The model classifies only the text it was given. It does not make anything up
- What is not in the text is `null`. Do not guess the pay range, do not guess the location
- The response is parsed with Zod. An invalid JSON means one retry, then a record with
  `is_vacancy: null` and a mark for manual review
- `relevance` is the model's opinion, it is **not** the final score

### 5.4 Scoring (deterministic, in code, not in the LLM)

Three layers, each cheaper than the one before.

**Layer 1, hard stop words.** Cut off before the LLM, for free. A vacancy with these is not
classified at all, and is stored with `score = -100`.

```
angular, .net, c#, java developer, python developer, php developer,
unity, unreal, salesforce, drupal, magento, sharepoint,
qa engineer, manual qa, devops engineer, sre, ml engineer, data scientist,
blockchain, web3, solidity, gambling, betting, casino, adult, forex
```

**Layer 2, positive weights:**
```
ai integration +5, llm +5, anthropic +5, claude +5, openai +4,
react +3, next.js +3, typescript +3, nestjs +3, cloudflare +3,
node +2, full-stack +2, stripe +2, postgresql +2, astro +2,
remote +2, prisma +1, tailwind +1
```

**Layer 3, contextual penalties:**
```
senior lead / 5+ years           -2
on-site only, city other than Kyiv -10
equity only, unpaid              -10
C1 English + video interview     -3
no pay range and "competitive"   -1
company already in blacklist     exclude entirely
```

The reason for the penalty on C1 and video calls is described in the owner's profile,
`CLAUDE.local.md`. This is an actual filter, not self-criticism, and it should affect
priority, not block submission.

`score = sum of weights + llm_relevance / 20`

Default threshold for showing: `score >= 6`, configurable in the config. Everything below the
threshold **is still stored in the database** for statistics, it just is not shown in the
queue.

### 5.5 Dedup

The same vacancy will be on the company's site, on Djinni and on DOU at the same time.

`dedupe_key = normalize(domain) + "|" + slugify(title) + "|" + week of first_seen`

On a match, the record is not duplicated, the source is just appended to the existing one.

### 5.6 Excluding what has already been seen

Before showing, a join with `company_state`. Never show:
`contacted`, `rejected_by_me`, `rejected_by_them`, `blacklist`, `snoozed_until > now`.

The one exception: status `contacted` older than 90 days and a new vacancy has appeared. Then
show it with an explicit badge, "wrote on 12.03, template fullstack_ai, no reply". Contacting
again after a quarter is fine, after a week is not.

---

## 6. FRONTEND

The main interface. Local, `localhost:5173`, no authorization, no deployment.

### "Queue" page (main, default)
- Limit **10 cards a day**, no more. Reason: a list of 40 positions paralyzes, nobody writes
  to anyone
- Card: company name, role, stack as tags, score, location, pay range, link to the vacancy,
  link to the site
- Expanding the card shows the model's `why` and an excerpt of the raw text
- Buttons right on the card: `Interesting`, `Not interesting`, `Contacted`, `Block company`,
  `Snooze for 30 days`
- Clicking immediately writes to `company_state` and removes the card from the list

### "Companies" page
- Table with filters by status, country, stack, presence of an ATS
- Search by name and domain
- Bulk actions: change status, set a tag
- Clicking a company opens a card with history: all its vacancies, all snapshots, the whole
  contact history

### "Contacts" page
- List of `outreach` with dates
- Highlighting those contacted more than 7 days ago with no reply
- "Mark reply" button with a type: positive, rejection, autoresponder

### "Statistics" page
- Top 30 technologies by frequency in vacancies over the period
- Median pay range by seniority and country
- Median vacancy lifetime, a separate list of suspected ghost jobs
- Funnel: found, shown, contacted, replied
- Chart of new vacancies by day

### "Sources" page
- State of every adapter: when it last ran, how much it found, errors
- Red for the ones that returned zero when the history is not empty
- "Run now" button

Style: dense, dark, no animations, no half-screen empty states. This is a daily work tool, not
a landing page.

---

## 7. TELEGRAM

A supporting channel, not an interface. Only:
- Alert on a find with `score >= 12` (a rare, highly relevant vacancy)
- Reminder at 10:00: how many new items are in the queue, a link to localhost
- Follow-up reminders: who was contacted 7 days ago with no reply
- Alert about a broken adapter

No inline buttons and no state control through the bot. All actions happen in the web app.

---

## 8. SCHEDULE

```
every 6 hours       ATS API (greenhouse, lever, ashby) + RSS
once a day          career pages of companies with status interesting/new
every 3 days        career pages of the rest
once a week          company catalogs, searching for new ones
once a week          enrichment: tech_hints, contacts from /team
daily 10:00          telegram digest
daily 18:00          follow-up check
```

---

## 9. ENRICHMENT

On first processing a company, extract from its home page:
- Stack signs: `_next` in the HTML means Next.js, `__NUXT__` means Nuxt, `wp-content` means
  WordPress, `data-astro` means Astro
- Whether there is a blog and the date of the last post
- From the `/team`, `/about`, `/people` pages: names with titles CTO, Tech Lead, Head of
  Engineering, Engineering Manager, into `contacts`

Why: an agency with a site on WordPress and a blog dead since 2019 is not hiring a React
developer. This filters out empty contacts before the owner spends time on a letter.

The email on the site is almost always `hello@` or `info@`, read by a manager, not a tech
lead. That is why named contacts are worth more than an email, and the UI should show them
first.

---

## 10. WORK ORDER

Work in stages, show the result after each one, do not start the next one without
confirmation.

**Stage 1.** Scaffolding: repo, DB, Drizzle schema, `lib/http`, `lib/log`, CLI skeleton,
fixtures.
**Stage 2.** ATS adapters (Greenhouse, Lever, Ashby) + RSS. Tests on fixtures. Console output.
**Stage 3.** Normalization, block diff, snapshots. Tests on two versions of one saved page.
**Stage 4.** LLM classification, Zod validation, scoring, dedup.
**Stage 5.** Hono API + frontend: Queue and Companies pages.
**Stage 6.** Company catalogs: DOU, Clutch import, TechBehemoths.
**Stage 7.** Contacts, Statistics, Sources pages. Telegram. Cron.

After Stage 5 the tool is already fit for daily use. Everything after that is an improvement,
and the owner can start writing letters without waiting for the rest.

---

## 11. WHAT NOT TO DO

- Do not build authorization, multi-user support, roles. The tool is for one person on one
  laptop
- Do not add Docker, Redis, queues, microservices
- Do not generate letter texts. That is a separate process, it lives in chat, not here. Storing
  and editing templates the owner wrote themselves is fine and needed: the Templates page is
  exactly for that, there are no calls to the model in it
- Do not build a pretty landing page and onboarding
- Do not add a source until the previous ones have tests
- Do not spend time on LinkedIn: the source is unavailable, the reason is in
  `CLAUDE.local.md`
- Do not build analytics more complex than described. The owner will build a full product
  separately

---

## 12. ABOUT THE OWNER

The owner's profile (stack, gaps, city, English level) lives in `CLAUDE.local.md`, which is
not committed. Claude Code reads it together with this file. In a fork, that is your own
profile, and the weights in `config/scoring.json` or on the Rules page get tuned to it.
