# OUTREACH.md: Job Radar outreach module

Addendum to `CLAUDE.md`. Read both.
Module goal: turn the company queue into sent emails, with memory of contacts,
LLM personalization and reply detection.

---

## 0. HARD RULES

1. **NO em dashes anywhere: in code, comments, UI, templates, generated emails.**
   The validator must strip them automatically before sending.
2. **There is NO automatic sending without human confirmation.**
   The system prepares the email in full, the human clicks the button for each email individually.
   Reason: mass auto-sending from a personal Gmail account means the account gets blocked.
   Do not add an "autopilot mode" in any form, not even as an option behind a config flag.
3. **The LLM rewrites only the first paragraph and only from the facts provided.**
   Any claim that isn't in the input data is a bug.
4. A hard daily send limit is baked into the code as a constant, not a UI setting.
5. No tracking pixels, no link shorteners, no UTM parameters in email links.
6. OAuth tokens and API keys only in `.env` and local storage, never in the DB alongside data,
   never in commits.

---

## 1. DATA MODEL

Addendum to the existing schema.

```ts
templates
  id, key, name, language,        // uk | en
  channel,                        // email
  subject_template, body_template,
  target_type,                    // vacancy | studio_named | studio_generic | followup
  is_active, created_at, updated_at

outreach                          // extension of the existing table
  id, company_id, vacancy_id, contact_id,
  template_id, language,
  subject_final, body_final,      // what actually went out
  ai_used, ai_paragraph,          // generated first paragraph, kept separately for auditing
  status,                         // draft | approved | sent | failed | bounced | replied
  gmail_message_id, gmail_thread_id,
  queued_at, sent_at,
  reply_at, reply_type,           // positive | rejection | autoreply | ooo | unclear
  bounce_type,                    // hard | soft
  followup_of,                    // id of the previous email in the chain
  followup_due_at,
  error

send_log
  id, day, count, last_sent_at    // for limits and pauses

facts                             // whitelist of facts about the owner for the LLM
  id, key, text_uk, text_en, is_active
```

`ai_paragraph` is stored separately on purpose. After 100 emails it will be possible to compare
conversion with AI personalization against conversion without it.

---

## 2. GMAIL CONNECTION

### Method

**Gmail API via OAuth2**, not SMTP with an app password.

Reasons: SMTP gives neither `threadId` nor inbox reading, meaning reply detection and
correct follow-up threading are impossible without it. Plus Google is gradually
restricting app passwords.

### Scopes

```
https://www.googleapis.com/auth/gmail.send
https://www.googleapis.com/auth/gmail.readonly
```

`gmail.readonly` is needed exclusively for reply and bounce detection.
Do not request `gmail.modify` and do not request full `mail.google.com`.

### Flow

1. The CLI command `pnpm cli auth:gmail` opens the browser, desktop OAuth flow
2. The refresh token is stored locally in `data/.gmail-token.json`, the file is in `.gitignore`
3. The access token refreshes automatically, and when the refresh token expires the command is run again
4. Connection status is visible on the Settings page in the web app

### Sending

`users.messages.send`, body in RFC 2822 format, base64url.

Mandatory:
- `From` with a name: `Olena Koval <address>`
- `Reply-To` is the same address
- `text/plain`, **not HTML**. HTML emails from strangers get filtered more aggressively
- signature at the end:
  ```
  Olena Koval
  Front-end / Full-stack developer
  olena.dev
  ```
- at most one link in the email body

For a follow-up: `threadId` from the previous email, `In-Reply-To` and `References` headers
with the original's `Message-Id`. Otherwise the follow-up arrives as a separate email and
looks like a new outreach blast.

---

## 3. SENDING PIPELINE

Four states, with a human between them.

```
Company queue
   ↓  (automatic, overnight or by button)
Draft preparation: template selection, substitution, AI paragraph, validation
   ↓
status = draft, sits on the "To send" page
   ↓  (human reads, edits if needed, clicks Send)
status = approved → sent via Gmail API → status = sent
   ↓  (in the background, once an hour)
Reply and bounce checking
```

### Draft preparation

An automatic step, run by command or by cron.

Template selection is deterministic, not via LLM:

```
open vacancy exists                        → template: vacancy
no vacancy, named contact exists            → template: studio_named
no vacancy, only hello@ or info@            → template: studio_generic
```

Language: company country UA means `uk`, everything else `en`.
If the company's site is dominated by another language, it's still `en`, no guessing.

### Substitution

