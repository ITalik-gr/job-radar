import { fetchText } from '../../lib/http.js';
import { normalizeDomain } from '../../lib/normalize.js';
import { log } from '../../lib/log.js';
import { readSetting, writeSetting } from '../../lib/settings-store.js';
import type { BoardSource, RawVacancy, SourceContext } from '../registry.js';

/**
 * Getro is the engine behind accelerator and fund job boards: Techstars, and then dozens of other
 * networks on the same code. One adapter opens all of them, because they differ only in domain
 * and collection number.
 *
 * Why it suits startups: vacancies come with role titles, so the title check from scoring works as
 * usual, and "do they need a front end developer" becomes visible exactly rather than guessed. The
 * robots.txt of these domains holds only a Sitemap, that is, it allows everything.
 *
 * The list renders on the client, but **search runs on the server**: `?q=frontend` returns ready
 * HTML with the matching vacancies. So a few narrow queries are used instead of paging through,
 * which also means fewer requests to someone else's site.
 */

export interface GetroNetwork {
  id: string;
  host: string;
}

/**
 * The networks we poll. Adding one means adding a line, the code stays untouched.
 *
 * Each was checked with a `?q=frontend` query and by reading `robots.txt`: all of them hold only a
 * Sitemap, so collection is allowed. The check is mandatory before adding a new one: not every
 * board is on Getro, some funds use another engine with an empty SSR.
 */
export const GETRO_NETWORKS: GetroNetwork[] = [
  { id: 'techstars', host: 'jobs.techstars.com' },
  { id: 'accel', host: 'jobs.accel.com' },
  { id: 'lererhippeau', host: 'jobs.lererhippeau.com' },
  { id: 'craftventures', host: 'jobs.craftventures.com' },
  { id: 'uncork', host: 'jobs.uncorkcapital.com' },
  { id: 'greycroft', host: 'jobs.greycroft.com' },
  { id: 'primary', host: 'jobs.primary.vc' },
  { id: 'underscore', host: 'jobs.underscore.vc' },
  { id: 'khosla', host: 'jobs.khoslaventures.com' },
  { id: 'scalevp', host: 'jobs.scalevp.com' },
  { id: 'signalfire', host: 'jobs.signalfire.com' },
  { id: 'pointnine', host: 'jobs.pointnine.com' },
];

/*
 * Narrow queries instead of paging through the whole board. Three rather than five: every query is
 * a separate trip to someone else's site, and with twelve networks five queries would mean sixty
 * requests per pass instead of thirty-six.
 * "full stack" covers both fullstack and full-stack, because Getro search ignores hyphens.
 */
export const GETRO_QUERIES = ['frontend', 'react', 'full stack'];

/** The next network in the list. `null` means the pass over all of them is finished. */
export function nextGetroNetwork(current?: string | null): string | null {
  if (!current) return GETRO_NETWORKS[0]?.id ?? null;
  const at = GETRO_NETWORKS.findIndex((network) => network.id === current);
  if (at < 0) return null;
  return GETRO_NETWORKS[at + 1]?.id ?? null;
}

const JOB_LINK = /<a\b[^>]*href="(\/companies\/([a-z0-9._-]+)\/jobs\/(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, '\n')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#\d+;/g, ' ');
}

