import { inArray, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { companies, companyState, contacts, siteAudits } from '../db/schema.js';
import { COMPANY_STATUSES } from './companies.js';

/**
 * The one filter shape, section 6 of CLAUDE.md. The Companies page, the Leads page, a saved filter
 * and `search_companies` over MCP all speak it, so "UA, clinics, slow site, has email" means the
 * same rows wherever it is typed.
 *
 * Every field is optional and fields combine with AND. List fields match any of their values.
 */
export const companyFilterSchema = z
  .object({
    search: z.string().trim().min(1).optional().describe('Substring of name, domain, tags or description'),
    market: z.enum(['ua', 'intl']).optional(),
    country: z.string().trim().min(1).optional().describe('Country code as stored, UA, PL, US'),
    city: z.string().trim().min(1).optional(),
    kind: z
      .array(z.string())
      .min(1)
      .optional()
      .describe('Segments, any of: studio, design, startup, product, outstaff, smb, ecommerce, public, unknown'),
    industry: z.array(z.string()).min(1).optional().describe('Any of: clinic, dental, beauty, legal, restaurant, retail, saas, ...'),
    source: z.string().trim().min(1).optional().describe('Source id the company came from: clutch, dou, yc, ...'),
    tags: z.array(z.string()).min(1).optional().describe('Every tag must be present, case ignored'),
    status: z.array(z.enum(COMPANY_STATUSES)).min(1).optional().describe('Any of these statuses'),
    hasEmail: z.boolean().optional().describe('Has a contact address that did not bounce'),
    hasNamedContact: z.boolean().optional().describe('Has a contact with a person name'),
    hasSite: z.boolean().optional(),
    hasAuditIssues: z.boolean().optional().describe('The latest site audit found at least one issue'),
    hiring: z.boolean().optional().describe('Hiring developers right now; the signal fades after 45 days'),
    minScore: z.number().optional(),
    maxScore: z.number().optional(),
    minRating: z.number().optional().describe('Minimum catalog rating; a company without a rating does not pass'),
    minFit: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe('Minimum model fit, 0 to 100: 100 likely buyer, 67 possible, 33 unlikely. Unrated companies do not pass'),
    fitService: z
      .array(z.string())
      .min(1)
      .optional()
      .describe('Service the model picked, any of: website, mvp, ai, automation, optimization, white_label'),
    fitStage: z.array(z.string()).min(1).optional().describe('Company stage the model picked, any of: idea, early, growth, established'),
    includeContacted: z
      .boolean()
      .optional()
      .describe('Leads only: keep contacted, replied and rejected companies in the list'),
  })
  .strict();

export type CompanyFilter = z.infer<typeof companyFilterSchema>;

const LIST_FIELDS = ['kind', 'industry', 'tags', 'status', 'fitService', 'fitStage'] as const;
const BOOLEAN_FIELDS = ['hasEmail', 'hasNamedContact', 'hasSite', 'hasAuditIssues', 'hiring', 'includeContacted'] as const;
const NUMBER_FIELDS = ['minScore', 'maxScore', 'minRating', 'minFit'] as const;

/**
 * A filter from URL parameters: lists are comma separated, booleans are 1 or 0. Empty values are
 * dropped, an unknown or malformed parameter throws, so a typo never silently widens the list.
 */
export function filterFromQuery(params: Record<string, string | undefined>): CompanyFilter {
  const raw: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value.trim() === '') continue;
    if ((LIST_FIELDS as readonly string[]).includes(key)) {
      const list = value.split(',').map((item) => item.trim()).filter(Boolean);
      if (list.length > 0) raw[key] = list;
    } else if ((BOOLEAN_FIELDS as readonly string[]).includes(key)) {
      if (!['1', '0', 'true', 'false'].includes(value)) throw new Error(`${key} must be 1 or 0`);
      raw[key] = value === '1' || value === 'true';
    } else if ((NUMBER_FIELDS as readonly string[]).includes(key)) {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new Error(`${key} must be a number`);
      raw[key] = number;
    } else {
      raw[key] = value;
    }
  }
  return parseFilter(raw);
}