Placeholders in templates: `{name}`, `{company}`, `{city}`, `{country}`, `{stack}`, `{role}`.

**If a required placeholder is empty, the draft is not created.**
It gets `status = draft` with an `error` field and shows up in a separate "Needs attention" tab.
An email with the text "Hi ," must never exist, not even as a draft.

### Sending

- Only one email at a time, only by clicking
- Minimum pause between sends is **3 minutes**, baked into the code.
  An attempt to send earlier is blocked with an explanation and a timer in the UI
- Daily limit: constant `DAILY_SEND_LIMIT`, starting value **20**
- Warm-up: the first 3 days the limit is automatically 5, days 4-7 it's 10, after that 20.
  Counted from the date of the first send, stored in `send_log`
- Do not send between 22:00 and 08:00 Kyiv time, and not on weekends.
  An email at midnight on a Saturday looks like a bot

---

## 4. AI PERSONALIZATION

### What exactly gets personalized

**Only the first paragraph.** The second paragraph (experience, stack, projects) and the third
(link, signature) are taken from the template unchanged. This is intentional: the second
paragraph contains facts about the owner, and generating it would mean risking invented experience.

### Input data for the model

Only what's already in the DB for this company:
- name, domain, city, country, size
- `tech_hints` from the site scan
- tags from the catalog
- description from the catalog (first 400 characters)
- vacancy title and its stack, if there is one

Plus `facts` from the DB: a short whitelist of facts about the owner the model is allowed to mention.

### Prompt

```
Ти пишеш перший абзац холодного листа розробника до веб-студії.

Правила:
1. Рівно 2 речення. Не більше.
2. Абзац про КОМПАНІЮ, не про відправника. Відправник згадується з другого абзацу.
3. Використовуй ТІЛЬКИ факти з блоку COMPANY нижче. Нічого не додавай.
4. Якщо фактів замало для конкретного речення, напиши загальніше,
   але НЕ вигадуй проєкти, клієнтів, нагороди, цифри чи новини.
5. Заборонено: em dash, знак оклику, слова excited, passionate, thrilled,
   reach out, I hope this finds you well, конструкції "not X but Y".
6. Без привітання і без звертання, вони додаються шаблоном.
7. Мова: {language}.

COMPANY:
{company_json}

Поверни СТРОГО JSON без markdown і без преамбули:
{"paragraph": "...", "facts_used": ["..."], "confidence": 0-100}
```

Model: `claude-haiku-4-5-20251001`. Temperature 0.7.

Note: the prompt above is kept in Ukrainian on purpose. It is fed to the model as literal
instruction text and its own rules require it to produce Ukrainian output when `{language}`
is `uk`, so it is data, not prose to translate. See the translation exceptions in this pass.

### Validation (deterministic, after the model)

This is the key part. The model proposes, the code decides.

```
1. Zod parsing. Invalid JSON → one retry → fall back to the template paragraph
2. Sentence count 1-3, length 20-60 words. Otherwise fall back
3. Em dash present → auto-replace with a comma
4. Stop word from the list → fall back to the template paragraph
5. Check for invented entities:
   extract every proper name and number from the paragraph,
   each one must appear in the input company_json,
   otherwise fall back
6. confidence < 60 → fall back
```

**Falling back means using the static first paragraph from the template.**
The system never sends an email without a first paragraph and never gets blocked because of the LLM.

Every fallback is logged with a reason. The Statistics page shows the share of fallbacks by reason.
If it's above 30 percent, the prompt is bad, that's a signal to fix it.

### Budget

One call per company, the result is cached in `outreach.ai_paragraph`.
Regeneration only via the explicit "Regenerate" button in the UI.
No background regenerations.

---

## 5. REPLY DETECTION

Cron once an hour.

1. For each `outreach` row with `status = sent` and no `reply_at`, fetch the thread via
   `users.threads.get` using `gmail_thread_id`
2. If a message from someone other than the owner appears in the thread, that's a reply
3. Classify the type via LLM (cheap, short prompt):
   `positive | rejection | autoreply | ooo | unclear`
4. Record `reply_at`, `reply_type`, update `company_state.status = replied`
5. `positive` triggers an immediate Telegram notification

### Bounces

Signs: sender is `mailer-daemon@` or `postmaster@`, subject contains
`Delivery Status Notification`, `Undelivered`, `Returned mail`.

A hard bounce means marking the contact as invalid, not blocking the company,
trying another contact if one exists.

