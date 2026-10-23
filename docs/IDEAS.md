# IDEAS.md: ideas to discuss

Not planned, not started. Each idea gets discussed with the owner before it becomes a stage.

## Problem collector ("is there a tool for this?")

Recorded 2026-10-23.

**The idea.** People ask in public where to find a tool for a task: "is there an app that
does X", "what do you use for Y", "looking for software to Z", "чи є програма, щоб...",
"чим ви робите...", "посоветуйте сервис для...". Each such post is a person with a concrete
problem and no solution yet. Collected and grouped, they become two things:

1. **Leads**: a business owner asking how to automate their bookings or invoices is a client
   for a custom build, today.
2. **Ideas**: the same request repeated by many people with no good answer is a product idea
   (a small SaaS, a bot, a template) the owner could build and sell.

**Where to look.** Conversational places where people ask for advice:

- Reddit: r/SaaS, r/smallbusiness, r/Entrepreneur, r/nocode, r/software, r/AskReddit-style
  "what do you use" threads, niche subreddits (r/dentistry, r/restaurateur, r/realtors)
- X (Twitter), Threads, Bluesky
- Ukrainian: Telegram chats of business owners, DOU forum, Facebook groups (manual only)
- Hacker News "Ask HN", Indie Hackers, Product Hunt discussions
- Quora and Stack Exchange "software recommendations"

**Phrases to match** (per language): "is there an app", "is there a tool", "any software
for", "what do you use for", "looking for a tool", "alternative to", "I wish there was";
"чи є програма", "чи є сервіс", "чим користуєтесь", "порадьте сервіс", "як автоматизувати";
"есть ли программа", "посоветуйте сервис", "чем пользуетесь".

**How it could fit the radar.**

- A new source kind `ask` next to `lead` and `catalog`, one adapter per platform with a fixture
  test (hard rule 2)
- A table of requests: platform, url, author handle (public only), text, posted_at, language,
  matched phrase
- Clef questions, no generated text: is this a real tool request (noul), category (choice from
  a list in config), is the author a business or an individual, would a custom build or a
  small product answer it (choice)
- Grouping: the `bge-m3` vectors already used for "find similar" cluster requests into
  problems, a cluster's size and freshness rank it
- UI: an "Ideas" page with clusters (problem, how many asked, examples with links) and a
  "Requests" list where a business request can be turned into a company lead by hand

**Open questions and traps to check before building.**

- Access and terms: the Reddit API needs an app and has rate limits and commercial terms;
  the X API is paid; Threads has a limited official API; Telegram chats need membership.
  Hard rule 5 applies: official APIs within terms, no scraping behind logins, no fake accounts
- Replying: the radar never posts or replies automatically (rule 10 spirit). Answering a
  thread is a human action, and spammy replies burn the owner's accounts
- Privacy: store only public posts and public handles, no profile harvesting
- Noise: most matches are consumers asking for free apps; the business filter matters most
- Is this part of Lead Radar or a separate tool? Leads part fits; the product ideas part may
  deserve its own project
