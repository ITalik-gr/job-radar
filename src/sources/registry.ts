import type { Company } from '../db/schema.js';

export type SourceKind = 'catalog' | 'board' | 'lead';

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
  /** Identity for a company without a site: the state register code or the Google place. */
  registryCode?: string | null;
  placeId?: string | null;
  phone?: string | null;
  address?: string | null;
  industry?: string | null;
  /** The segment, when the source knows it: a business directory knows a clinic is an smb. */
  kind?: string | null;
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

/** A person to write to about a lead, as the source published them. */
export interface RawContact {
  name: string | null;
  role: string | null;
  email: string | null;
  phone: string | null;
}

/**
 * Explicit demand: a tender, a funding round, a public request. The company is the one with the
 * demand (the buyer of a tender); null when the source names no company we can identify, as in a
 * news item, and then the lead waits for the owner to link it.
 */
export interface RawLead {
  source: string;
  externalId: string;
  url: string;
  title: string;
  text: string | null;
  budget: number | null;
  currency: string | null;
  deadlineAt: number | null;
  company: RawCompany | null;
  contact: RawContact | null;
}

/**
 * `seen` is how many records the source returned before its own filter. It is what a run counts as
 * found: a week with no funding news is zero leads but not zero articles, and only the second
 * means the adapter broke (rule 3).
 */
export interface LeadFetch {
  leads: RawLead[];
  seen: number;
}

export interface LeadSource {
  id: string;
  kind: 'lead';
  fetch(ctx: SourceContext): Promise<LeadFetch>;
  /** Parses one saved payload, used in smoke tests. */
  parse(payload: string, ctx?: SourceContext): RawLead[];
}

export type Source = BoardSource | CatalogSource | LeadSource;

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