**If the bounce share over the last 50 emails exceeds 3 percent, sending is blocked
entirely until manually unblocked.** This is not a warning, it's a stop. Continuing to send
during a high bounce rate ruins the sender's reputation.

---

## 6. FOLLOW-UPS

- Exactly **one** follow-up per company, no more
- After 7-9 days (random within this range) after the original
- Only if `reply_type` is empty and there was no hard bounce
- Must be in the same thread
- Template `followup`, 2 sentences maximum
- The follow-up goes through the same confirmation queue, it does not fly automatically
- If the system has nothing to add to the email (no new fact), the follow-up is still
  allowed, but the UI shows a hint to add one sentence about recent progress

Every day at 10:00 Telegram sends the list of companies ready for a follow-up.

---

## 7. UI

A new "Outreach" section with three pages.

### 7.1 To send

The main working screen.

- List of drafts, sorted by `outreach_priority`
- Card: company, contact, subject, full email text, AI or Template badge
- Text is **edited right in the card**, changes are saved to `body_final`
- Buttons: `Send` (hotkey), `Regenerate paragraph`, `Skip`, `Delete`
- At the top: counter `sent today 7 of 20`, timer until the next allowed send
- When the limit is reached, buttons are disabled, showing when it unlocks
- "Needs attention" tab: drafts with unfilled placeholders

### 7.2 Sent

- Table: company, date, template, language, AI yes/no, status, reply type
- Filters by status and period
- Highlighting of those due for a follow-up
- Click opens the full text of what was sent

### 7.3 Templates

- Template editor with placeholder highlighting
- Preview on a real company from the database
- List of available `facts` with activity checkboxes
- Validation on save: em dash, stop words, length over 150 words

### Additions to Statistics

- Conversion by template: sent, replied, positive
- AI versus static paragraph conversion
- Share of validation fallbacks broken down by reason
- Bounce rate over the last 50 emails
- Median time to reply

---

## 8. TELEGRAM

Add to the existing notifications:
- 10:00: how many drafts are ready, how many follow-ups are due
- Immediately: a positive reply
- Immediately: bounce rate exceeded the threshold and sending is blocked
- Immediately: Gmail token expired

---

## 9. SAFEGUARDS

List of what the system must refuse to do.

- Send a second email to a company with status `contacted` sooner than 90 days
- Send an email to a company with status `blacklist`, `rejected_by_me`, `rejected_by_them`
- Send to an address that already produced a hard bounce
- Send more than `DAILY_SEND_LIMIT` per day
- Send sooner than 3 minutes after the previous one
- Send at night or on weekends
- Send an email with an unfilled placeholder
- Send an email longer than 160 words
- Send while the bounce rate is above the threshold
- Send more than one follow-up

Each safeguard is a separate function with a test. Do not inline checks in the UI handler.

---

## 10. STAGES

**Stage 1.** Tables `templates`, `facts`, extension of `outreach`. Three base templates,
placeholder substitution, draft generation. Output to the console.

**Stage 2.** Gmail OAuth, `auth:gmail`, sending one test email to the owner's own address.

**Stage 3.** "To send" page, send button, all safeguards with tests.

**Stage 4.** AI paragraph with full validation and fallback. Manually compare 10 generated
paragraphs before turning it on for the live flow.

**Stage 5.** Reply and bounce detection, "Sent" page.

**Stage 6.** Follow-ups, Telegram, statistics by template.

After Stage 3 the module is already usable daily. AI is an improvement, not a blocker.
Do not postpone starting outreach until Stage 6.

---

## 11. TESTS

Mandatory, a stage isn't closed without them:

- Every safeguard from section 9, a separate test for each
- AI paragraph validator: em dash, invented company name, invented number,
  paragraph too long, invalid JSON, low confidence
- Substitution with an empty placeholder
- Building RFC 2822 with Cyrillic in the subject and body (encoding check)
- Follow-up threading: correct `In-Reply-To` and `References`
- Limit warm-up logic by day

**A dedicated test for Cyrillic is mandatory.** Incorrect encoding of a Ukrainian email
is a silent bug that's only visible to the recipient.

---

## 12. WHAT NOT TO DO

- Do not build send autopilot in any form
- Do not build HTML emails or fancy signatures with images
- Do not build open tracking
- Do not generate the whole email via LLM, only the first paragraph
- Do not attach a resume file to a cold email
- Do not do A/B tests at this volume, the sample is too small for conclusions
- Do not integrate third-party mailing services, that's a direct path to getting blocked
