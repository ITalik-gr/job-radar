# NIGHT_PLAN.md: unattended night session

Working plan and tracking log for the night of 2026-09-25/26. Every wakeup starts by
reading this file and ends by updating it. If context was lost, this file is the truth.

**Status: started 25.09 ~02:00. Scope for tonight: task 1 (audit) ONLY.** Tasks 2, 3
and 4 stay in the file for later and must not be touched. The audit is read only: no code
changes, no commits, findings go into "Audit findings" below. One wakeup is scheduled
at 06:35 (limit resets at 06:30). Keep token use low: targeted reads (`sed -n`, `grep`),
truncated output, selective test runs.

Baseline at planning time: branch `main`, clean tree, `pnpm typecheck` clean,
`pnpm test` 51 files / 687 tests green.

---

## Protocol for every wakeup

1. Read this file. Find the first task in the queue that is not `[x]` and not `[blocked]`.
2. `git status` and `git log --oneline -3`: check nothing unexpected changed.
3. Work on the task. Keep each task small enough to finish inside one wakeup.
4. After each task: `pnpm typecheck` and the relevant `pnpm vitest run tests/x.test.ts`.
   Full `pnpm test` at least once per wakeup, before stopping.
5. Tick the task, write one line in the log below (time, what, test count).
6. If a task needs an owner decision: mark it `[blocked]`, write the question in
   "Questions for the owner", move on.
7. Near the limit: stop at a green state, never leave a half edited file.

## Hard limits for the night

- No `git push`, no deploy, no `wrangler` commands against remote, no `cf:migrate`.
- No sending mail, no Telegram messages, no writes to `data/radar.db`.
- No new DB migrations without the owner (schema changes wait for morning).
- Network only for fetching fixtures and for the fresh clone check: robots.txt
  respected, 1 request per second, own User-Agent, public endpoints only.
- CLAUDE.md rules apply: no em dashes, English in code and `.md`, nothing personal.
- Behavior preserving refactors only. If a refactor changes a test expectation, stop
  and revert that part.
- Git: see question 1. Until answered, leave changes uncommitted.

---

## Task queue (in priority order)

### 1. Audit

Output: an "Audit findings" section at the bottom of this file. Each finding has
severity (high / medium / low), file and line, a concrete failure scenario, and a
a suggested fix. Nothing is fixed tonight, the owner decides in the morning.

- [x] **1.1 New user path, fresh clone.** Clone the repo into the scratchpad and follow
  README word for word, as someone who has never seen it:
  - `pnpm install` on a clean machine state. Lead already found: in a fresh clone
    `node_modules/better-sqlite3/build/Release` was missing and `require('better-sqlite3')`
    threw (shell Node is 24.18, `engines` says `>=22`). Verify whether `allowBuilds`
    in `pnpm-workspace.yaml` actually works with pnpm 11.18, or whether prebuilt binaries
    for Node 24 are the issue. This alone would break `pnpm start` for a newcomer.
  - `cp .env.example .env` with everything empty, then `pnpm start`: does it come up,
    what does it say, does the scheduler crash without keys.
  - `pnpm cli doctor`, `pnpm dev:web`, open every page in the browser on an empty DB:
    no crashes, no blank screens, no console errors.
  - `pnpm cli import:csv imports/seed-companies.csv`, `source:sync greenhouse --skip-llm`,
    `queue`: a newcomer gets something on screen without a model key.
  - Extension: load unpacked, the setup panel appears, no default address.
  - Every command in the README tables exists and runs (`--help` at least).
  - README and `.env.example` match the code: variable names, defaults, commands.
  - Grep for anything personal left in code defaults (rule 9).
- [x] **1.2 Core pipeline vs CLAUDE.md spec.** dedupe key (week of first_seen), diff
  closing vacancies (`closed_at`), queue exclusion rules including the 90 day
  `contacted` exception, stop words cut before LLM with `score = -100`, 10 cards a day,
  threshold from config, LLM called only on new blocks, Zod retry then `needs_review`.
