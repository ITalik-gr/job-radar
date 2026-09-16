# Making this something people can run themselves

The decision: **fork it, do not host it**. You clone the repo, fill in your own
values, and run it on your laptop or deploy your own worker with your own
database. There is no sign up, no shared server, and nobody else's data on your
host.

This file tracks what is left before that is true, and doubles as the list of
known problems.

---

## 0. Why not a service

Not because it would be hard, but because it is a different product with a much
worse risk profile.

**The schema does not know about users.** No table has a `user_id`. `settings`
is keyed by the key alone, `facts` is one global whitelist, the scoring rules are
global, and so are the sending guards (`DAILY_SEND_LIMIT`, `MIN_GAP_MS`, the
warmup ramp in `send-guards.ts`). Multi tenancy here is not a feature, it is a
pass over every table and every query.

**Other people's mail tokens.** OUTREACH.md keeps the Gmail refresh token in a
file rather than the database, precisely so that a database backup is not access
to the mailbox. A service would hold strangers' tokens: encryption at rest, key
rotation, a breach plan. On top of that `gmail.send` and `gmail.readonly` are
restricted scopes, and Google gates those behind a paid security assessment.

**You would be running a cold email platform.** Today the mail leaves the
owner's own mailbox, twenty a day, with a warmup ramp. Those guards are built to
protect one careful person's sender reputation, not to police a hundred
strangers. Same with scraping: your own extension in your own browser and the
same thing offered to others are different conversations.

In a fork every one of those questions disappears. Your mail, your key, your
database, your responsibility.

---

## 1. Already in place

This is the reason a fork is cheap rather than a rewrite.

- Workers and D1 deployment is wired up, `pnpm deploy` and `pnpm cf:migrate`
- configuration is fully environment driven, with lazy getters and `setRuntimeEnv`
  for the worker (`src/config.ts`)
- scoring rules live in `config/scoring.json` and the `settings` table rather than
  in code, because Workers has no filesystem. Editable from the Rules page
- personal facts used for letter personalization live in the `facts` table and are
  editable in the interface
- letter templates live in the database, not in code
- `.env.example` explains every variable, README has the setup steps
- `/api/health?deep=1` reports whether the database has fallen behind the code

---

## 2. Fixed

### 2.1. The extension used to post to someone else's worker

`extension/background.js` and `extension/popup.js` shipped with the author's own
worker as the default address. Anyone who installed the extension without opening
settings sent their scraped companies to a stranger's radar and could not tell:
the popup said "connected" and the counters went up, because that other server
did answer.

Now there is no default. The popup opens on a setup panel until an address is
filled in, and collection stays disabled until then. An empty address fails
loudly, which is the only honest default here.

### 2.2. Personal defaults in code

The signature, the From name and the notification base URL all carried one
person's identity as a fallback. The dangerous one was the signature: install the
radar, write a letter, and send it signed by someone else, silently, because
nothing in the flow asks.

`DEFAULT_SIGNATURE` and `GMAIL_FROM_NAME` are empty now, and `WEB_URL` points at
`localhost`.

### 2.3. Account and database ids

`wrangler.jsonc` pinned a specific D1 database id and carried the author's
Cloudflare account id, worker URL and name as plain vars. The config schema marks
`database_id` optional, so it is gone: wrangler binds the database by name at
deploy time. Everything that identifies a person moved out of the file and is set
with `wrangler secret put`, which also means a deploy no longer overwrites it.

`DEPLOY.md`, `README.md` and `STATUS.md` no longer name a specific worker, and the
deploy workflow reads its health check URL from a repository variable.

---

## 3. Still open

### 3.1. The owner's profile is baked into the weights

CLAUDE.md section 12 describes one person's stack and gaps, and the weights in
`config/scoring.json` follow from it: `react +3`, `angular` among the stop words,
a penalty for C1 English plus a video interview. For a fork this means the radar
looks for someone else's job by default.

The file is editable from the Rules page, so nothing is broken. What is missing is
a "tell me about yourself" step on first run, because right now a newcomer has to
work out on their own that the weights describe a stranger.

