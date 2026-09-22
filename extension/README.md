# Job Radar Collector

A Chrome extension that collects companies from agency catalogs into your local Job Radar.

## Installation, one minute

1. Open `chrome://extensions`
2. Turn on **Developer mode** (toggle in the top right)
3. Click **Load unpacked**
4. Pick the `extension` folder from this project
5. Done, the icon appears on the toolbar. You can pin it with the puzzle-piece button

Updating after code changes: same `chrome://extensions` page, reload button on the
extension's card.

## How to use it

1. **First run:** open the popup and fill in your radar's address. As long as the
   field is empty, collecting is disabled: the extension has nowhere to send data,
   and it is better for it to say so out loud than to silently send it somewhere
   wrong
2. The radar must be running: locally `pnpm start`, or your worker on Cloudflare
3. Open a catalog: Clutch, GoodFirms, DesignRush, Sortlist, The Manifest, UpCity,
   TechBehemoths, Awwwards, Wadline
4. Browse pages as usual

Every opened page collects itself, a badge appears in the bottom right corner:

```
● Job Radar                 collapse
clutch.co
73 cards on the page   66 with a domain
12 new, 61 updated
[ Collect ]        [ Auto-walk ]
```

The popup shows server status, what was recognized on the current page, and how
much has been collected today. Auto-collect can be turned off with a toggle, and
then the "Collect this page" button works instead.

## Auto-walking pagination

The **Auto-walk** button on the panel or in the popup browses the catalog on its
own: collects the page, waits a pause, moves to the next one. Stops when pages run
out, the limit is exhausted, or the site shows a challenge.

Settings in the popup: the pause (default 4 to 9 seconds, randomized) and the page
limit per pass (25). Limits from `CLAUDE.md`, rule 4: pause no shorter than 3
seconds, no more than 50 pages per pass, no CAPTCHAs and no forged sessions. If the
site shows a challenge, the walk stops on its own.

## On-page panel

The bottom right corner always shows what is happening: which catalog this is, how
many cards were recognized, how many of them have a domain, how many were saved, and
whether the next page was found. The "Collect" and "Auto-walk" buttons are there
too. The panel can be collapsed into a compact tag.

## Where to find studios

The popup has a list of catalogs with ready-made links: Clutch (web development,
design, Ukraine, Poland, Germany, small teams), GoodFirms, DesignRush, Sortlist,
The Manifest, UpCity, TechBehemoths.

DOU is deliberately not here. Its company list does not show websites, so everything
collected from it used to be filtered out as "no domain" and nothing made it into
the database. DOU is collected by the server-side catalog adapter:
`pnpm cli catalog:dou`, which visits the company profile and gets the site from there.

## Working with a deployed radar

The radar address and token are set in the popup. There is deliberately no default
address: until you fill it in, the extension collects nothing and says so plainly.

Locally it is `http://localhost:3000`. For a deployed instance, it is your worker's
address plus `RADAR_TOKEN` in the second field. Details in `DEPLOY.md`.

## If a catalog is not recognized

The popup will say "unfamiliar", and parsing will fall back to JSON-LD, which most
catalogs emit. If that comes up empty too, send me the page URL and I will add
selectors for that site in `extension/parsers.js`, the `SITES` section.

## Sites drawn by a script

The server-side crawl reads raw HTML. On a site built with React or a similar
engine, that is an empty shell: no email, no mentions of the stack, and it looks
like "there is nothing on this site". Such domains get collected by the radar into
a separate queue.

The popup has a "sites waiting for the browser" block and a **Walk in the
background** button. It:

1. Takes the queue from the radar, up to ten domains per pass
2. Opens each one in a **background tab**, that is, it does not redirect you anywhere
3. Waits for it to load, plus another two and a half seconds for rendering
4. Reads email, stack, signs of the site being alive, and further links from the
   ready DOM
5. Navigates the same tab to contacts, "about us" and vacancies, up to three pages,
   with a three-second pause between them
6. Closes the tab, sends what it found to the radar, and holds a three-and-a-half
   second pause

Step 5 is the important one here. Reading only the home page almost always means
coming back empty-handed: it carries a pitch, the email sits on the contacts page,
and names with titles sit on the team page. The radar parses the text of these
pages with the same code it uses for pages loaded by the server, so a name from one
page and an address from another end up merged into one contact.

The pause and the per-pass limit are not arbitrary: these are other people's sites,
and they have to be visited the way a human would, section 4 of CLAUDE.md. The walk
lives in the service worker, so the popup can be closed and the work continues.

If the popup says "empty N" after a walk, that is not silence, it is a report: the
pages were read, and no email or people were found on them. Details per domain show
up when you hover over that line.
