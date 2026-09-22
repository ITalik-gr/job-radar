# STATUS.md: Job Radar

Working log of the project: what's done, what's in progress, what's next, what decisions
were made and why. Update after every session. Keep it short, no filler.

Last updated: 04.09.2026

---

## Where it stands now

**Prod:** https://<your-worker>.workers.dev

The tool is fit for daily use. Run it with:

```bash
pnpm start      # API :3000, scheduler, telegram bot
pnpm dev:web    # UI :5173
```

In the database: 249 companies, 1665 vacancies, 6 above threshold, 66 companies with a
catalog profile link. 204 tests, all green.

---

## Done

| Stage | What's inside |
| --- | --- |
| 1. Scaffolding | SQLite + Drizzle DB, `lib/http` with throttling and robots, logs, CLI |
| 2. Vacancy sources | Greenhouse, Lever, Ashby, RemoteOK, three RSS feeds, tests on real fixtures |
| 3. Changes | Page normalization, block diff, snapshots, `diffByExternalId` for ATS |
| 4. Classification | Haiku with strict JSON, Zod, cache, daily call ceiling, scoring, dedupe |
| 5. UI | Hono API, React, Queue, Companies, Contacts pages |
| 6. Catalogs | DOU automatic, Clutch via file import |
| 7. The rest | Statistics, Sources, discovery, Telegram, cron |
| 8. Accuracy | Geo filter, role-by-title check, score ceiling from text, config in `config/scoring.json` |
| 9. Studios | Separate agency queue, company scoring, actions and outreach without a vacancy |
| 10. Collector | Chrome extension for catalogs behind Cloudflare, action panel in the UI |

---

## AI spend in dev sessions

One session on 04.09.2026 cost roughly **900 thousand input and 60 thousand output tokens**.
At this rate it's expensive, so the following sessions should be run differently:

**What to do:**
- Don't rewrite whole files for two lines of change. Targeted edits instead of `cat > file`
- Don't re-read large files repeatedly, rely on what's already been read this session
- Browser screenshots only when you really need to see the layout, not after every action
- Run tests selectively (`pnpm vitest run tests/x.test.ts`), full run at the end
- Batch the task instead of asking piecemeal: every new request drags along the whole context
- Truncate long command output (`| tail -5`) instead of dumping it in full

**What this achieves:** the bulk of the cost is input tokens, meaning re-reading context and
command output. That's exactly what needs to be economized, the 60 thousand output tokens
are trivial against the 900 thousand.

**Separately, the radar's own running costs** (not dev sessions): classification on Haiku,
cache keyed by text hash, daily ceiling of 500 calls. Roughly 200 calls a day with active
collection, that's cents. No problem there.

## In progress

**Prod is running, the database is empty.** Migrations are applied, `/api/companies`
returns 200 and an empty array. What's left is loading data in: the extension, buttons
in the UI, or moving it over from the local database via `pnpm cli export:sql`.

**The Cloudflare build was hanging** on compiling `better-sqlite3`. Fixed with the
`--ignore-scripts` flag in the Build command, the worker doesn't need the native driver.

**Two agents are working in this repository.** Check the state of files before making
changes, don't rewrite whole files without a reason.

---

## Outreach, Stage 1 (OUTREACH.md)

Done: tables `facts` and `send_log`, `templates` got `language` and `target_type`,
`outreach` was extended for drafts (`status`, `subject_final`, `body_final`, `ai_paragraph`,
gmail identifiers, `followup_of`, `error`). `sent_at` became optional: a draft lives in the
same table, and history and the funnel only count rows that have a send date.

Module `src/pipeline/outreach.ts`: deterministic template selection (vacancy, named
contact, general mailbox), language by country, contact selection, composing the email,
editing and deleting a draft. Commands: `outreach:seed`, `outreach:prepare --dry-run --limit N`,
`outreach:drafts`. 45 tests on the module, 450 green in the full run.

The starting eight templates (four cases in two languages) arrive as scaffolding: greeting,
signature, placeholders and `[...]` markers instead of paragraphs. The owner writes the
email text himself, and while the markers are in place, the draft sits in "Needs attention"
and cannot be sent.

## Studio and startup outreach queue

The "To outreach queue" button (hotkey `d`) is now also on a studio or startup card,
not just in the Vacancy queue. This is the owner's main scenario: he reviews vacancies
himself, but writes to studios and startups.