- [x] **1.3 Normalization** (CLAUDE.md 5.1, the most important place): relative time in
  Ukrainian and English, applicant counters, utm and gh_src params, cookie banners,
  build hashes. Same page fetched twice must hash equal. Add regression cases.
- [ ] **1.4 API and worker.** Auth with `RADAR_TOKEN` on every route (no route left open
  on the worker), input validation, error responses, SQLite vs D1 differences, CPU
  heavy handlers on the worker.
- [x] **1.5 Outreach and sending safety.** Send guards (daily limit, gap, warmup) cannot
  be bypassed from any path, a letter never goes out without a signature or From name,
  follow ups thread correctly, reply detection edge cases.
- [ ] **1.6 Frontend.** Every page on empty data, loading and error states, mutations
  that remove a card really write `company_state`, stale queries after actions.
- [x] **1.7 Scheduler and runs.** Cron jobs on Node and on Workers match the schedule,
  stuck runs get closed, rule 3 (zero after non zero is a WARN and a UI marker) holds
  for every adapter.

### 2. Hard rules (from user: skip for this night, i tell you if this needed again)

- [ ] **2.1 Em dashes out.** Rule 1. Files: `src/pipeline/backfill-catalog.ts`,
  `src/pipeline/ai-paragraph.ts`, `src/lib/gmail.ts`, `tests/ai-paragraph.test.ts`,
  `tests/gmail.test.ts`, `tests/mailer.test.ts`. Some may be test inputs on purpose
  (checking that output strips them). Change only prose and comments.
