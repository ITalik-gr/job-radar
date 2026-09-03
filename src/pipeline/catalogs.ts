import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { extname } from 'node:path';
import { withRun } from '../lib/runs.js';
import { log } from '../lib/log.js';
import { normalizeDomain } from '../lib/normalize.js';
import { parse as parseClutch } from '../sources/catalogs/clutch.js';
import { fetchCatalog, type FetchCatalogOptions } from '../sources/catalogs/dou.js';
import type { RawCompany } from '../sources/registry.js';
import { upsertCompany } from './companies.js';
import { parseCsv } from '../cli/commands.js';

export interface CatalogStats {
  itemsFound: number;
  itemsNew: number;
  updated: number;
  skipped: { name: string; reason: string }[];
  errors: string[];
}

/** Компанія без домену не піддається дедупу, тому не записується, а йде в skipped. */
export async function saveCompanies(items: RawCompany[], source: string): Promise<CatalogStats> {
  const stats: CatalogStats = { itemsFound: items.length, itemsNew: 0, updated: 0, skipped: [], errors: [] };

  for (const item of items) {
    const domain = item.domain ? normalizeDomain(item.domain) : null;
    if (!domain) {
      stats.skipped.push({ name: item.name, reason: 'немає домену' });
      continue;
    }

    try {
      const { created } = await upsertCompany({
        name: item.name,
        domain,
        country: item.country,
        city: item.city,
        sizeHint: item.sizeHint,
        careersUrl: item.careersUrl,
        source,
        tags: item.tags,
        description: item.description,
        sourceUrl: item.sourceUrl,
      });
      if (created) stats.itemsNew += 1;
      else stats.updated += 1;
    } catch (error) {
      const message = `${item.name}: ${error instanceof Error ? error.message : String(error)}`;
      stats.errors.push(message);
      log.warn({ err: message }, 'компанію не вдалось зберегти');
    }
  }

  return stats;
}

/** Ручний імпорт збережених сторінок каталогу і CSV-списків. */
export async function importFiles(paths: string[], source = 'clutch'): Promise<CatalogStats> {
  return withRun(`import:${source}`, async () => {
    const items: RawCompany[] = [];
    const errors: string[] = [];

    for (const path of paths) {
      try {
        const body = readFileSync(path, 'utf8');
        if (extname(path).toLowerCase() === '.csv') {
          for (const row of parseCsv(body)) {
            items.push({
              source,
              name: row.name ?? '',
              domain: row.domain ?? null,
              country: row.country ?? null,
              city: row.city ?? null,
              sizeHint: row.size ?? null,
              careersUrl: row.careers_url ?? null,
              sourceUrl: null,
              tags: row.tags ? row.tags.split(/[;|]/).map((tag) => tag.trim()) : [],
              description: row.note ?? null,
              openVacancies: null,
            });
          }
        } else {
          const parsed = parseClutch(body);
          // Мовчазний нуль це найгірший результат: файл прочитався, а розмітка чужа.
          if (parsed.length === 0) {
            errors.push(`${path}: жодної картки не розпізнано, розмітка не схожа на Clutch`);
          }
          items.push(...parsed);
        }
      } catch (error) {
        const message = `${path}: ${error instanceof Error ? error.message : String(error)}`;
        errors.push(message);
        log.warn({ err: message }, 'файл імпорту не прочитався');
      }
    }

    const stats = await saveCompanies(items, source);
    return { ...stats, errors: [...errors, ...stats.errors] };
  });
}

const browserItemSchema = z.object({
  name: z.string().min(1),
  domain: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  sizeHint: z.string().nullable().optional(),
  tags: z.array(z.string()).default([]),
  description: z.string().nullable().optional(),
  sourceUrl: z.string().nullable().optional(),
});

export interface BrowserImportResult {
  itemsFound: number;
  itemsNew: number;
  updated: number;
  skipped: number;
  errors: string[];
}

/**
 * Прийом сторінки каталогу зі збирача в браузері. Розбір робить сам браузер у вкладці,
 * яку відкрила людина, тому сюди приходить уже готовий список, а не HTML.
 */
export async function importFromBrowser(payload: {
  source?: string;
  pageUrl?: string;
  items?: unknown[];
}): Promise<BrowserImportResult> {
  const source = (payload.source ?? 'browser').replace(/[^a-z0-9.-]/gi, '').slice(0, 40) || 'browser';
  const parsed = z.array(browserItemSchema).safeParse(payload.items ?? []);

  if (!parsed.success) {
    return { itemsFound: 0, itemsNew: 0, updated: 0, skipped: 0, errors: [parsed.error.message.slice(0, 300)] };
  }

  const items: RawCompany[] = parsed.data.map((item) => ({
    source,
    name: item.name,
    domain: item.domain ?? null,
    country: item.country ?? null,
    city: item.city ?? null,
    sizeHint: item.sizeHint ?? null,
    careersUrl: null,
    sourceUrl: item.sourceUrl ?? null,
    tags: item.tags,
    description: item.description ?? null,
    openVacancies: null,
  }));

  const stats = await withRun(`browser:${source}`, async () => {
    const saved = await saveCompanies(items, source);
    return { ...saved, itemsFound: items.length };
  });

  return {
    itemsFound: items.length,
    itemsNew: stats.itemsNew,
    updated: stats.updated,
    skipped: stats.skipped.length,
    errors: stats.errors,
  };
}

export async function syncDou(options: FetchCatalogOptions = {}): Promise<CatalogStats> {
  return withRun('dou', async () => {
    const items = await fetchCatalog(options);
    return saveCompanies(items, 'dou');
  });
}