function lines(html: string): string[] {
  return text(html)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/**
 * A card is a title, the company name under it, then labelled fields. The flattened text between
 * two vacancy links is parsed: Getro markup is generated and its classes are unstable, while the
 * order of labels is stable.
 */
/** The company slug is needed only inside this adapter, to fetch the domain. */
export interface GetroVacancy extends RawVacancy {
  companySlug: string;
}

export function parseGetro(html: string, host: string): GetroVacancy[] {
  const matches = [...html.matchAll(JOB_LINK)];
  const found = new Map<string, GetroVacancy>();

  for (const [index, match] of matches.entries()) {
    const [full, path, companySlug, externalId, inner] = match;
    const title = lines(inner!)[0] ?? null;
    if (!title || title.length > 140) continue;

    const start = match.index! + full!.length;
    const end = index + 1 < matches.length ? matches[index + 1]!.index! : Math.min(html.length, start + 4000);
    const after = lines(html.slice(start, end));

    const labelValue = (label: string): string | null => {
      const at = after.findIndex((line) => line.toLowerCase() === `${label}:`);
      return at >= 0 ? (after[at + 1] ?? null) : null;
    };

    const location = labelValue('location');
    // The first line after the title is the company name, the labels follow.
    const companyName = after.find((line) => line.length < 60 && !line.endsWith(':')) ?? null;

    const url = `https://${host}${path!}`;
    if (found.has(url)) continue;

    found.set(url, {
      source: 'getro',
      externalId: externalId!,
      url,
      title,
      rawText: [title, companyName, location].filter(Boolean).join('\n'),
      companyName: companyName === title ? null : companyName,
      companyDomain: null,
      location,
      remote: location ? /remote/i.test(location) : null,
      postedAt: null,
      companySlug: companySlug!,
    });
  }

  return [...found.values()];
}

/**
 * The key in the `settings` table that holds the mapping of company slug to its domain.
 *
 * Why a persistent cache rather than a per-run one: twelve networks give about 250 different
 * companies, and without a cache every six hours on schedule would be 250 needless trips to other
 * people's sites for data that does not change. A company slug and domain are stable.
 */
const DOMAIN_CACHE_KEY = 'getro:domains';

/**
 * The company domain is not shown on the list page, and without it a vacancy will not merge with
 * the same vacancy from the company ATS or attach to an existing card in the database. Hence one
 * extra request per company, and only when it is not cached yet.
 */
async function resolveDomain(
  host: string,
  slug: string,
  cache: Map<string, string | null>,
  key = `${host}:${slug}`,
): Promise<string | null> {
  if (cache.has(key)) return cache.get(key)!;

  try {
    const res = await fetchText(`https://${host}/companies/${slug}`);
    const external = [...res.body.matchAll(/href="(https?:\/\/[^"]+)"/gi)]
      .map((match) => match[1]!)
      .find((url) => {
        const domain = normalizeDomain(url);
        if (!domain) return false;
        return !/getro|filepicker|linkedin|twitter|x\.com|crunchbase|facebook|instagram|youtube|google|sentry|startup(weekend|week|digest)/i.test(
          domain,
        ) && !domain.endsWith(host.replace(/^jobs\./, ''));
      });

    const domain = external ? normalizeDomain(external) : null;
    cache.set(key, domain);
    return domain;
  } catch {
    cache.set(key, null);
    return null;
  }
}

export const getro: BoardSource = {
  id: 'getro',
  kind: 'board',

  parse(payload: string, ctx?: SourceContext): RawVacancy[] {
    return parseGetro(payload, ctx?.slug ?? 'jobs.techstars.com');
  },

  /*
   * `slug` here is the network id, and it means "go through only this one".
   *
   * Twelve networks in one pass is three and a half dozen requests to other sites plus a company
   * page for every new domain, with a one second pause per host. In a worker such a pass does not
   * finish in time and the platform kills it, so the pass is split by network: one network is one
   * request, and the interface sees who goes next in `nextGetroNetwork`.
   */
  async fetch(ctx: SourceContext = {}): Promise<RawVacancy[]> {
    const all = new Map<string, GetroVacancy>();
    const networks = ctx.slug
      ? GETRO_NETWORKS.filter((network) => network.id === ctx.slug)
      : GETRO_NETWORKS;

    if (ctx.slug && networks.length === 0) throw new Error(`unknown Getro network: ${ctx.slug}`);

    // The cache outlives the run: it lives in the `settings` table.
    const stored = await readSetting<Record<string, string | null>>(DOMAIN_CACHE_KEY, {});
    const domains = new Map<string, string | null>(Object.entries(stored));
    const knownBefore = domains.size;

    for (const network of networks) {
      for (const query of GETRO_QUERIES) {
        try {
          const res = await fetchText(
            `https://${network.host}/jobs?q=${encodeURIComponent(query)}`,
          );
          for (const vacancy of parseGetro(res.body, network.host)) {
            if (!all.has(vacancy.url)) all.set(vacancy.url, vacancy);
          }
        } catch (error) {
          log.warn({ network: network.id, query, err: String(error) }, 'getro: query failed');
        }
      }

      for (const vacancy of all.values()) {
        if (vacancy.companyDomain) continue;
        // Keyed with the host: the same slug in different networks may mean different companies.
        const key = `${network.host}:${vacancy.companySlug}`;
        vacancy.companyDomain = await resolveDomain(network.host, vacancy.companySlug, domains, key);
      }
    }

    if (domains.size > knownBefore) {
      await writeSetting(DOMAIN_CACHE_KEY, Object.fromEntries(domains));
      log.info(
        { known: domains.size, resolved: domains.size - knownBefore },
        'getro: domain cache updated',
      );
    }

    return [...all.values()];
  },
};
