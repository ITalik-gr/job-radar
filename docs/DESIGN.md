# DESIGN.md: Lead Radar visual direction

Status: stage 6 in progress. Written 2026-10-23. First pass done the same day: tokens and theme
(`web/src/theme.ts`, `web/src/index.css`), the sidebar with icons, Today as one column, the one
company page `#/companies/:key` with the letter drawer `#/companies/:key/letter`, list state in the
address and back to the exact place (`web/src/lib/listMemory.ts`). Second pass the same day: every
page draws its own `PageHeader` with its main action, Outbox, Outreach, Templates, Rules, Sources,
Operations and Stats in the direction below; no skeletons (a quiet "loading" line or the block's
own frame), no scroll box inside the page scroll.

The first mockup (canvas "Lead Radar redesign") kept the current look: warm grays, blue
buttons, uppercase gray labels, almost no icons. The owner's feedback: it looks too much like
the old design, and it needs icons in many places so a screen reads at a glance. This file
records the new direction and the references it comes from. Example boards live on the same
canvas ("Kit" and "Today, direction B").

## References

Both are light, dense SaaS styles from Refero Styles (each page has a DESIGN.md with tokens):

- **Dub** (`styles.refero.design/style/b0d80806-b724-4ed1-a1d1-074edd3c9bc9`): white canvas held
  together by 1px hairlines instead of shadows, near-black text, one saturated blue for links
  and active states, small colored "feature pills" with an icon, tinted status badges with a dot,
  12px cards, a faint dotted grid texture.
- **ClickUp** (`styles.refero.design/style/efcb73cb-b84a-4ae7-9a2b-e1116f79f130`): the full pill
  (9999px) for buttons, chips, tags and nav items; a near-black filled pill as the one primary
  action; bold display type with tight negative tracking; big stat numbers; tiny uppercase
  monospace meta labels with wide tracking.

What we take: Dub's surfaces, borders, palette discipline and badges; ClickUp's pills, black
CTA, heavy headings, stat numbers and mono labels. What we leave out: marketing layout
(1200px centered page, 80px section gaps), the animated conic gradient border (CLAUDE.md says
no animations), purple brand color, dark feature panels.

## What changes against the current UI

| Now | Direction B |
|-----|-------------|
| warm gray ground `#f7f7f5` | pure white canvas, `#fafafa` only for nested panels |
| blue filled buttons | one near-black pill per screen for the main action, the rest outlined |
| 6px rounded rectangles everywhere | pills for buttons, chips, badges, nav items; 12px cards |
| uppercase gray Inter labels | uppercase monospace labels, 10 to 11px, wide tracking |
| 17px semibold page titles | Plus Jakarta Sans 700, 24px, tracking -0.03em |
| numbers inline in text | stat strip: big numbers with a caption under each |
| almost no icons | an icon on every nav item, section, reason chip, contact, button, source |
| colored text for state | tinted pill with a colored dot |

## Tokens

Colors:

| Role | Value |
|------|-------|
| canvas | `#ffffff` |
| panel (nested, hover) | `#fafafa` |
| subtle fill (chips, tabs track) | `#f4f4f5` |
| border, hairline | `#e5e5e5` |
| border, strong (outlined buttons, inputs) | `#d4d4d4` |
| text | `#171717` |
| text, secondary | `#525252` |
| text, muted (meta, placeholders) | `#737373` |
| primary action fill | `#171717`, text white |
| accent (links, active nav, focus ring) | `#2563eb`, active nav fill `#eff4ff` |
| success | text `#15803d`, tint `#dcfce7` |
| warning | text `#b45309`, tint `#fef3c7` |
| danger | text `#b91c1c`, tint `#fee2e2` |

Segment accents, one per pill, never mixed on one element: studio violet `#7c3aed`, design
pink `#db2777`, startup green `#16a34a`, product teal `#0d9488`, outstaff slate `#475569`,
smb orange `#ea580c`, ecommerce amber `#d97706`, public blue `#2563eb`.

Type:

- Display and page titles, big numbers: Plus Jakarta Sans 700, tracking -0.03em
  (24px titles, 28px stats, 18px card titles)
- Body and UI: Inter 400/500/600, 14px body, 13px table rows, 12px secondary
- Meta labels and numbers in tables: Geist Mono (substitute JetBrains Mono), labels 10 to 11px
  uppercase with 0.06em tracking, numbers tabular

