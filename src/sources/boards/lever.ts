import { fetchText } from '../../lib/http.js';
import { anyToText } from '../../lib/html.js';
import { normalizeUrl } from '../../lib/normalize.js';
import type { BoardSource, RawVacancy, SourceContext } from '../registry.js';

const SOURCE = 'lever';

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt?: number;
  workplaceType?: string;
  country?: string;
  descriptionPlain?: string;
  description?: string;
  additionalPlain?: string;
  categories?: {
    location?: string;
    allLocations?: string[];
    team?: string;
    department?: string;
    commitment?: string;
  };
}

export function boardUrl(slug: string): string {
  return `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json`;
}

export function parse(payload: string, ctx: SourceContext = {}): RawVacancy[] {
  const postings = JSON.parse(payload) as LeverPosting[];
  if (!Array.isArray(postings)) throw new Error('lever: очікувався масив вакансій');

  return postings.map((post) => {
    const locations = post.categories?.allLocations?.filter(Boolean) ?? [];
    const location = post.categories?.location ?? locations[0] ?? null;
    const workplace = post.workplaceType?.toLowerCase() ?? null;
    const body = post.descriptionPlain ?? anyToText(post.description);
    const extra = post.additionalPlain ? `\n\n${post.additionalPlain}` : '';

    return {
      source: SOURCE,
      externalId: post.id,
      url: normalizeUrl(post.hostedUrl) ?? post.hostedUrl,
      title: post.text?.trim() ?? null,
      rawText: `${body}${extra}`.trim(),
      companyName: ctx.company?.name ?? null,
      companyDomain: ctx.company?.domain ?? null,
      location: locations.length > 1 ? locations.join(', ') : location,
      remote: workplace ? workplace === 'remote' : null,
      postedAt: post.createdAt ?? null,
    } satisfies RawVacancy;
  });
}

export const lever: BoardSource = {
  id: SOURCE,
  kind: 'board',
  requiresSlug: true,
  parse,
  async fetch(ctx: SourceContext) {
    const slug = ctx.slug ?? ctx.company?.careersSlug;
    if (!slug) throw new Error('lever: потрібен slug дошки');
    const res = await fetchText(boardUrl(slug));
    return parse(res.body, ctx);
  },
};