If there's no address in the database, the button doesn't give up, it crawls the
company's site itself (the same enrichment, one company) and tries again. It only gives
up when there really is no email on the site, and says so directly. A general mailbox
is still an address, it has its own template, and the radar won't invent `hello@domain`.

## Companies table virtualized

1930 rows were all rendered at once, and the page would freeze on every click. Now it's
`@tanstack/react-virtual`: only the visible rows plus twelve extra live in the DOM, and
two empty spacer rows of the right height hold the space above and below.

## Templates no longer come back from the dead

The starter set was re-seeded on every page open, so deleted templates would reappear
after a tab refresh. Now that's a separate button on the Operations page, and an empty
list stays empty.

The facts block for AI moved into a modal: under the editor it opened into nowhere,
because there's no room to grow at the bottom of the page.

## Operations page

Everything the CLI used to do is now buttons: catalogs (YC, DOU, Awwwards), discovery,
enrichment, classification, score recalculation, queue building, company types,
catalog field backfill, re-reading descriptions, vectors, templates and outreach drafts,
follow-ups, reply checking, live model ping, test email, and three Telegram notifications.

Routes are deliberately shaped the same: POST, body with an optional `limit`, response
with the same thing the command used to print. Because of this the frontend doesn't
need to know about each operation individually, it draws them as a list from a
description, and a new operation is just a row in the array.

The terminal kept only the commands that need files on disk or a one-time setup:
`db:migrate`, `import:csv`, `import:clutch`, `export:sql`, `auth:gmail`, `bookmarklet`.

## Vacancy descriptions from Next.js boards