- [ ] **2.2 English pass, src/** (rule 8, FORK 3.2). 17 files with Cyrillic. Convert each
  file whole. Cyrillic that is *data* (regexes for Ukrainian job text, DOU/Djinni
  parsing, stop words) stays. Small files first.
  - [ ] `src/lib/normalize.ts`, `src/pipeline/normalize.ts`
  - [ ] `src/pipeline/score.ts`, `company-score.ts`, `company-kind.ts`
  - [ ] `src/pipeline/discover.ts`, `enrich.ts`
  - [ ] `src/pipeline/templates.ts`, `outreach.ts`, `replies.ts`, `ai-paragraph.ts`
  - [ ] `src/lib/letter.ts`
  - [ ] `src/sources/catalogs/dou.ts`, `boards/dou.ts`, `boards/djinni.ts`
  - [ ] `src/cli/index.ts`, `src/api/index.ts`
- [ ] **2.3 English pass, extension/** (3 files) and `web/src` (1 file). UI copy stays
  as is (interface language is undecided), only comments and names.
- [ ] **2.4 English pass, tests/** (19 files). Descriptions and comments; Cyrillic
  fixtures and inputs stay.

### 3. Missing adapters (CLAUDE.md priority 1)

`discover.ts` already recognizes Workable, Recruitee and Personio career URLs, but
there are no adapters, so those companies fall back to HTML crawl. Each one: real
fixture, smoke test, registry entry, wired into sync the same way as greenhouse,
runs through `runs.ts`.

- [ ] **3.1 Recruitee.** `https://{slug}.recruitee.com/api/offers/`
- [ ] **3.2 Workable.** `https://apply.workable.com/api/v1/widget/accounts/{slug}`
- [ ] **3.3 Personio.** XML feed `https://{slug}.jobs.personio.de/xml`, cheerio in xml mode.

### 4. Splitting big files (behavior preserving)

Same exports, tests unchanged.

- [ ] **4.1 `src/api/index.ts` (914 lines)** into route modules per area
  (`api/queue.ts`, `api/studios.ts`, `api/outreach.ts`, ...), `index.ts` only mounts.
- [ ] **4.2 `src/cli/index.ts` (1023 lines)** into command groups.
- [ ] **4.3 `src/pipeline/outreach.ts` (1165)** and **`enrich.ts` (1045)**: only if the
  split is obvious (e.g. contacts extraction vs stack hints). Otherwise skip.
- [ ] **4.4 `web/src/pages/Studios.tsx` (959)**: pull out card and filter components.

At the very end, if time is left: update `STATUS.md` (date, test count, what changed)
and tick the done parts of FORK.md 3.2.

### Not for tonight (owner decisions)

- FORK 3.1, "tell me about yourself" onboarding.
- Interface language (Ukrainian, English, i18n).
- SMTP sender via nodemailer.
- Dependency bumps.

---

### 5. Fixes from the audit (owner: start now, rest at 06:35)

Uncommitted, on `main`. Each fix with a test.

Owner at ~02:50: no wakeup, finish the audit and fix everything in this session.

Done first:
- [x] F1 dedupe week bug: lookup and closeMissing without the week (critical)
- [x] F2 bind the local API to 127.0.0.1, `API_HOST` override
- [x] F3 CSRF: reject mutating requests from foreign origins / non JSON content type
- [x] F4 no model credentials: skip classification, do not count as a call
- [x] F5 `doctor` without url checks local config

Then, same session:
- [ ] finish audit 1.4 (D1 vs SQLite) and 1.6 (frontend in the browser)
- [x] F6 atomic draft claim against double send; no `failed` after a delivered letter
- [x] F7 blocker for no signature / no From name
- [x] F8 worker fails closed without `RADAR_TOKEN`
- [x] F9 normalization: newline between block elements, extra scrubbers, `lever-source`
- [x] F10 queue: at most 2 cards per company per day; card action never downgrades contacted
- [x] F11 data repair script for weekly duplicates (dry run by default, not run on prod)
- [x] F12 role stop words (developer, engineer, qa, sre) looked for in the title only
- [x] F13 worker rotates the board order per run
- [x] F14 OAuth state is an HMAC of the token, constant time compare, deep health needs token
- [x] F15 `replied` hidden like `contacted` (same 90 day return), badge from the last letter
- [ ] F16 time zone from `TZ` instead of hardcoded Kyiv / UTC day
- [ ] F17 career page scheduler
- [ ] F18 README and docs: doctor, quick start expectations, API_HOST, merge command, seed CSV
- [ ] audit 1.4 (D1 vs SQLite) and 1.6 (frontend in the browser)

## Questions for the owner

(answered: audit only, no commits, reset at 06:30, one wakeup at 06:35)

---

## Audit findings

Format: **[severity] title**, where, scenario, suggested fix. Status of all: open,
nothing was changed in the code.

**Summary, in the order worth fixing:**
1. Critical: weekly dedupe key closes and re-creates every vacancy every Monday
   (breaks lifetime and ghost job stats, re-shows cards). Plus a production data repair.
2. High: local API bound to all interfaces with no token; CSRF from any website;
   career pages never monitored (the diff layer is not scheduled); missing model key
   burns the LLM budget; `pnpm cli doctor` in README fails.
3. Medium: double send race and resend after a bookkeeping error; no guard against
   unsigned letters; worker open without `RADAR_TOKEN`; token in URLs; stop words in
   descriptions kill 62 of 72 frontend roles in the local DB; one company can take all 10
   cards; README quick start ends in an empty queue; glued text in normalization; worker
   6 hour job may exhaust subrequests.
4. Low: listed per section below.

Progress: 1.1, 1.2, 1.3, 1.5, 1.7 done; 1.4 done for auth and CORS (D1 vs SQLite not
reviewed); 1.6 (frontend in the browser) left for the 06:35 wakeup.

For the wakeup: a fresh clone with a populated DB sits in the session scratchpad at
`.../scratchpad/fresh` (greenhouse data, 3304 vacancies after the rollover test). Start it
with `API_PORT=3107 pnpm start` there, and `DB_PATH=<scratchpad>/empty.db API_PORT=3108`
for the empty DB case; web via `pnpm dev:web` pointing at the right port. Stop both after.

### Critical

- **[critical] Every Monday all open vacancies are closed and re-created as new.**
  `src/pipeline/ingest.ts:114-115` looks an existing vacancy up only by `dedupeKey`, and
  `src/pipeline/sync.ts` (the `closeMissing` keys) builds it with `dedupeKey({...})`
  without `firstSeen`, so the week part is always the *current* ISO week
  (`src/pipeline/dedupe.ts`). When the week changes, no existing row matches: the same
  vacancy is inserted again as new, and `closeMissing` closes last week's row because its
  key is not among "seen" keys. Verified in the fresh clone: after a sync, rewrote the
  week in keys to the previous one, synced greenhouse again: `new 1652, closed 1652`,
  table went 1652 -> 3304 rows. Consequences: vacancy lifetime can never exceed 7 days,
  so ghost job detection (CLAUDE.md section 3) and the median lifetime stats are
  meaningless; `runs.items_new` and the "new vacancies by day" chart spike every Monday;
  undecided vacancies come back to the queue as fresh; high score alerts can fire again;
  classification re-runs (the LLM cache saves the money only when the text is identical).
  Production on the worker has been doing this since the first week. The owner's local
  DB has only one week (W36), so it is not visible there.
  Fix: find an existing row by `(source, external_id)` first when `external_id` exists
  (all ATS and most boards have it), and by the key *without* the week for
  cross-source dedupe (or match on host|title with `closed_at is null or last_seen >
  now - 14d`); `closeMissing` should compare by external id / week-less key. The week in
  the key per CLAUDE.md 5.5 is only meant to let a vacancy re-posted months later count
  as a new one. Needs a data repair script for production (merge rows with equal
  host|title and consecutive weeks: keep the earliest `first_seen`, latest `last_seen`).
  A test: ingest, advance the clock one week, ingest the same items, expect 0 created and
  0 closed.

### Security (found during 1.1 and 1.4, listed first because they matter most)

- **[high] The local API listens on every network interface, with no token.**
  `src/main.ts:19` and `src/api/index.ts:912` call `serve({ fetch, port })` with no
  `hostname`, so Node binds `*:3000`. Verified: `lsof` shows `TCP *:3107 (LISTEN)` and
  `curl http://192.168.0.119:3107/api/companies` from the LAN address returns 200. Local
  mode has no token by design, and the comment at `src/api/index.ts:112` says "The server
  listens on localhost only", which is false. On cafe or office Wi-Fi anyone on the
  network can read companies, contacts and letters, change statuses, and trigger
  `/api/outreach/drafts/:id/send` from your mailbox. Fix: `hostname: '127.0.0.1'` by
  default, `API_HOST` to override on purpose.
- **[high] CSRF from any website against the local API.** Without `RADAR_TOKEN`, a page on
  any site the owner visits can send a "simple" cross-origin POST (`content-type:
  text/plain`, no preflight), CORS only hides the response. Hono's `c.req.json()` parses
  the body regardless of content type. Verified: `curl -X POST -H 'Origin:
  https://evil.example' -H 'content-type: text/plain' -d '{"status":"blacklist"}'
  /api/companies/1/state` returned `{"ok":true}` and the row changed. The same works for
  sending drafts, deleting templates, rules. Fix: reject mutating requests whose `Origin`
  is present and not in the allowed list (the extension import routes aside), or require
  `content-type: application/json` on mutations (forces a preflight), ideally both.
- **[medium] A deployed worker without `RADAR_TOKEN` is fully open.** `requireToken` passes
  everything when the token is empty (`src/api/index.ts:95`). `cf:setup` generates one,
  but a plain `pnpm deploy` or the GitHub workflow without the secret gives a public
  radar with contacts and a send button. Fix: on the worker (the `prepare(env)` path),
  fail closed with 503 "RADAR_TOKEN is not set" instead of open.
- **[medium] The master token leaves the house in URLs.** The Gmail OAuth `state` is the
  raw `RADAR_TOKEN` (`src/api/index.ts:442,452`), so it goes to Google and into browser
  history; README also recommends `/?token=...`. Fix: `state` = HMAC of the token plus a
  nonce; after the first `?token=` visit the web app should strip it from the address bar.
- **[low] Token compared with `!==`** (`src/api/index.ts:102`), not constant time. Minor on
  a worker, but cheap to fix.
- **[low] `/api/health?deep=1` is open without a token** and lists every table and
  missing migration. Only the shallow check needs to be public.

### 1.1 New user path

- **[high] Without a model key every new vacancy burns the daily call budget.**
  `src/pipeline/classify.ts:237-287`, `src/pipeline/ingest.ts:229`. Nothing checks for a
  missing `ANTHROPIC_API_KEY` before calling. Each vacancy makes 2 attempts, each throws
  "ANTHROPIC_API_KEY is missing", and `recordUsage` counts the failure as a call. A fresh
  install on the 6 hour cron: ~250 vacancies eat the default 500 calls, 2 WARN lines per
  vacancy flood the log, everything lands in `needs_review`. If the key is added later
  the same day, the budget is already gone. The same happens during a real provider
  outage. Fix: skip classification (like `--skip-llm`) when the active provider has no
  credentials, log once; do not count a call that never reached the provider.
- **[high] `pnpm cli doctor` from README fails for a newcomer.** README ("`pnpm cli doctor`
  tells you what is still missing") and `pnpm cf:doctor` both run it with no argument;
  the command (`src/cli/index.ts:768`) requires `<url>` of a deployed worker and exits with
  `missing required argument 'url'`. There is no local config check at all (FORK.md 3.3
  says one exists in doctor, it does not). Fix: make `url` optional, without it check the
  local `.env` (model key, `USER_AGENT_CONTACT`, Telegram, mail) and the local DB.
- **[medium] README quick start ends in an empty queue.** Followed the README exactly:
  seed CSV (10 companies) plus `source:sync greenhouse --skip-llm` gave 1652 vacancies,
  1259 at -100, the best score 2.0, zero above the threshold 6. The seed companies are
  US infra companies, the default profile is Kyiv plus React, so the geo filter and weights
  kill almost everything. A newcomer sees "the queue is empty" and concludes it is broken.
  Fix: README should say the queue is tuned to the author's profile and point at Rules
  first; show on the Queue page "N vacancies below threshold, best score X" instead of
  plain empty; consider a seed list that matches the default rules.
- **[medium] Startup is silent about missing config.** `pnpm start` with an empty `.env`
  logs only "scheduler started" and "Job Radar started". No word about the missing model
  key, `USER_AGENT_CONTACT` (so every request goes out as "unknown"), or Telegram. Known in
  FORK.md 3.3, confirmed.
- **[low] "day" in the API is UTC, not Kyiv.** At 02:04 EEST on 25.09 `/api/health` and
  `/api/queue` answer `"day":"2026-09-24"`, while the scheduler runs in `Europe/Kyiv`. The
  daily 10 card limit and the LLM budget roll over at 03:00 local time, not midnight.
  Check `today()` and decide if that is intended.
- **[low] `/api/stats` returns `null` instead of 0 on an empty DB** (`open`,
  `aboveThreshold`, `stopped`, `needsReview`): SQL `sum()` over zero rows. Check the Stats
  page shows 0, not an empty cell or "null".
- **[info, not a repo bug] `pnpm install` did not build `better-sqlite3`.** Cause: the
  owner's global `~/Library/Preferences/pnpm/config.yaml` has `ignoreScripts: true`, which
  overrides `allowBuilds`. A newcomer without that setting is fine. Worth one line in
  README troubleshooting: "Could not locate the bindings file" means run
  `pnpm rebuild better-sqlite3`. Node 24.18 works fine with it.
- **[low] `imports/seed-companies.csv` notes are Ukrainian and personal** ("платежі в стеку
  власника", "продуктовий фронт"). They land in `company_state.reason` of every
  newcomer. Rule 8 and rule 9: translate, drop "owner".

### 1.2 Core pipeline

- **[medium] Stop words on the full description reject good frontend roles.** `ingest.ts`
  runs `hasStopWord` on title plus the whole body (company blurb included). In the owner's
  local DB, 72 vacancies with frontend / react / full stack in the title sit at -100; only
  10 have the stop word in the title. The other 62 were killed by the body: angular 25
  ("Angular is a plus"), ml engineer 12 ("work with our ML engineers"), c# 8, blockchain 7,
  java developer 6, salesforce 5, .net 4, web3 3. Examples: "Frontend Engineer",
  "Frontend Developer (AI-first)", "Senior Full Stack Engineer (Node.js/React)". Question
  for the owner: split the list into title-only stop words (roles: `java developer`,
  `ml engineer`, `qa engineer`, `devops engineer`, `sre`, `data scientist`) and anywhere
  stop words (domains: `gambling`, `casino`, `web3`), or turn body hits into a negative
  weight instead of -100. Note the rule "not classified at all" is from the spec, the
  question is only where the words are looked for.
- **[medium] One company can take all 10 queue slots.** `queue.ts candidates()` sorts by
  score and slices, with no per company cap. A company posting 12 similar React roles fills
  the day and the decision is really one decision ("write to X or not"). Fix: at most 1 or 2
  cards per company per day, the rest wait.
- **[low] `replied` is not a hidden status.** `HIDDEN_STATUSES` (queue.ts, and a copy in
  `ingest.ts:346`) lacks `replied`, so a company that answered keeps getting new cards in
  the queue while a conversation is going on. Spec 5.6 does not list it either; question.
  Also the two copies of the list should be one constant.
- **[low] The recontact exception keys off `company_state.updated_at`.** Any later edit of
  the state (a reason, a note) restarts the 90 day clock. The badge text is always
  "contacted DD/MM/YYYY, no reply" and does not name the template as CLAUDE.md 5.6 asks;
  the outreach row has it. Better: take the date and template from the last `outreach` row.
- **[low] A card action can downgrade a contacted company.** `applyAction`
  (`src/pipeline/actions.ts:39`) overwrites `company_state.status` with whatever the
  button says. Pressing "Interesting" on a new card of a company that is `contacted` (the
  90 day exception shows such cards) turns it back into `interesting`: the contact is
  forgotten by the queue filter and the recontact guard relies on outreach rows only.
  Fix: never move a company from contacted/replied to new/interesting via a card.
- **ok:** stop words cut before the LLM with -100, blacklist excluded, `score = sum +
  relevance/20`, threshold from rules, the day's slice is fixed once and carried over,
  30 day no-repeat, LLM only for vacancies not cut by the free filters, one retry then
  `needs_review`. All match the spec.

### 1.3 Normalization

Probed `scrubText`, `cleanHref`, `normalizePage` with noisy pairs (script in scratchpad).

- **[medium] Adjacent elements are glued together, which breaks the scrubbers.**
  `normalizePage` joins text of sibling block elements without a separator: `<li>... posted
  3 days ago</li>...<div>x</div>` becomes `posted 3 days agox`, so the relative time regex
  no longer matches and the page `contentHash` differs between two fetches that differ only
  in "3 days" vs "5 days". Block hashes stayed equal in the probe, so vacancy diff is safe,
  but the page level "something changed" signal and snapshots get noise. Fix: insert a
  newline after block level elements before `.text()`.
- **[low] Gaps in the scrubbers** (each pair below hashes differently today):
  "Be among the first 25 applicants" vs "Over 100 applicants", "1.2k views",
  "Переглядів: 120", Ukrainian dates with month names ("24 вересня 2026"), "Closes in 5
  days", and a "New" badge that appears and disappears. The English "N applicants", "N
  days ago", "вчора/сьогодні", numeric dates and ISO timestamps are handled.
- **[low] `cleanHref` keeps `lever-source`** (Lever's tracking param) while dropping utm,
  ref, gh_src, fbclid. Add it and `source`, `src`, `trk`.
- **ok:** cookie banner, footer copyright, CSRF inputs, nonces and hashed class names do not
  change the hash.

### 1.5 Outreach and sending

- **[medium] Double send race.** `sendDraft` (`src/pipeline/send.ts:24`) runs `checkSend`
  (status must be draft/approved) and then `deliver`, and only after delivery sets
  `status = 'sent'`. Nothing claims the draft in between. A double click, two tabs, or the
  CLI and the button at the same time both pass the check and both deliver: the same person
  gets the letter twice, and the gap and daily limit guards do not help because `send_log`
  is written after delivery too. Fix: an atomic claim first, `update outreach set
  status='sending' where id=? and status in ('draft','approved')`, proceed only if one row
  changed; on a delivery error set `failed`.
- **[medium] A delivered letter can be marked failed and resent.** If `deliver` succeeds and
  the following DB update throws (D1 hiccup, lock), the catch block writes `status =
  'failed'` for a letter that actually went out; "retry" then sends it again. Fix: separate
  the try around `deliver` from the bookkeeping, and if bookkeeping fails after delivery,
  log loudly but never mark failed.
- **[medium] Nothing stops a letter with no signature and no From name.** Since the
  personal defaults were emptied (FORK 2.2), a newcomer who has not filled the signature
  and `GMAIL_FROM_NAME` sends an unsigned letter from a bare address; `letterBlockers`
  checks subject, body, placeholders, length and links only. Fix: a `signature` blocker
  when the body has no signature and none is configured, and a `from_name` blocker (or a
  warning on the Sending page) when `GMAIL_FROM_NAME` is empty.
- **[low] Send window and daily day are hardcoded to Kyiv** (`kyivDay`, `kyivClock`,
  `isSendWindow`). For a fork in another time zone letters are blocked or allowed at the
  wrong hours. Should follow the scheduler's `TZ` setting.
- **ok:** every path (CLI and API) goes through `checkSend`; blacklist and rejected
  statuses block; recontact after 90 days; one follow-up only, threaded with In-Reply-To
  and References; hard bounced addresses are dead; bounce rate pause; 3 minute gap and
  warmup limit.

### 1.7 Scheduler and runs

- **[high] Career pages of companies without an ATS are never monitored.** CLAUDE.md
  priority 4 and section 8 ("once a day career pages of interesting/new, every 3 days the
  rest"). `SCHEDULE.careersInteresting = '30 3 * * *'` exists in `src/scheduler.ts:20` and
  is printed in the startup log, but no `cron.schedule` uses it, and the worker has no such
  cron either. `saveSnapshot` is called only from the `page:check` CLI command; nothing
  runs the normalize, block diff, snapshot, ingest chain on a schedule. In the owner's
  local DB: 41 companies with `careers_kind = html` and 2 snapshots in total. So the whole
  change detection layer (CLAUDE.md 5.1, 5.2, "the most important place in the project")
  is effectively dead code in production, and the startup log misleads about it. Fix: a
  `careers:sync` pipeline step (page per company, block diff, new blocks to ingest,
  missing blocks closed), wired to both schedulers with a per run limit so the worker stays
  within CPU and subrequest limits.
- **[medium] Worker 6 hour job may silently run out of subrequests.** `src/worker.ts:69`
  syncs every board source one after another plus `classifyPending(50)` in a single
  scheduled invocation. Every ATS slug, every detail page and every model call is a
  subrequest (limit 1000 on Paid, 50 on Free); FORK.md says "heavy syncs are split across
  cron runs", but this one is not. When the limit hits, the remaining sources throw
  inside `safely`, which only logs, so the tail of the list (whatever comes last in
  `listSources('board')`) may never run. Check `runs` on production for sources that never
  finish; fix by rotating a subset of sources per invocation.
- **[low] Worker crons are fixed UTC.** `0 7 * * MON,THU` is 10:00 Kyiv only in summer;
  after 26.10 (DST ends) the digest comes at 09:00 and follow-up drafts at 08:30. Also Kyiv
  specific for forks.
- **ok:** stuck runs get closed (`runs.ts`), zero after non zero is a WARN in `withRun`,
  every board goes through `withRun`. Nit: the Sources page shows that WARN in yellow
  (`statusColor`), CLAUDE.md section 6 asks for red when zero follows a non empty history.

---

## Log

| Time (Kyiv) | Task | Result | Tests |
| --- | --- | --- | --- |
| 25.09 01:40 | planning | plan written, caffeinate started for 10 h | 687 green |
| 25.09 01:50 | planning | plan narrowed to audit, rules, adapters, splitting; fresh clone lead noted | 687 green |
| 25.09 02:00 | planning | owner: audit only, one wakeup 06:35 | 687 green |
| 25.09 03:00 | fixes | F1-F5 done, cron cancelled by owner | 699 green |
| 25.09 02:40 | audit | 1.1, 1.2, 1.3, 1.5, 1.7 done, 1.4 partly; 1 critical, 5 high findings | no code changed |
