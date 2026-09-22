import type { Company } from '../db/schema.js';

export type SourceKind = 'catalog' | 'board';

/** A raw vacancy from an adapter, not yet classified or scored. */
export interface RawVacancy {
  source: string;
  externalId: string | null;
  url: string;
  title: string | null;
  rawText: string;
  companyName: string | null;
  companyDomain: string | null;
  location: string | null;
  remote: boolean | null;
  postedAt: number | null;
}

/** A raw company from a catalog. */
export interface RawCompany {
  source: string;
  name: string;
  domain: string | null;
  country: string | null;
  city: string | null;
  sizeHint: string | null;
  careersUrl: string | null;
  sourceUrl: string | null;
  tags: string[];
  description: string | null;
  /** How many vacancies the catalog shows on the card. A hint, not a fact. */
  openVacancies: number | null;
  /** Reputation in the catalog. Empty means the catalog didn't show it. */
  rating?: number | null;
  reviewsCount?: number | null;
  minProject?: string | null;
  hourlyRate?: string | null;
  foundedYear?: number | null;
  /** Everything else the catalog showed: awards, languages, industries, verified profile. */
  extra?: Record<string, string>;
}

export interface SourceContext {
  company?: Company;
  slug?: string;
}

export interface BoardSource {
  id: string;
  kind: 'board';
  /** The source needs a company with an ATS slug. There's no point running it without one. */
  requiresSlug?: boolean;
  /** true means the page is empty without JS and playwright is needed. */
  needsBrowser?: boolean;
  fetch(ctx: SourceContext): Promise<RawVacancy[]>;
  /** Parses a saved fixture, used in smoke tests. */
  parse(payload: string, ctx?: SourceContext): RawVacancy[];
}

export interface CatalogSource {
  id: string;
  kind: 'catalog';
  needsBrowser?: boolean;
  fetch(ctx: SourceContext): Promise<RawCompany[]>;
  parse(payload: string, ctx?: SourceContext): RawCompany[];
}

export type Source = BoardSource | CatalogSource;

const sources = new Map<string, Source>();

export function registerSource(source: Source): void {
  if (sources.has(source.id)) throw new Error(`source ${source.id} is already registered`);
  sources.set(source.id, source);
}

export function getSource(id: string): Source | undefined {
  return sources.get(id);
}

export function listSources(kind?: SourceKind): Source[] {
  const all = [...sources.values()];
  return kind ? all.filter((s) => s.kind === kind) : all;
}
