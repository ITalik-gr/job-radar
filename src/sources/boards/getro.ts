import { fetchText } from '../../lib/http.js';
import { normalizeDomain } from '../../lib/normalize.js';
import { log } from '../../lib/log.js';
import { readSetting, writeSetting } from '../../lib/settings-store.js';
import type { BoardSource, RawVacancy, SourceContext } from '../registry.js';

/**
 * Getro це рушій, на якому крутяться дошки вакансій акселераторів і фондів:
 * Techstars, а далі десятки інших мереж під тим самим кодом. Один адаптер відкриває
 * усі, бо різниця між ними лише в домені і номері колекції.
 *
 * Чому саме він для стартапів: вакансії приходять з назвами ролей, тому перевірка
 * назви зі скорингу працює як завжди, і "чи треба їм фронтендер" стає видно точно,
 * а не вгадується. robots.txt цих доменів містить тільки Sitemap, тобто дозволяє все.
 *
 * Список рендериться на клієнті, але **пошук працює на сервері**: `?q=frontend`
 * віддає готовий HTML з відповідними вакансіями. Тому беремо кількома вузькими
 * запитами замість гортання пагінації, і це заодно менше запитів до чужого сайта.
 */

export interface GetroNetwork {
  id: string;
  host: string;
}

/**
 * Мережі, які опитуємо. Додати нову означає дописати рядок, код чіпати не треба.
 *
 * Кожна перевірена запитом `?q=frontend` і читанням `robots.txt`: у всіх там лише
 * Sitemap, тобто збір дозволений. Перевірка обовʼязкова перед додаванням нової:
 * не всі дошки на Getro, у частини фондів там інший рушій і SSR порожній.
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
 * Вузькі запити замість гортання всього борду. Три, а не пʼять: кожен запит це
 * окремий похід на чужий сайт, і при дванадцяти мережах пʼять запитів дали б
 * шістдесят звернень за прохід замість тридцяти шести.
 * "full stack" покриває і fullstack, і full-stack, бо пошук Getro нечутливий до дефіса.
 */
export const GETRO_QUERIES = ['frontend', 'react', 'full stack'];

/** Наступна мережа за списком. `null` означає, що прохід по всіх завершено. */
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
 * Картка це заголовок, під ним назва компанії, далі підписані поля.
 * Розбираємо саме сплощений текст між двома посиланнями на вакансії: розмітка Getro
 * генерована і класи в ній нестабільні, а порядок підписів стабільний.
 */
/** Slug компанії потрібен лише всередині цього адаптера, щоб доважити домен. */
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
    // Перший рядок після заголовка це назва компанії, підписи йдуть далі.
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
 * Ключ у таблиці `settings`, під яким лежить відповідність slug компанії до її домену.
 *
 * Навіщо постійний кеш, а не тільки в межах прогону: дванадцять мереж дають близько
 * 250 різних компаній, і без кешу кожні шість годин за розкладом це 250 зайвих
 * походів на чужі сайти по дані, які не змінюються. Slug і домен компанії стабільні.
 */
const DOMAIN_CACHE_KEY = 'getro:domains';

/**
 * Домен компанії на сторінці списку не показується, а без нього вакансія не зіллється
 * з тією самою вакансією з ATS компанії і не привʼяжеться до наявної картки в базі.
 * Тому один додатковий запит на компанію, і лише коли його ще немає в кеші.
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
   * `slug` тут це id мережі, і він означає "пройди тільки її".
   *
   * Дванадцять мереж за один прохід це три з половиною десятки запитів до чужих
   * сайтів плюс сторінка компанії на кожен новий домен, з паузою в секунду на хост.
   * У воркері такий прохід не встигає завершитись і його вбиває платформа, тому
   * прохід ділиться на мережі: одна мережа це один запит, а хто йде наступним,
   * інтерфейс бачить у `nextGetroNetwork`.
   */
  async fetch(ctx: SourceContext = {}): Promise<RawVacancy[]> {
    const all = new Map<string, GetroVacancy>();
    const networks = ctx.slug
      ? GETRO_NETWORKS.filter((network) => network.id === ctx.slug)
      : GETRO_NETWORKS;

    if (ctx.slug && networks.length === 0) throw new Error(`невідома мережа Getro: ${ctx.slug}`);

    // Кеш переживає прогін: він лежить у таблиці `settings`.
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
          log.warn({ network: network.id, query, err: String(error) }, 'getro: запит не вдався');
        }
      }

      for (const vacancy of all.values()) {
        if (vacancy.companyDomain) continue;
        // Ключ із хостом: один slug у різних мереж може означати різні компанії.
        const key = `${network.host}:${vacancy.companySlug}`;
        vacancy.companyDomain = await resolveDomain(network.host, vacancy.companySlug, domains, key);
      }
    }

    if (domains.size > knownBefore) {
      await writeSetting(DOMAIN_CACHE_KEY, Object.fromEntries(domains));
      log.info(
        { known: domains.size, resolved: domains.size - knownBefore },
        'getro: кеш доменів оновлено',
      );
    }

    return [...all.values()];
  },
};
