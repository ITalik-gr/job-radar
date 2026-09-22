import { fetchText } from '../../lib/http.js';
import { anyToText } from '../../lib/html.js';
import { normalizeUrl } from '../../lib/normalize.js';
import type { BoardSource, RawVacancy, SourceContext } from '../registry.js';

const SOURCE = 'ashby';

interface AshbyJob {
  id: string;
  title: string;
  jobUrl: string;
  location?: string | null;
  secondaryLocations?: { location?: string }[];
  isRemote?: boolean | null;
  isListed?: boolean;
  publishedAt?: string | null;
  descriptionPlain?: string;
  descriptionHtml?: string;
  compensation?: {
    scrapeableCompensationSalarySummary?: string | null;
    compensationTierSummary?: string | null;
  } | null;
}

interface AshbyPayload {
  jobs?: AshbyJob[];
}

export function boardUrl(slug: string): string {
  return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`;
}

export function parse(payload: string, ctx: SourceContext = {}): RawVacancy[] {
  const data = JSON.parse(payload) as AshbyPayload;
  const jobs = (data.jobs ?? []).filter((job) => job.isListed !== false);

  return jobs.map((job) => {
    const extra = job.secondaryLocations?.map((l) => l.location).filter(Boolean) ?? [];
    const locations = [job.location, ...extra].filter(Boolean) as string[];
    const salary = job.compensation?.scrapeableCompensationSalarySummary ?? null;
    const body = job.descriptionPlain?.trim() || anyToText(job.descriptionHtml);

    return {
      source: SOURCE,
      externalId: job.id,
      url: normalizeUrl(job.jobUrl) ?? job.jobUrl,
      title: job.title?.trim() ?? null,
      rawText: salary ? `${body}\n\nCompensation: ${salary}` : body,
      companyName: ctx.company?.name ?? null,
      companyDomain: ctx.company?.domain ?? null,
      location: locations.length > 0 ? locations.join(', ') : null,
      remote: job.isRemote ?? null,
      postedAt: job.publishedAt ? Date.parse(job.publishedAt) || null : null,
    } satisfies RawVacancy;
  });
}

export const ashby: BoardSource = {
  id: SOURCE,
  kind: 'board',
  requiresSlug: true,
  parse,
  async fetch(ctx: SourceContext) {
    const slug = ctx.slug ?? ctx.company?.careersSlug;
    if (!slug) throw new Error('ashby: board slug required');
    const res = await fetchText(boardUrl(slug));
    return parse(res.body, ctx);
  },
};
