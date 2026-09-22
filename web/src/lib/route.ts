/**
 * The page address lives in the hash: `#/companies/acme.com`.
 *
 * Before this the section was just state inside App, and a link to one specific
 * company did not exist. Every move between sections had to be threaded as another
 * prop through the whole tree, and there were more of those every week.
 *
 * The hash rather than the History API, deliberately. The application is served as
 * static files both from the worker and from `vite preview`, and real paths require
 * the server to answer any of them with `index.html`. A hash works everywhere with
 * no configuration, and it costs one extra character in the address. There is no
 * router library here on purpose either: a dependency to parse two segments is the
 * kind of extra part section 11 of CLAUDE.md is written against.
 *
 * What this buys: a link to a company can be put anywhere. Into a draft, into the
 * correspondence history, into the Telegram digest, into browser bookmarks. And the
 * back button starts behaving the way people expect.
 *
 * Only the address itself lives here, nothing else: no `window`, no React. That is
 * exactly why an ordinary test covers it along with the rest of the code, instead of
 * a click in a browser. The subscription to changes lives separately, in `useRoute`.
 */

/** Splits the hash into segments. Exported for the test: the edge cases live here. */
export function parse(hash: string): string[] {
  return hash
    .replace(/^#\/?/, '')
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        // Broken percent-encoding in the address is no reason to show a white screen.
        return part;
      }
    });
}

export function href(...segments: string[]): string {
  return `#/${segments.map(encodeURIComponent).join('/')}`;
}

/** Link to a company card. By domain, because that is how the Companies page finds it. */
export function companyHref(domain: string): string {
  return href('companies', domain);
}
