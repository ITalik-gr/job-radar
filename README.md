# Lead Radar

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-Node%2022-3178c6)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers%20%2B%20D1-f38020)

**A personal client finder for a freelance developer or a small studio.** It collects
founders, small and medium businesses, agencies and studios worth offering your services
to, tells you why each one is worth a letter, and remembers who you already wrote to and
who said no.

> In transition. The project used to be a vacancy radar ("Job Radar") and is being turned
> into a lead radar. The plan is in [CLAUDE.md](CLAUDE.md), section 10. Code and the worker
> are still named `job-radar`.

It is built for one person: your own database, your own keys, your own mailbox. There is no
sign up and no shared server. You fork it, fill in your own values, and run it on your
laptop or on your own Cloudflare account. Hosting it for others would mean holding strangers'
mail tokens and running a cold email platform, which is a different product.

## What it does

- **Collects companies**: DOU, YC, HN "Who is hiring", Awwwards automatically; Clutch,
  GoodFirms, DesignRush, Sortlist and others through a Chrome extension in your own browser
  (they sit behind Cloudflare, and the radar does not bypass that). Planned: Prozorro
  tenders, Google Places businesses, funding news.
- **Enriches** each company: site stack, signs of an abandoned site, named contacts from team
  pages, and a site audit that gives a concrete reason to write.
- **Scores and filters** deterministically, with weights you can read and edit. A cheap model
  (Cloudflare Clef or Claude Haiku) only classifies segment, industry and fit.
- **Outreach**: your own templates with placeholders, drafts, sending through Gmail or Resend
  with daily limits, warmup and one follow-up, reply detection. Every letter is sent by your
  click, never automatically, and the model never writes letter text.
- **MCP** (planned): search, statuses, templates and settings from Claude.
- **Telegram**: a short digest and alerts, nothing in between.

## Quick start, local

Needs Node 22 and pnpm.

```bash
git clone <this repo> lead-radar && cd lead-radar
pnpm install
cp .env.example .env     # at least USER_AGENT_CONTACT and a model key
pnpm start               # migrations, API on 127.0.0.1:3000, scheduler
pnpm dev:web             # interface on http://localhost:5173, in another terminal
```

`USER_AGENT_CONTACT` is your email: it goes into the User-Agent of every request, so site
owners can see who is visiting. `pnpm cli doctor` lists what is still missing. Every
command: `pnpm cli --help`; most are also buttons on the Operations page.

If `pnpm start` fails with "Could not locate the bindings file", the native SQLite driver
was not built (for example, `ignoreScripts` is on in your global pnpm config). Run
`pnpm rebuild better-sqlite3`.

The default rules describe the author. Open **Rules** and **Templates** and make them yours
before judging the queue.

## Deploy to Cloudflare

```bash
pnpm wrangler login
pnpm cf:setup            # add --dry-run to see what it would do first
```

It finds or creates the D1 database, applies migrations, builds the frontend, deploys, and
uploads a generated `RADAR_TOKEN` (the interface password, printed once) plus the keys it
finds in `.env`. Personal values go into `wrangler.local.jsonc`, which is gitignored.
Everything else, including CI and known traps: [DEPLOY.md](DEPLOY.md).

## Chrome extension

`extension/` collects companies from catalogs you browse yourself, at a human pace: 4 to 9
seconds between pages, 25 pages per pass by default, never faster than 3 seconds or more
than 50 pages. Load it unpacked from `chrome://extensions` and set your radar address and
token in the popup. Details: [extension/README.md](extension/README.md).

## Documentation

| file | what is in it |
| --- | --- |
| [CLAUDE.md](CLAUDE.md) | rules, data model, sources, send guards, roadmap, decisions |
| [DEPLOY.md](DEPLOY.md) | the worker: secrets, mail, Telegram, AI Gateway, migrations, errors |
| [extension/README.md](extension/README.md) | the catalog collector |

## License

MIT, see [LICENSE](LICENSE).