/** The reverse of `filterFromQuery`, for links and the web client. */
export function filterToQuery(filter: CompanyFilter): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) params[key] = value.join(',');
    else if (typeof value === 'boolean') params[key] = value ? '1' : '0';
    else params[key] = String(value);
  }
  return params;
}

/** Validates a filter from JSON: a saved filter, an MCP call, a request body. */
export function parseFilter(value: unknown): CompanyFilter {
  const result = companyFilterSchema.safeParse(value ?? {});
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new Error(`filter ${issue.path.join('.') || 'value'}: ${issue.message}`);
  }
  return result.data;
}

const status = sql`coalesce(${companyState.status}, 'new')`;

/**
 * The SQL half of a filter, for a select over `companies` left joined with `company_state`. Score
 * and hiring are computed in code and filtered there, see `studios.ts`.
 */
export function filterConditions(filter: CompanyFilter): SQL[] {
  const conditions: (SQL | undefined)[] = [
    filter.market ? sql`${companies.market} = ${filter.market}` : undefined,
    filter.country ? sql`lower(${companies.country}) = ${filter.country.toLowerCase()}` : undefined,
    filter.city ? sql`lower(${companies.city}) = ${filter.city.toLowerCase()}` : undefined,
    filter.kind ? inArray(companies.kind, filter.kind) : undefined,
    filter.industry
      ? inArray(
          sql`lower(${companies.industry})`,
          filter.industry.map((value) => value.toLowerCase()),
        )
      : undefined,
    filter.source
      ? sql`exists (select 1 from json_each(${companies.sources}) where value = ${filter.source})`
      : undefined,
    ...(filter.tags ?? []).map(
      (tag) =>
        sql`exists (select 1 from json_each(${companies.tags}) where lower(value) = ${tag.trim().toLowerCase()})`,
    ),
    filter.status ? inArray(status, filter.status) : undefined,
    filter.minRating === undefined ? undefined : sql`coalesce(${companies.rating}, 0) >= ${filter.minRating}`,
    filter.minFit === undefined ? undefined : sql`coalesce(${companies.fit}, -1) >= ${filter.minFit}`,
    filter.fitService ? inArray(companies.fitService, filter.fitService) : undefined,
    filter.fitStage ? inArray(companies.fitStage, filter.fitStage) : undefined,
    flag(
      filter.hasEmail,
      sql`exists (select 1 from ${contacts} where ${contacts.companyId} = ${companies.id}
        and ${contacts.email} is not null and ${contacts.emailValid} = 1)`,
    ),
    flag(
      filter.hasNamedContact,
      sql`exists (select 1 from ${contacts} where ${contacts.companyId} = ${companies.id}
        and ${contacts.name} is not null)`,
    ),
    flag(filter.hasSite, sql`coalesce(${companies.domain}, '') <> ''`),
    flag(
      filter.hasAuditIssues,
      sql`coalesce((select json_array_length(${siteAudits.issues}) from ${siteAudits}
        where ${siteAudits.companyId} = ${companies.id}
        order by ${siteAudits.checkedAt} desc limit 1), 0) > 0`,
    ),
  ];

  if (filter.search) {
    // Tags are matched as the JSON string: one query instead of loading the table for one word.
    const needle = `%${filter.search.toLowerCase()}%`;
    conditions.push(
      sql`(lower(${companies.name}) like ${needle}
        or lower(${companies.domain}) like ${needle}
        or lower(${companies.tags}) like ${needle}
        or lower(coalesce(${companies.description}, '')) like ${needle})`,
    );
  }

  return conditions.filter((condition): condition is SQL => condition !== undefined);
}

function flag(value: boolean | undefined, condition: SQL): SQL | undefined {
  if (value === undefined) return undefined;
  return value ? condition : sql`not (${condition})`;
}