Getro boards (Techstars, Underscore, Accel, and the rest of the networks) return an HTML
header and footer for the network weighing 70 thousand characters, while the actual
description sits in `__NEXT_DATA__`. The radar was storing menu items ("startups,
corporations, communities") as the vacancy text and paying to have them classified.
Now `fetchDetail` first looks for the description in the embedded JSON and only then
parses the markup.

Trying to distinguish junk by the look of the text doesn't work: the network's landing
page has more coherent prose than a short vacancy. So the only check left is "is there
at least one sentence," and the real fix is extraction from the JSON.

Existing records are healed with `pnpm cli fix:detail --source getro --limit 50`: it
re-reads the pages and sets `needs_review` so the model forms an opinion again.

## Startups: HN "Who is hiring"

Source `hn:hiring`, the monthly Hacker News thread via the public Algolia API. The first
run produced **204 vacancies and 200 new companies**, almost all small startups with a
direct founder contact. The post format is a convention, not a standard, so the parser
takes the company name from the first field, looks for the role by job-title words, and
gets the domain from the first external link. Without a domain the record is skipped:
it can't be invented from the name.

## Startups: YC catalog

Source `yc`, the `hiring` slice from the open API mirror (1475 companies currently
hiring). It doesn't give vacancies, it gives entry points: discovery then finds the
careers page, recognizes the ATS, and pulls vacancies via the API.

Web suitability is filtered out by tags in `config/scoring.json`, with no model call at
all: developer tools, SaaS, fintech, marketplace get a bonus, hardware, robotics,
biotech, semiconductors get a penalty. A startup building a robot factory doesn't hire
front-end developers, and there's no need to pay the model for that conclusion.

## Linking the Queue and outreach

The "Wrote" button in the Queue is a log entry: an email written by hand somewhere else,
the record goes into Contacts, the company becomes contacted. The new **"To outreach
queue"** button does something different: it assembles a draft with the same code as the
nightly preparation, with the same templates, language and contact selection. There
won't be a second draft for the same company, and the button says so plainly.

After sending from the "To send" page, the company also becomes contacted and disappears
from the Queue, so the two paths never show the same company twice.

The template editor gained fields without which outreach was only controllable from
code: **outreach role** (vacancy exists, named contact, general mailbox, follow-up),
**language**, and the **static first paragraph** under `{{intro}}`. A template without an
outreach role doesn't participate and just sits there to be copied by hand, shown with a
badge in the list.

## Outreach, Stages 3-6

**Safeguards** (`src/pipeline/send-guards.ts`), each a separate function with a test:
working window 08:00-22:00 Kyiv time and no weekends, limit warm-up (5, then 10, then
20 emails a day), 3-minute pause, no repeat to a company sooner than 90 days, dead
addresses after a hard bounce, stop when bounces exceed 3 percent over 50 emails, no
longer than 160 words, at most one link, no unfilled placeholder, exactly one follow-up.
`DAILY_SEND_LIMIT` is a constant in code, not a setting.

**Sending** (`src/pipeline/send.ts`): one email per click. A Gmail error leaves the
record as `failed` with a reason, instead of silently putting it back in the queue.

**"To send" page** in the web app: counter "sent today X of Y", pause timer, Ready and
Needs Attention tabs, text edited right in the card, Send, Save Edits, Regenerate
Paragraph, Skip buttons.

**AI paragraph** (`src/pipeline/ai-paragraph.ts`): only the first paragraph is rewritten,
the rest of the email comes from the template. Validation is deterministic: Zod, 1-3
sentences, 20-60 words, em dash replaced with a comma, stop words, the "not X but Y"
construction, exclamation marks, checking invented names and numbers against the input
JSON, confidence below 60. Any complaint means falling back to the static paragraph
`templates.intro`, and the reason goes into `outreach.ai_fallback_reason` for
statistics. Facts about the owner live in the `facts` table and are edited with
checkboxes on the Templates page.

**Replies and bounces** (`src/pipeline/replies.ts`): threads are walked hourly, checking
deterministic signals first (mailer-daemon, Auto-Submitted, out of office), and only
then the model. A hard bounce kills the address, not the company. A positive reply goes
straight to Telegram. The contact history shows the full text of what was sent.

**Follow-ups** (`src/pipeline/followups.ts`): exactly one, after 7-9 days, same thread
and same subject as the original. The delay is deterministic from the email id, so the
timing doesn't shift between checks.

**Outreach statistics** on the Statistics page and via the `outreach:stats` command:
conversion by template, AI versus template, share of validation fallbacks with reasons,
bounce rate, median time to reply.

Schedule: replies hourly, follow-up drafts at 06:30 UTC (09:30 Kyiv time), outreach
digest together with the daily one at 10:00.

**A static-assets trap.** `not_found_handling: single-page-application` serves
`index.html` for any browser navigation, and the worker itself never gets invoked
because of it. This made `/api/gmail/connect` show the UI instead of redirecting to
Google, while `curl` on the same address saw normal JSON: the only difference was the
`Accept` header. Fixed with `"run_worker_first": ["/api/*"]` in `wrangler.jsonc`.
Without this line the Google callback wouldn't work either, since it also arrives as
navigation.

**Outreach works in prod.** The token store is plugged in as a database driver: locally
it's the file `data/.gmail-token.json`, on Workers it's the `GMAIL_REFRESH_TOKEN`
secret, and the short-lived access token lives in the isolate's memory. The token
never goes into the database anywhere, see section 0 of OUTREACH.md.

Mail connection is also done from prod: `/api/gmail/connect` leads to Google,
`/api/gmail/callback` accepts the code and shows the refresh token exactly once, to be
put into `wrangler secret put`. The callback bypasses the radar's own token check,
because it arrives as a browser redirect, and verifies itself via `state`.

151 tests in the outreach module (templates and drafts 45, mail and encoding 18,
safeguards 41, AI paragraph 19, replies 17, follow-ups and statistics 11,
mail prod mode 5), 561 green in the full run.


## Outreach, Stage 2: mail

`src/lib/mime.ts` builds an RFC 2822 email: subject in encoded-word, body base64 with
utf-8, lines of 76 characters, `text/plain` only, `From` with a name and `Reply-To`.
`In-Reply-To` and `References` headers are set for a follow-up, so it goes in the same
thread instead of arriving separately. A dedicated, mandatory test for Cyrillic, 18 tests.

`src/lib/gmail.ts` is OAuth2 and REST without the Google library: code exchange,
automatic access-token refresh a minute before expiry, sending, thread reading for
Stage 5. Exactly two scopes: `gmail.send` and `gmail.readonly`. The em dash is stripped
right at the exit point, that's the last line of defense before mailing.

The token lives in `data/.gmail-token.json` with 600 permissions and in `.gitignore`,
not in the database. The store is plugged in as a database driver (`gmail-store.node.ts`),
so `node:fs` doesn't end up in the worker bundle: outreach works locally, and the worker
doesn't know about it.

Commands: `auth:gmail` (spins up a local interceptor on 127.0.0.1:53682 and opens the
browser), `gmail:status`, `gmail:test [email]`. Connection status is visible in the
sidebar of the UI as a "mail" row and the `GET /api/gmail/status` route.

**What the owner still needs to do:** create a Desktop-type OAuth client in Google
Cloud Console, enable the Gmail API, and put into `.env`:

```
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GMAIL_FROM_EMAIL=<your-gmail>
```

Redirect URI in the console: `http://127.0.0.1:53682/callback`. Then `pnpm cli auth:gmail`
and `pnpm cli gmail:test`. The test email to self hasn't been sent yet, because without
these keys there's nowhere to send it.

## Model spend

Measured: 500 calls a day, 909 thousand input tokens, $1.21, and only 6 useful vacancies
out of it. The cause was ordering: the model was being called before the free filters.
Fixed, expected minus 85 percent in calls. Breakdown and what else can be squeezed:
`COSTS.md`.

## AI Gateway

The `job-radar` gateway was created with authentication turned on, so **every request to
the model was bounced with a 401 right at the entrance**, never reaching Anthropic. In
the dashboard this looked like zeros in the metrics, because a request rejected at
authentication never gets there. Check with one command: `pnpm cli llm:ping`.

Two working paths: turn off authentication in the gateway's Settings, or create a token
with the **AI Gateway Run** permission and put it into `AI_GATEWAY_TOKEN`. The code now
sends the `cf-aig-authorization` header when the token is set, and the 401 error text
directly says what to do.

Second hole: Workers AI calls via the binding bypassed the gateway entirely. Now the
binding gets `{ gateway: { id } }`, and the REST path goes to the gateway's
`/workers-ai/<model>`. Anthropic gets the gateway address itself from `AI_GATEWAY_ID`
and `CF_AI_ACCOUNT_ID`, a separate `ANTHROPIC_BASE_URL` is no longer required.

## Classification on Workers AI

`LLM_PROVIDER` in `.env` and in `wrangler.jsonc` switches who classifies vacancies:
`anthropic` (default) or `workers-ai`. The second path is billed in neurons from
Cloudflare's already-paid plan, meaning there's no separate token charge.

The prompt, Zod schema, cache, daily ceiling and retry are shared between both. The
cache key includes the model, so switching doesn't reuse another provider's
classifications, but it also doesn't use the cache already built up for Haiku: the
first runs after switching will cost the full amount.

Check who's active right now: `GET /api/stats` shows `llmProvider` and `llmModel`, and
the same is visible in the UI sidebar as a "classifies" row.

The daily call ceiling differs: `LLM_DAILY_CALL_LIMIT` (500) for Anthropic, because
every call there costs money, and `WORKERS_AI_DAILY_CALL_LIMIT` (5000) for Workers AI,
because there it's quota from an already-paid plan.

## Studio reputation and the "Other" block

`companies` gained `rating`, `reviews_count`, `min_project`, `hourly_rate`,
`founded_year` and `extra`. Rate and minimum project used to sit among the tags and
clutter the services filter, now they have their own fields, and rate scoring reads
both places so already-collected companies don't need to be re-collected.

`extra` is the "Other" block: everything the catalog showed beyond the known fields.
The set differs per catalog, so it's a bag of label-value pairs, not columns, and a new
catalog doesn't require a migration. Scoring doesn't read `extra`, it's material for a human.

Rating and reviews feed into company scoring via the `companies.reputation` section in
`config/scoring.json`: a high rating is a plus, many reviews is a plus, zero reviews is
a minus (an empty card often means an abandoned studio). Rating and review count get
overwritten with fresh values, the rest of the fields only fill in what's empty.

**Rate and minimum project backfill has already sorted them into columns:**
`pnpm cli backfill:catalog` pulled them out of tags for 251 and 269 companies
respectively and removed 520 junk tags. The command is idempotent, running it again
changes nothing.

**Tags have been cleaned up.** Catalogs were mixing chart labels ("Allocation of
expertise by %"), ratings ("9.5/10 Market Presence"), buttons ("Read 4 Reviews") and
service shares ("25% Web Development") into the tags. Now the share is stripped and the
junk is filtered out, and the same list works in three places: the extension, the
Clutch parser, and the backfill for already-collected data. Result: 137 distinct tags
instead of a pile of variants of the same thing.

**Old data has no ratings or reviews:** they were never in the tags, so they'll only
appear on a fresh pass through the catalogs via the extension.

## The Cloudflare token trap that broke cf:migrate

`wrangler` reads `.env` and takes `CLOUDFLARE_API_TOKEN` from there as its own auth key.
`.env` had a token issued only for Workers AI, so wrangler went to D1 with it and got
`7403 account is not authorized to access this service`, which looked like a broken
account. The owner's own login was fine the whole time.

The radar's variables were renamed to `CF_AI_ACCOUNT_ID` and `CF_AI_API_TOKEN`, the old
names are still read as a fallback. After the rename `pnpm cf:migrate` works.

## Schema in prod, and how not to step on it again

`GET /api/health?deep=1` now checks not just whether the tables exist, but also tries to
read the newest columns. A migration that only adds columns doesn't change the table
list, so the worker with new code and an old schema looked healthy, while the Companies
page returned a 500 `no such column: companies.rating`. The same check was added as a
step in GitHub Actions after deploy: it changes nothing, it just fails the build with a
hint to run `pnpm cf:migrate`.

## Enrichment was looking for contacts in the wrong place

A run over 120 companies produced zero contacts out of 351 pages loaded, and it looked
like a broken parser. In fact the candidate selection had no ordering, so it took the
first rows in the table: Vercel, Anthropic, Stripe. Product giants don't have team
pages with names and emails, so the run was honestly looking in the wrong place.

Now candidates are ordered: studios and design agencies first, then startups, then
outstaff, product companies last, and a company with a catalog profile comes ahead of
one that arrived only from an ATS. Plus rule 3: a run over 10 or more domains without a
single contact gets written into the run's errors, instead of silently reporting success.

## Templates: full management

The Templates page can do everything expected of it:

- **Create** and **duplicate**. The copy gets its own key and the same text, the
  fastest way to make a variant of an email for a different niche
- **Rename the key**. The key is a snapshot in `outreach.template_used`, so on edit the
  radar rewrites the history records too, in one move. The field in the editor states
  plainly how many records will be rewritten
- **Archive** with the ability to restore. Archive means "get it out of sight," not delete
- **Delete for good**, with a confirmation showing how many emails were written with
  this template. Records in Contacts stay put: there the key is a snapshot, not a
  relationship

Two fixes along the way. `DELETE /api/templates/:id` used to archive, meaning the
button said "delete" but the record stayed: now it's a real delete, and archiving is a
separate action. And `seedTemplates` used to fill in whatever was missing from the
starter set, which is why a deleted template would come back on the next page open: now
the set is seeded exactly once, when the table is empty.

## Two bugs in enrichment, found by the new WARN

Rule 3 kicked in right away: a run over 100 studios logged an error in the run,
"checked 100 domains and found no contacts at all," and behind it were two real causes,
both silent.

1. **A first name without a last name didn't count as a name.** Half of studio sites
   sign a team card with just a first name: "Pavel, CEO". The rule required two words,
   so such pages were skipped entirely. Now a single word is accepted, but only right
   next to a job title and only on a team page, otherwise menu items would end up in contacts.
2. **"VP of Operations" was read as someone else's company.** The reviews and
   investors filter treated any capitalized word after "of" as a company name, so it
   rejected exactly the titles section 9 was written for: Head of Engineering, Director
   of Product, VP of Engineering. A list of departments was added, and now every mention
   in the line is checked, not just the first.

On a saved page of a real studio there were zero contacts, now there are five, and none
of the old fixtures broke: reviews and investors are still filtered out correctly.

## What old debts have been closed

- **Extension parsers have a smoke test** (`tests/extension-parsers.test.ts`, jsdom,
  Clutch fixture). Rule 2 in CLAUDE.md is no longer violated: a catalog layout change
  now fails the test instead of silently returning zero cards.
- **The score on the Companies page no longer diverges from Studios.** The listing was
  pulling an incomplete set of columns, so scoring there couldn't see the company type,
  signs of an abandoned site, or reputation. The column list was replaced with the full row.
- **Studio reputation is editable from the UI**, Rules page, "Studio reputation" card.
  These weights used to live only in a file, and Workers has no filesystem, meaning they
  couldn't be changed in prod at all.

## Next, by priority

1. **Apply migrations to prod** and verify with `pnpm cf:doctor`.
   This is the only action only the owner can do. Locally, migrations up to and
   including `0009` are applied, prod has none of the recent ones yet.
2. ~~Contacts of people at studios~~ → done, `src/pipeline/enrich.ts`, no model.
3. ~~Djinni and DOU as vacancy boards~~ → done, `djinni` and `dou:vacancies`.
4. ~~Catching up on missed runs~~ → done, `catchUp()` in `src/scheduler.ts`.
5. ~~Adapter for Awwwards~~ → done, catalog `awwwards`, 25 design studios.
6. **Batch API for scheduled classification.** Item 1 in `COSTS.md`, minus 50 percent
   on everything that runs on schedule.


---

## Feedback from the user

Done:

- ~~templates I write to studios etc, there's no way to change them~~ → **Templates**
  page. `templates` table, CRUD, editor. The select in the Queue and Studios pulls the
  list from the database. The `slug` doesn't change on rename, because it's already
  stored in `outreach.template_used`. Delete archives instead of erasing. Type `resume`
  exists, there's no separate logic for resumes yet
- ~~want to configure filter words from the frontend~~ → **Rules** page: vacancy and
  company threshold, stop words, term weights, role title check. Plus a menu on the
  stack tag right in the vacancy: raise weight, lower it, remove it, send to stop words.
  Saved data lives in the `settings` table and overrides `config/scoring.json`
- ~~Queue page isn't quite clear. Right now it's empty in prod and nothing's being added~~ →
  unreviewed cards no longer disappear, they roll over into the next slice. The empty
  state now names the reason: zero above threshold, everything reviewed, or new finds
  are needed
- ~~every vacancy text gets cut off~~ → the UI truncation at 8000 characters was
  removed. The full text was already in the database. The model still only sees the
  first `LLM_MAX_INPUT_CHARS` characters, that's an intentional saving, a knob in `.env`
- ~~the extension defaulted to the prod URL~~ → already the case: `apiUrl` defaults to
  the worker in both `background.js` and the popup

Left:

- Resume as a separate type with its own field in outreach. Right now it's just another template
- The rest of the config (geo, experience, company size, weights for studios) can only
  be edited in the file


---

## Ideas with no priority

- ~~Tie automatic email templates to company type~~ → `templates.for_kind`, the template
  matching this company's type is offered first
- ~~Score by blog activity~~ → `companies.copyright_year` and `last_post_at`, the
  `companies.stale` section in the config, a "Looks abandoned" badge on the card
- ~~Export the queue to CSV~~ → `pnpm cli export:csv <queue|studios>` and a link in the
  Studios toolbar
- Vacancy score history, to see how config edits change the output

---

## Decisions made and why

**The Queue is a fixed daily slice, not a live query.** Without fixing it, a new
vacancy with a higher score would push out one not yet looked at, and the list would
shuffle under the owner's hands.

**Unreviewed cards roll over into the next slice.** At first the slice was strictly
daily, and a card nobody acted on would vanish the next day, and the anti-repeat guard
wouldn't let it come back for 30 days. Now such cards move into the new day first, by
how long they've been waiting, and take up slots within the daily limit. The row moves,
it isn't copied, so `stats.shown` doesn't get inflated, and `created_at` still means the
date of the first showing.

**Two different change-detection mechanics.** ATS sources give stable ids, there the
id sets are compared. For regular pages the text is stripped of dates and counters,
then the block hashes are compared.

**Scoring in code, lists in config.** `config/scoring.json` gets edited weekly, and
every edit shouldn't be a release. The model only provides an opinion on relevance, it's
worth 1/20 of the score.

**Geo is strict.** A location with a place name and no signs of remote work counts as
office-based, whatever the remote flag says. This closed off "Remote (US)", "San
Francisco, hybrid" and "Barcelona" with one rule, without a list of every city in the world.

**The role is checked by title.** Otherwise an accountant with a company description
mentioning React and Next.js racks up points and ends up in the queue. A real case,
caught on live data.

**Big companies get a penalty.** Applying to Stripe or Cloudflare is almost always
pointless, so a giant only clears the threshold with a genuinely strong match.

**Catalogs behind Cloudflare are collected via the extension, not a scraper.** Pages
are opened by the owner's real browser. Automatic pagination is allowed with pauses and
a page limit per pass, rule 4 in `CLAUDE.md` was updated for this. Solving CAPTCHAs and
faking sessions remain forbidden.

---

## Lines not to cross

- Do not solve CAPTCHAs, do not fake sessions, do not act under someone else's account
- Do not page through a catalog faster than a human: pause no shorter than 3 seconds,
  limit of 50 pages per pass
- Do not invent data: whatever isn't in the text is `null`
- Do not build authorization, Docker, queues, microservices
- Do not generate email text, that's a separate process outside the tool
