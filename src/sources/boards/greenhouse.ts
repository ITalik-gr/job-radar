import { fetchText } from '../../lib/http.js';
import { anyToText } from '../../lib/html.js';
import { normalizeUrl } from '../../lib/normalize.js';
import type { BoardSource, RawVacancy, SourceContext } from '../registry.js';

const SOURCE = 'greenhouse';

interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  updated_at?: string;
  first_published?: string;
  company_name?: string;
  content?: string;
  location?: { name?: string } | null;
  offices?: { name?: string; location?: string }[];
}

interface GreenhousePayload {
  jobs?: GreenhouseJob[];
}

export function boardUrl(slug: string): string {
  return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
}

function looksRemote(location: string | null): boolean | null {
  if (!location) return null;
  return /remote|anywhere|distributed/i.test(location);
}

export function parse(payload: string, ctx: SourceContext = {}): RawVacancy[] {
  const data = JSON.parse(payload) as GreenhousePayload;
  const jobs = data.jobs ?? [];
  const domain = ctx.company?.domain ?? null;

  return jobs.map((job) => {
    const location = job.location?.name?.trim() || job.offices?.[0]?.location?.trim() || null;
    const posted = job.first_published ?? job.updated_at ?? null;
    return {
      source: SOURCE,
      externalId: String(job.id),
      url: normalizeUrl(job.absolute_url) ?? job.absolute_url,
      title: job.title?.trim() ?? null,
      rawText: anyToText(job.content),
      companyName: job.company_name?.trim() ?? ctx.company?.name ?? null,
      companyDomain: domain,
      location,
      remote: looksRemote(location),
      postedAt: posted ? Date.parse(posted) || null : null,
    } satisfies RawVacancy;
  });
}

export const greenhouse: BoardSource = {
  id: SOURCE,
  kind: 'board',
  requiresSlug: true,
  parse,
  async fetch(ctx: SourceContext) {
    const slug = ctx.slug ?? ctx.company?.careersSlug;
    if (!slug) throw new Error('greenhouse: board slug required');
    const res = await fetchText(boardUrl(slug), { ignoreRobots: false });
    return parse(res.body, ctx);
  },
};
