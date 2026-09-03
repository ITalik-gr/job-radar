import type { Company } from '../db/schema.js';

export type SourceKind = 'catalog' | 'board';

/** Сира вакансія від адаптера, ще без класифікації і скорингу. */
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

/** Сира компанія від каталогу. */
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
  /** Скільки вакансій каталог показує в картці. Підказка, а не факт. */
  openVacancies: number | null;
}

export interface SourceContext {
  company?: Company;
  slug?: string;
}

export interface BoardSource {
  id: string;
  kind: 'board';
  /** Джерелу потрібна компанія зі slug ATS. Без неї запускати нема сенсу. */
  requiresSlug?: boolean;
  /** true означає, що сторінка без JS порожня і потрібен playwright. */
  needsBrowser?: boolean;
  fetch(ctx: SourceContext): Promise<RawVacancy[]>;
  /** Розбір збереженої фікстури, використовується у smoke-тестах. */
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
  if (sources.has(source.id)) throw new Error(`джерело ${source.id} вже зареєстроване`);
  sources.set(source.id, source);
}

export function getSource(id: string): Source | undefined {
  return sources.get(id);
}

export function listSources(kind?: SourceKind): Source[] {
  const all = [...sources.values()];
  return kind ? all.filter((s) => s.kind === kind) : all;
}
