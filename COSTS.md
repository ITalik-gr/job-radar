# Model costs

The problem is real and measured, not theoretical. Here are the numbers, the causes
and what has been done about it.

---

## What the data showed

Over one day, 03.09.2026, the `llm_usage` table (actually literally an hour or two):

| metric | value |
| --- | --- |
| calls | 500 (hit the daily ceiling) |
| input tokens | 909,243 |
| output tokens | 59,465 |
| average per call | 1,818 input, 119 output |

At the Haiku 4.5 rate (1 dollar per million input tokens, 5 per million output tokens)
that is **1.21 dollars a day**. Looks trivial, but:

- the database has 1,675 vacancies, 498 classified, so a full pass costs about **4 dollars**
- **6 vacancies ended up above the threshold**. So there are six useful results, and 498 were paid for
- on the schedule, every 6 hours brings up to 50 calls, that is roughly **15 dollars a month**
  for a tool that produces a few cards a week

So the price is not in the absolute amount, but in the ratio: **we pay 0.20 dollars per one useful vacancy**.

---

## Why it turned out this way

### 1. The model was called before the free filters

The main reason. The order was: stop words, then the model, then scoring with geo
and role. And geo and role are plain regexes, they cost nothing.

Recalculating on real data gives: **1,060 vacancies filtered out by role** (not an
engineering title) and **369 by geo** (office or tied to a region). Together, 85
percent of the whole volume. The model was paid for each of them, only to be thrown
out afterward by a free rule.

### 2. The full vacancy text went into the model

The average length of `raw_text` is 6,699 characters, the limit was 12,000. Most of
that volume is the "about the company" block, identical for every vacancy of that
company. That is, Vercel's description was paid for 87 times, once per each of their
vacancies.

### 3. The ceiling was by call count, not by usefulness

500 calls a day were spent on whatever happened first, not on whatever had a chance.

---

## What has already been done

### Free filters before the model

Now, before the call, a deterministic score is calculated without the model's
involvement. If a vacancy is filtered out by role or geo, or its score is such that
even the maximum 5 points from the model (`llm_relevance` 100 divided by 20) would
not reach the threshold, the model is not called at all. The record is still saved,
just with the deterministic score.

Expected effect on the existing data: instead of 1,675 calls, about 250, that is
**minus 85 percent**. In money, a full pass drops from 4 dollars to about 0.60.

The same rule is applied in `classify:pending`, which runs on schedule.

Verified by three tests in `tests/ingest.test.ts`: the geo rejection, a non-technical
role, and a control case where the model should indeed be called.

### Less text in the request

The limit was reduced from 12,000 to 8,000 characters (`LLM_MAX_INPUT_CHARS`). This is
a compromise: cutting further is risky, because English requirements and the salary
range often sit at the end of the description, and the model would start guessing
instead of reading.

### Cutting out the "about the company" block

Done, `src/pipeline/boilerplate.ts`. The longest common prefix and suffix among a
company's vacancies is cut **only from the text that goes to the model**. Scoring,
saving and display work with the full text.

Measured on live data, not by forecast:

| company | vacancies | shared text |
| --- | --- | --- |
| Cloudflare | 313 | 4,786 characters out of 8,466, that is 57 percent |
| Anthropic | 546 | 3,844 out of 7,860, that is 49 percent |
| Stripe | 551 | 109 characters, that is next to nothing |

**Overall savings across the database: 19.8 percent**, not 40 to 60 as this file
predicted earlier. The reason is two things: the 8,000 character ceiling already cut
off the longest texts, and a template was found in only 5 out of 11 companies with
four or more vacancies. Where a template exists, the savings really are close to half.

Safeguards: a shared part shorter than 200 characters is ignored as coincidence,
fewer than three vacancies is not a sample, and if less than 600 characters remain
after trimming, the text goes in whole. Better to pay for a few extra tokens than to
give the model a scrap and get a made-up salary range back. Eight tests in
`tests/boilerplate.test.ts`.

---

## What else can be done, in decreasing order of usefulness

### 1. Batch API (minus 50 percent on everything that runs on schedule)

Scheduled classification does not need an instant answer. The Batch API costs half
as much, the result comes back within minutes or hours. Fits `classify:pending` and
does not fit a manual button press in the interface.

### 2. Caching the system prompt

Right now the system prompt is about 400 tokens per call. The minimum size for
caching on Haiku is larger, so caching the prompt alone is not worth it. It becomes
worth it if the company description is cached alongside it when batch-processing its
vacancies.

### 3. A ceiling by money, not by count

Instead of `LLM_DAILY_CALL_LIMIT`, compute a daily limit in dollars from actual
tokens in `llm_usage`. That way the ceiling does not depend on whether today's texts
happened to be long or short.

### 4. Classify only what gets shown

The radical option: the model is called not at collection time, but the first time a
card is shown in the queue. Then that is at most 10 calls a day (the queue size),
that is cents a month. Downside: stack and salary statistics would only be computed
over the vacancies actually shown.

---

## What it should cost, done right

After all the changes made so far:

| scenario | calls per day | approximate monthly cost |
| --- | --- | --- |
| before the changes | 500 | about 15 dollars |
| filters before the model plus template trimming, current state | 30 to 50 | 1 to 2 dollars |
| plus Batch API for the schedule | 30 to 50 | under a dollar |
| classifying only the queue | up to 10 | cents |

---

## How to keep an eye on it

```bash
pnpm cli llm:budget                      # how many calls are left today
sqlite3 data/radar.db "select * from llm_usage order by day desc limit 7;"
```

In production the same thing is visible on the Statistics page, "model calls" field.
If the number grows faster than the number of cards in the queue, something is
calling the model needlessly again.