### 3.2. Everything is commented in Ukrainian

Rule 8 in CLAUDE.md now requires English for comments, names, log messages and
`.md` files. New code follows it and a touched file gets converted whole, so that
no file ends up half and half. The bulk of `src/` and `web/` is still Ukrainian
and needs a deliberate pass.

Interface copy is a separate question and is not covered by that rule. Options:
leave the UI Ukrainian, switch it to English, or add i18n. Not decided.

### 3.3. First run is a dead end

`pnpm start` comes up with an empty `.env` and says nothing. It would be more
useful to say out loud, once: no model key, classification is off; no
`USER_AGENT_CONTACT`, other people's sites will see "unknown"; empty
`RADAR_TOKEN` on a deployed worker. Some of this already exists in
`pnpm cli doctor` and only needs moving into startup.

After `db:migrate` the interface shows empty lists with no hint about what to do
next. `imports/seed-companies.csv` is the intended first import and the README
mentions it, but the empty state in the app does not.

### 3.4. Sending is Gmail only

See section 5.

### 3.5. No license

There is no LICENSE file, so formally nobody may fork this.

### 3.6. The author's data is still in git history

Removing it means rewriting history. See section 6.

---

## 4. What will never work on a worker

Deliberate limits, not bugs. They need naming in the docs so nobody hunts for a
fault that is not there.

- **sending from Gmail**: the token is a file on disk, and Workers has no disk
- **the scheduler**: `node-cron` lives inside a process, and a worker is not one
- **reply detection and follow ups**: they depend on mail, so the same applies

The worker is the interface and the collector; sending is the local `pnpm start`.
The hybrid works well: one D1 database, the worker reads, the laptop writes.

---

## 5. Sending through something other than Gmail

Gmail via OAuth is the right default for one person writing from their own
mailbox: it threads correctly, it detects replies, and it costs nothing. It is
also the single hardest part of the setup, it cannot run on a worker, and it is
useless to anyone who does not use Gmail.

The shape to aim for is a small provider interface with Gmail as one
implementation, so that the pipeline keeps calling one function and the guards
stay where they are.

What matters when choosing:

- **threading.** Follow ups must land in the same thread, which needs a provider
  that returns and accepts a message id
- **reply detection.** Gmail reads the inbox. An API-only sender does not, so
  replies would have to arrive by webhook, or reply detection stays a Gmail
  feature and other providers simply do not offer it
- **worker support.** An HTTP API works on Workers; SMTP does not

Candidates worth a look, in rough order of fit: Resend, Postmark, SMTP through
`nodemailer` for anyone with an existing mailbox. All three send; only Gmail
currently reads.

---

## 6. Getting the author's data out of git history

Short version: you cannot remove content from history without rewriting it. Every
commit after the touched one gets a new hash. The question is not whether history
changes but who is inconvenienced when it does, and with a single author and no
open pull requests the answer is nobody.

`DEV_CONTEXT.md` is the problem: a full personal dossier with a phone number, and
it has been in the repo since the first commit.

Two workable routes:

**A. Rewrite the existing repo.** `git filter-repo` drops the file from every
commit, then a force push. Cheap, keeps the commit-by-commit history, and works
because there are no collaborators. What it does not do is erase anything already
mirrored: GitHub keeps unreferenced objects reachable by hash for a while, forks
and caches keep their own copies. For a repo that has always been private this is
fine; treat anything that was ever public as leaked.

**B. Publish a fresh repo.** Keep the private repo exactly as it is, history and
all, and create a separate public one from the cleaned tree with a single initial
commit. Nothing to rewrite, nothing to force push, and no chance of a stray blob
surviving, because the new repo never contained one. The cost is losing the
commit history in public.

**B is the safer choice** and the usual one for opening up a personal project.
The history is valuable to exactly one person, who keeps it either way.

Whichever route: personal files (`DEV_CONTEXT.md` and friends) move out of the
working tree or into `.gitignore` first, and the phone number and addresses get
rotated out of anything that stays.
