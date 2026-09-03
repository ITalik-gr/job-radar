import { anyToText } from '../../lib/html.js';
import { fetchText } from '../../lib/http.js';
import { normalizeDomain, normalizeUrl } from '../../lib/normalize.js';
import type { BoardSource, RawVacancy, SourceContext } from '../registry.js';

const SOURCE = 'remoteok';

/**
 * RSS RemoteOK вимкнений (віддає 410), тому працюємо через їх публічний JSON.
 * Перший елемент масиву це юридична примітка, а не вакансія, її треба відкидати.
 */
export const API_URL = 'https://remoteok.com/api';

interface RemoteOkJob {
  id?: string;
  slug?: string;
  epoch?: number;
  date?: string;
  company?: string;
  company_logo?: string;
  position?: string;
  tags?: string[];
  description?: string;
  location?: string;
  salary_min?: number;
  salary_max?: number;
  url?: string;
  apply_url?: string;
  legal?: string;
}

export function parse(payload: string, _ctx: SourceContext = {}): RawVacancy[] {
  const rows = JSON.parse(payload) as RemoteOkJob[];
  if (!Array.isArray(rows)) throw new Error('remoteok: очікувався масив');

  return rows
    .filter((row) => !row.legal && Boolean(row.id) && Boolean(row.position))
    .map((row) => {
      const url = row.url ?? row.apply_url ?? '';
      const salary =
        row.salary_min && row.salary_max ? `\n\nSalary: ${row.salary_min} - ${row.salary_max} USD` : '';
      const tags = row.tags?.length ? `\n\nTags: ${row.tags.join(', ')}` : '';

      return {
        source: SOURCE,
        externalId: row.id ?? null,
        url: normalizeUrl(url) ?? url,
        title: row.position?.trim() ?? null,
        rawText: `${anyToText(row.description)}${tags}${salary}`.trim(),
        companyName: row.company?.trim() ?? null,
        companyDomain: row.company_logo ? normalizeDomain(row.company_logo) : null,
        location: row.location?.trim() || null,
        remote: true,
        postedAt: row.epoch ? row.epoch * 1000 : row.date ? Date.parse(row.date) || null : null,
      } satisfies RawVacancy;
    });
}

export const remoteok: BoardSource = {
  id: SOURCE,
  kind: 'board',
  parse,
  async fetch(ctx: SourceContext) {
    const res = await fetchText(API_URL, { headers: { accept: 'application/json' } });
    return parse(res.body, ctx);
  },
};