Shape and space: 4px base unit, 8px element gap, 16px card padding, radius pill for buttons,
chips, badges and nav items, 12px cards, 8px inputs. Elevation is a border; the only shadow is
a 4px `rgba(0,0,0,0.06)` ring on the selected card and popovers.

Texture: a faint dotted grid (`radial-gradient` dots, 16px step, about 6 percent black) behind
the page header area only. Never behind tables or text blocks.

## Icons

`lucide-react` (already a dependency), 16px in lists and buttons, 18px in section headers,
stroke 1.75. An icon always comes with a word; an icon-only button needs a tooltip and an
`aria-label`. One meaning, one icon, across the whole app:

| Meaning | Icon |
|---------|------|
| Today | `sun` |
| Leads | `list-checks` |
| Tenders, open lead | `landmark` |
| Outreach, send | `send` |
| Companies | `building-2` |
| Stats | `chart-column` |
| Templates | `file-text` |
| Rules | `sliders-horizontal` |
| Data, sources | `database` |
| No mobile layout | `smartphone` |
| Slow site | `gauge` |
| No HTTPS | `lock-open` |
| Old copyright | `calendar-clock` |
| No site | `globe` (struck through or muted) |
| Hiring developers | `briefcase` |
| Funding news | `rocket` |
| Named contact | `user-round` |
| Email, phone | `mail`, `phone` |
| Guard passed, failed | `circle-check`, `triangle-alert` |
| Send timer | `timer` |
| Model classification | `sparkles` |
| Segment: clinic and dental, retail, studio | `stethoscope`, `store`, `pen-tool` |
| Skip, snooze, reject | `skip-forward`, `clock`, `ban` |
| Filters, export | `funnel`, `download` |

## Components (Mantine mapping)

- Theme: `primaryColor` a custom near-black scale for `Button`; `defaultRadius: 'xl'` for
  buttons and badges, `Card` and `Paper` override to 12px; `fontFamily` Inter, `headings`
  Plus Jakarta Sans; `fontFamilyMonospace` Geist Mono
- Main action: `Button` filled near-black, `leftSection` icon. Secondary: `variant="default"`
- Reason chip: `Badge variant="light"` with `leftSection` icon, color by meaning (danger for
  site issues, blue for tenders, green for hiring)
- Status: `Badge variant="dot"` (new, contacted, replied, rejected)
- Segment: `Badge variant="outline"` with the segment accent and icon
- Section header: `Group` with `ThemeIcon variant="light" radius="xl"` plus the title
- Stat strip: `SimpleGrid` of `Paper` with mono caption on top and a big number
- Nav: `NavLink` with `leftSection` icon, pill shape, count on the right in mono

## Layout: list first, details on demand

Owner's feedback on the "Today, direction B" board (2026-10-23): queue, lead card and letter
side by side is too much data at once, the screen splits into three columns. Instead:

- **Today is one column**: the stat strip and the queue as full-width rows (company, segment,
  the one main reason chip, score, quick actions on hover). Nothing else on the screen
- **A company opens as its own page** (`/companies/:id`) with a back button at the top: score
  breakdown, "Why write", contacts, leads, letter history. The same page serves Today, Leads,
  Tenders and Companies, so there is one company view, not four
- **The letter opens as a drawer** (Mantine `Drawer`, right side) from the company page or a
  queue row: template preview, send checks, timer. Closing it returns to whatever was under it
- **Back returns to the exact place**: the same list, filters, tab, scroll position, and the row
  that was opened gets focus and a highlight. How:
  - list state lives in the URL (filters, tab, page), never only in component state
  - the company link carries where it came from (`?from=` or router state), the back button
    uses history back when there is history, otherwise goes to `from`
  - scroll position is saved per list URL before leaving and restored after data loads
    (the list must render from the TanStack Query cache, so restore does not wait for a fetch)
  - the drawer is in the URL too (`?letter=1`), so browser back closes the drawer first, then
    leaves the page
  - keyboard: `J`/`K` move through the queue, `Enter` opens, `Esc` or `Backspace` goes back
- Next and previous inside the company page (`J`/`K` there too) walk the list it was opened
  from, so working the queue does not need a trip back after every card

## Rules carried over from CLAUDE.md

Light, dense, no animations, no half-screen empty states, English UI, no em dashes in copy.
A letter preview shows the owner's template with placeholders filled, never model text.
