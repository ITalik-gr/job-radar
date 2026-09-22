import { readFileSync } from 'node:fs';
import { normalizeDomain } from '../lib/normalize.js';
import { upsertCompany } from '../pipeline/companies.js';

export interface CsvRow {
  name: string;
  domain: string;
  country?: string;
  note?: string;
  ats?: string;
  slug?: string;
  careers_url?: string;
}

/** Minimal CSV parser: comma as the separator, quotes doubled up inside a field. */
export function parseCsv(input: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows.filter((r) => r.some((cell) => cell.trim() !== ''));
  if (!header) return [];
  const keys = header.map((k) => k.trim().toLowerCase());

  return body.map((cells) => {
    const record: Record<string, string> = {};
    keys.forEach((key, index) => {
      record[key] = (cells[index] ?? '').trim();
    });
    return record;
  });
}

export interface ImportReport {
  created: number;
  updated: number;
  skipped: { line: number; reason: string }[];
}

export async function importCsvFile(path: string, source = 'csv'): Promise<ImportReport> {
  const report: ImportReport = { created: 0, updated: 0, skipped: [] };
  const rows = parseCsv(readFileSync(path, 'utf8'));

  for (const [index, row] of rows.entries()) {
    const line = index + 2;
    const name = row.name ?? '';
    const domain = normalizeDomain(row.domain ?? '');

    if (!name || !domain) {
      report.skipped.push({ line, reason: !name ? 'missing name' : `invalid domain: ${row.domain}` });
      continue;
    }

    const { created } = await upsertCompany({
      name,
      domain,
      country: row.country || null,
      note: row.note || null,
      careersKind: row.ats || null,
      careersSlug: row.slug || null,
      careersUrl: row.careers_url || null,
      source,
    });

    if (created) report.created += 1;
    else report.updated += 1;
  }

  return report;
}
