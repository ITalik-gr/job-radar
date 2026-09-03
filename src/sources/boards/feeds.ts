import { createRssSource, type FeedConfig } from './rss.js';

function unslug(value: string): string {
  return value
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * WeWorkRemotely кладе компанію в заголовок як "Company: Position", а локацію в
 * власний тег <region>.
 */
const weworkremotely: FeedConfig = {
  id: 'rss:weworkremotely',
  url: 'https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss',
  extraTags: ['region', 'category', 'type', 'country'],
  company: (item) => {
    const [company, ...rest] = (item.title ?? '').split(':');
    return rest.length > 0 ? company!.trim() : null;
  },
  title: (item) => {
    const parts = (item.title ?? '').split(':');
    return parts.length > 1 ? parts.slice(1).join(':').trim() : item.title;
  },
  location: (item) => item.extra.region ?? null,
};

/** Himalayas не дає компанію окремим тегом, вона є у шляху /companies/<slug>/jobs/<slug>. */
const himalayas: FeedConfig = {
  id: 'rss:himalayas',
  url: 'https://himalayas.app/jobs/rss',
  company: (item) => {
    const match = /\/companies\/([^/]+)\//.exec(item.link ?? '');
    return match ? unslug(match[1]!) : null;
  },
  location: () => null,
  remote: () => true,
};

const remotive: FeedConfig = {
  id: 'rss:remotive',
  url: 'https://remotive.com/remote-jobs/feed',
  extraTags: ['company', 'location', 'type', 'category'],
  company: (item) => item.extra.company ?? null,
  location: (item) => item.extra.location ?? null,
};

export const feedConfigs = [weworkremotely, himalayas, remotive];
export const rssSources = feedConfigs.map(createRssSource);
