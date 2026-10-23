/**
 * The one filter shape, the same as `src/pipeline/filters.ts`: the Companies page, the
 * Leads page, saved filters and `search_companies` over MCP all speak it.
 */
export interface CompanyFilter {
  search?: string;
  market?: 'ua' | 'intl';
  country?: string;
  city?: string;
  kind?: string[];
  industry?: string[];
  source?: string;
  tags?: string[];
  status?: string[];
  hasEmail?: boolean;
  hasNamedContact?: boolean;
  hasSite?: boolean;
  hasAuditIssues?: boolean;
  hiring?: boolean;
  minScore?: number;
  maxScore?: number;
  minRating?: number;
  minFit?: number;
  fitService?: string[];
  fitStage?: string[];
  includeContacted?: boolean;
}

/** URL parameters for a filter: lists comma separated, booleans 1 or 0, empty values dropped. */
export function filterParams(filter: CompanyFilter): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) continue;
    if (Array.isArray(value)) params[key] = value.join(',');
    else if (typeof value === 'boolean') params[key] = value ? '1' : '0';
    else params[key] = String(value);
  }
  return params;
}

const LIST_PARAMS = ['kind', 'industry', 'tags', 'status', 'fitService', 'fitStage'];
const BOOLEAN_PARAMS = ['hasEmail', 'hasNamedContact', 'hasSite', 'hasAuditIssues', 'hiring', 'includeContacted'];
const NUMBER_PARAMS = ['minScore', 'maxScore', 'minRating', 'minFit'];
const STRING_PARAMS = ['search', 'market', 'country', 'city', 'source'];

/**
 * The reverse of `filterParams`, for a filter kept in the page address. Unknown keys are ignored:
 * the address also holds things that are not the filter, such as the sort.
 */
export function filterFromParams(params: Record<string, string>): CompanyFilter {
  const filter: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (!value) continue;
    if (LIST_PARAMS.includes(key)) filter[key] = value.split(',').filter(Boolean);
    else if (BOOLEAN_PARAMS.includes(key)) filter[key] = value === '1';
    else if (NUMBER_PARAMS.includes(key) && Number.isFinite(Number(value))) filter[key] = Number(value);
    else if (STRING_PARAMS.includes(key)) filter[key] = value;
  }
  return filter as CompanyFilter;
}
