/**
 * Company details. The type describes exactly what GET /companies/:id returns: this
 * response has no score, it is computed on the fly only for the list. The type used to
 * promise a score field, and the interface showed a zero.
 */
export interface CompanyDetail {
  company: {
    id: number;
    name: string;
    domain: string;
    country: string | null;
    city: string | null;
    sizeHint: string | null;
    kind: string;
    market: string | null;
    industry: string | null;
    phone: string | null;
    address: string | null;
    hiringDevs: boolean;
    hiringRoles: number | null;
    hiringSeenAt: number | null;
    sources: string[];
    careersUrl: string | null;
    careersKind: string;
    careersSlug: string | null;
    techHints: string[];
    tags: string[];
    description: string | null;
    sourceUrl: string | null;
    firstSeen: number;
    lastChecked: number | null;
    lastChangeAt: number | null;
  };
  state: { status: string; reason: string | null; updatedAt: number } | null;
  contacts: CompanyContact[];
  outreach: OutreachRow[];
  audits: SiteAudit[];
  leads: Lead[];
}

/** A site check: the concrete reason to write. */
export interface SiteAudit {
  id: number;
  checkedAt: number;
  url: string;
  https: boolean | null;
  mobileOk: boolean | null;
  perfScore: number | null;
  lcpMs: number | null;
  cms: string | null;
  copyrightYear: number | null;
  issues: string[];
}

/** Explicit demand: a tender, a funding round, a public request. */
export interface Lead {
  id: number;
  source: string;
  url: string;
  title: string;
  budget: number | null;
  currency: string | null;
  deadlineAt: number | null;
  firstSeen: number;
  closedAt: number | null;
  fit: number | null;
  status: string;
}

export interface OutreachRow {
  id: number;
  companyId: number;
  company: string;
  domain: string;
  channel: string;
  sentAt: number;
  templateUsed: string | null;
  contactName: string | null;
  contactEmail: string | null;
  replyAt: number | null;
  replyType: string | null;
  note: string | null;
  waitingDays: number | null;
  status: string;
  language: string | null;
  bounceType: string | null;
  subject: string | null;
  body: string | null;
  isFollowup: boolean;
}

export interface StudioCard {
  companyId: number;
  name: string;
  domain: string;
  country: string | null;
  city: string | null;
  sizeHint: string | null;
  /** The segment: studio, design, startup, smb, ecommerce... */
  kind: string;
  market: string | null;
  industry: string | null;
  phone: string | null;
  copyrightYear: number | null;
  lastPostAt: number | null;
  tags: string[];
  techHints: string[];
  /** Catalog reputation. null means the catalog did not show it. */
  rating: number | null;
  reviewsCount: number | null;
  minProject: string | null;
  hourlyRate: string | null;
  foundedYear: number | null;
  /** The "Other" block: everything the catalog showed beyond the listed fields. */
  extra: Record<string, string>;
  description: string | null;
  careersUrl: string | null;
  careersKind: string;
  sourceUrl: string | null;
  sources: string[];
  firstSeen: number;
  lastChecked: number | null;
  status: string;
  snoozedUntil: number | null;
  /** Hiring developers right now, and how many roles were seen. */
  hiring: boolean;
  hiringRoles: number | null;
  score: number;
  why: { reason: string; weight: number }[];
  contacts: CompanyContact[];
  /** The latest site audit, null when the site was never audited. */
  audit: { checkedAt: number; perfScore: number | null; issues: string[] } | null;
  lastContactedAt: number | null;
}

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

/** A filter without empty fields, the form a saved filter is stored in. */
export function cleanFilter(filter: CompanyFilter): CompanyFilter {
  return Object.fromEntries(
    Object.entries(filter).filter(
      ([, value]) => value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0),
    ),
  ) as CompanyFilter;
}

export interface CompanyPage {
  cards: StudioCard[];
  total: number;
  aboveThreshold: number;
  threshold: number | null;
}

export interface Facets {
  kind: Bucket[];
  market: Bucket[];
  country: Bucket[];
  city: Bucket[];
  industry: Bucket[];
  source: Bucket[];
  tags: Bucket[];
}

export interface SavedFilter {
  id: number;
  name: string;
  query: CompanyFilter;
  updatedAt: number;
}

export interface BulkResult {
  changed: number;
  kept: { companyId: number; reason: string }[];
  missing: number[];
}

/** Explicit demand: a tender or a funding news item. */
export interface LeadRow {
  id: number;
  companyId: number | null;
  companyName: string | null;
  companyDomain: string | null;
  source: string;
  externalId: string;
  url: string;
  title: string;
  text: string | null;
  budget: number | null;
  currency: string | null;
  deadlineAt: number | null;
  firstSeen: number;
  closedAt: number | null;
  fit: number | null;
  status: string;
}

export interface QueueCard extends StudioCard {
  /** Acted on since the slice was made. */
  done: boolean;
}

export interface DailyQueue {
  day: string;
  size: number;
  cards: QueueCard[];
  carried: number;
  eligible: number;
}

/**
 * The key a company is opened by in the address: its domain, readable in a link, or `id-42` for a
 * business without a site (a clinic from Google Places, a tender buyer).
 */
export function companyKey(card: { domain: string; companyId: number }): string {
  return card.domain || `id-${card.companyId}`;
}

/** A company contact. `id` is there so it can be edited right from the card. */
export interface CompanyContact {
  id: number;
  name: string | null;
  role: string | null;
  email: string | null;
  phone?: string | null;
  /** false means a hard bounce: the address stays in the database but must not be written to. */
  emailValid: boolean;
}

export interface SourceRow {
  id: string;
  kind: string;
  requiresSlug: boolean;
  lastRun: {
    status: string;
    startedAt: number;
    itemsFound: number;
    itemsNew: number;
    errors: string[];
  } | null;
}

export interface Bucket {
  key: string;
  count: number;
}

export interface FullStats {
  byKind: Bucket[];
  byMarket: Bucket[];
  byCountry: Bucket[];
  byIndustry: Bucket[];
  bySource: Bucket[];
  reach: { total: number; withEmail: number; withNamedContact: number; withPhone: number; hiring: number };
  perDay: { day: string; count: number }[];
  funnel: Record<string, number>;
}

export interface RulesPayload {
  rules: Rules;
  source: 'db' | 'file' | 'bundled';
}

/** Lead scoring rules. Only what the interface edits is typed, the rest goes back and forth as is. */
export interface Rules {
  companies: {
    threshold: number;
    kindWeights: Record<string, number>;
    industryWeights: Record<string, number>;
    tagWeights: Record<string, number>;
    techWeights: Record<string, number>;
    countryWeights: Record<string, number>;
    sizeWeights: Record<string, number>;
    hiring: number;
    hasCareersPage: number;
    /** Catalog reputation. May be missing from a config saved before it existed. */
    reputation?: {
      goodRating: number;
      goodRatingBonus: number;
      weakRating: number;
      weakRatingPenalty: number;
      reviewsFrom: number;
      reviewsBonus: number;
      noReviewsPenalty: number;
    };
  } & Record<string, unknown>;
  [key: string]: unknown;
}

export interface TemplateRow {
  id: number;
  slug: string;
  name: string;
  kind: string;
  /** The company kind the text is written for. Empty means universal. */
  forKind: string | null;
  subject: string | null;
  body: string;
  note: string | null;
  archived: boolean;
  /** uk | en. The language is how a template is matched to the company's country. */
  language: string;
  /** studio_named | studio_generic | followup. Empty means manual copying. */
  targetType: string | null;
  /** How many letters were sent under this key. Shown before deletion. */
  usageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface Stats {
  funnel: Record<string, number>;
  llmBudgetLeft: number;
  /** anthropic or workers-ai. Shows what exactly model calls are billed to. */
  llmProvider: string;
  llmModel: string;
}

/**
 * A token is needed when the radar is deployed. It is taken from `?token=...` on the first
 * visit and lives in localStorage after that. Locally there is none and the server does not ask.
 */
const TOKEN_KEY = 'radar-token';

function token(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get('token');
  if (fromUrl) {
    localStorage.setItem(TOKEN_KEY, fromUrl);
    window.history.replaceState({}, '', window.location.pathname);
    return fromUrl;
  }
  return localStorage.getItem(TOKEN_KEY);
}

/** Gmail connection status. An empty screen instead of an explanation will not do here. */
export interface GmailStatus {
  configured: boolean;
  connected: boolean;
  email: string | null;
  fromEmail: string | null;
  emailValid: boolean;
  scopes: string[];
  connectedAt: number | null;
  expiresAt: number | null;
  hint: string | null;
  /** Who sends: gmail or resend. */
  provider: 'gmail' | 'resend';
  /** Whether this provider can read the mailbox. false means replies go unnoticed. */
  readsReplies: boolean;
  providers: {
    id: 'gmail' | 'resend';
    connected: boolean;
    fromEmail: string | null;
    readsReplies: boolean;
    hint: string | null;
  }[];
}

/** Report of a full company review. Shown as is: the button is there to check the search. */
export interface RefreshReport {
  companyId: number;
  domain: string;
  reachable: boolean;
  clientRendered: boolean;
  needsBrowser: boolean;
  pagesFetched: number;
  careersUrl: string | null;
  careersKind: string;
  careersSlug: string | null;
  techHints: string[];
  techAdded: string[];
  contactsAdded: number;
  emails: string[];
  people: number;
}

/**
 * The model's verdict on a company. Advice, not a decision: next to it there is always
 * `fallbackSlug`, the same deterministic choice the sender would make.
 */
export interface Verdict {
  template_slug: string | null;
  alternative_slug: string | null;
  language: 'uk' | 'en';
  confidence: number;
  angle: string;
  why: string;
  risks: string[];
  contact: string | null;
  skip: boolean;
  skip_reason: string | null;
}

export interface VerdictReport {
  companyId: number;
  domain: string;
  source: 'cache' | 'llm' | 'budget' | 'invalid';
  verdict: Verdict | null;
  fallbackSlug: string | null;
  fallbackTarget: string;
  language: 'uk' | 'en';
  error: string | null;
}

/** A letter draft on the Outbox page. */
export interface DraftRow {
  id: number;
  companyId: number;
  company: string;
  domain: string;
  /** The lead the letter answers: a tender, a request. */
  leadTitle: string | null;
  contactName: string | null;
  contactEmail: string | null;
  templateUsed: string | null;
  language: string | null;
  subject: string | null;
  body: string | null;
  error: string | null;
  queuedAt: number | null;
  /** Every address of this company. Dead ones too, but marked. */
  companyContacts: { name: string | null; role: string | null; email: string; emailValid: boolean }[];
}

export interface Conversion {
  key: string;
  sent: number;
  replied: number;
  positive: number;
}

export interface OutreachStats {
  byTemplate: Conversion[];
  byKind: Conversion[];
  bounceRate: number;
  medianReplyHours: number | null;
  drafts: number;
  needsAttention: number;
}

export interface Blocker {
  code: string;
  message: string;
  retryAt?: number;
}

export interface SendCounters {
  day: string;
  sentToday: number;
  limit: number;
  nextAllowedAt: number | null;
  bounceRate: number;
  windowOpen: boolean;
}

/**
 * The link that connects mail. The radar token has to go in the query: OAuth comes back
 * as a browser redirect, and a header cannot be attached to that.
 */
export function gmailConnectUrl(): string {
  const value = token();
  return `/api/gmail/connect${value ? `?token=${encodeURIComponent(value)}` : ''}`;
}

export function setToken(value: string): void {
  localStorage.setItem(TOKEN_KEY, value);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const value = token();
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(value ? { 'x-radar-token': value } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (body.error) throw Object.assign(new Error(body.error), { status: response.status });

    /*
     * A response without a body is not our error but the platform's: the worker did not
     * finish the request in time and was stopped. A bare "503 on /enrich" explains
     * nothing, so the reason is named outright, otherwise it has to be recalled every time.
     */
    if (response.status === 503 || response.status === 524) {
      throw new Error(
        `${response.status} on ${path}: the worker ran out of time. Run long operations in smaller batches`,
      );
    }
    throw Object.assign(new Error(`${response.status} on ${path}`), { status: response.status });
  }
  return (await response.json()) as T;
}

export const api = {
  companies: (filter: CompanyFilter, sort: 'score' | 'name' = 'score') => {
    const query = new URLSearchParams({ ...filterParams(filter), sort }).toString();
    return request<CompanyPage>(`/companies?${query}`);
  },
  facets: () => request<Facets>('/companies/facets'),
  bulk: (body: { ids: number[]; status?: string; addTags?: string[]; removeTags?: string[] }) =>
    request<BulkResult>('/companies/bulk', { method: 'POST', body: JSON.stringify(body) }),
  savedFilters: () => request<SavedFilter[]>('/filters'),
  saveFilter: (name: string, query: CompanyFilter) =>
    request<{ before: SavedFilter | null; after: SavedFilter }>('/filters', {
      method: 'PUT',
      body: JSON.stringify({ name, query: cleanFilter(query) }),
    }),
  deleteFilter: (id: number) => request<{ deleted: SavedFilter | null }>(`/filters/${id}`, { method: 'DELETE' }),
  queue: () => request<DailyQueue>('/queue'),
  leads: (params: { source?: string; status?: string; all?: boolean }) => {
    const query = new URLSearchParams(
      Object.entries({ source: params.source ?? '', status: params.status ?? '', all: params.all ? '1' : '' }).filter(
        ([, value]) => value,
      ),
    ).toString();
    return request<LeadRow[]>(`/leads${query ? `?${query}` : ''}`);
  },
  setLeadStatus: (id: number, status: string) =>
    request<{ id: number; before: string; after: string }>(`/leads/${id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    }),
  company: (id: number) => request<CompanyDetail>(`/companies/${id}`),
  setCompanyState: (id: number, body: Record<string, unknown>) =>
    request<{ ok: true }>(`/companies/${id}/state`, { method: 'POST', body: JSON.stringify(body) }),
  outreach: (waiting?: number) => request<OutreachRow[]>(`/outreach${waiting ? `?waiting=${waiting}` : ''}`),
  reply: (id: number, replyType: string, note?: string) =>
    request<{ ok: true }>(`/outreach/${id}/reply`, {
      method: 'POST',
      body: JSON.stringify({ replyType, note }),
    }),
  studios: (filter: CompanyFilter) => {
    const query = new URLSearchParams(filterParams(filter)).toString();
    return request<CompanyPage>(`/studios${query ? `?${query}` : ''}`);
  },
  companyAction: (id: number, body: Record<string, unknown>) =>
    request<{ status: string }>(`/companies/${id}/action`, { method: 'POST', body: JSON.stringify(body) }),

  rules: () => request<RulesPayload>('/rules'),
  saveRules: (next: Rules) => request<RulesPayload>('/rules', { method: 'PUT', body: JSON.stringify(next) }),
  resetRules: () => request<RulesPayload>('/rules/reset', { method: 'POST', body: '{}' }),

  templates: (kind?: string) =>
    request<{ kinds: string[]; templates: TemplateRow[] }>(`/templates${kind ? `?kind=${kind}` : ''}`),
  createTemplate: (body: Record<string, unknown>) =>
    request<TemplateRow>('/templates', { method: 'POST', body: JSON.stringify(body) }),
  updateTemplate: (id: number, body: Record<string, unknown>) =>
    request<TemplateRow>(`/templates/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  archiveTemplate: (id: number) =>
    request<TemplateRow>(`/templates/${id}/archive`, { method: 'POST', body: '{}' }),
  restoreTemplate: (id: number) =>
    request<TemplateRow>(`/templates/${id}/restore`, { method: 'POST', body: '{}' }),
  duplicateTemplate: (id: number) =>
    request<TemplateRow>(`/templates/${id}/duplicate`, { method: 'POST', body: '{}' }),
  deleteTemplate: (id: number) =>
    request<{ deleted: true; slug: string; keptInHistory: number }>(`/templates/${id}`, {
      method: 'DELETE',
    }),
  sources: () => request<SourceRow[]>('/sources'),
  runSource: (id: string) => request<{ itemsFound: number }>(`/sources/${id}/run`, { method: 'POST', body: '{}' }),
  stats: () => request<Stats>('/stats'),
  gmailStatus: () => request<GmailStatus>('/gmail/status'),
  gmailConnectUrl,
  drafts: () => request<{ drafts: DraftRow[]; counters: SendCounters }>('/outreach/drafts'),
  /** `templateSlug` is the template picked by hand on the card. Empty means automatic choice. */
  draftForCompany: (companyId: number, templateSlug?: string | null) =>
    request<{ id: number | null; reason: string | null }>('/outreach/drafts', {
      method: 'POST',
      body: JSON.stringify({ companyId, templateSlug }),
    }),
  /** A different template for a draft: the text is rebuilt from the company data. */
  retemplateDraft: (id: number, slug: string) =>
    request<DraftRow>(`/outreach/drafts/${id}/template`, {
      method: 'POST',
      body: JSON.stringify({ slug }),
    }),
  /** Crawl one company site right now: contacts, email, signs of life. */
  enrichCompany: (domain: string) =>
    request<{
      checked: number;
      contactsAdded: number;
      withEmail: number;
      /** The site renders its content with script. Explains why the markup had nothing. */
      clientRendered: number;
      /** The site did not open for the server at all: protection, timeout or a dead domain. */
      unreachable: number;
      errors: string[];
    }>('/enrich', {
      method: 'POST',
      body: JSON.stringify({ domain, limit: 1 }),
    }),
  /** The signature shared by all letters. */
  signature: () => request<{ signature: string }>('/outreach/signature'),
  saveSignature: (signature: string) =>
    request<{ signature: string }>('/outreach/signature', {
      method: 'PUT',
      body: JSON.stringify({ signature }),
    }),
  /** Full review of one company: site, stack, contacts, careers page. */
  refreshCompany: (companyId: number) =>
    request<RefreshReport>(`/companies/${companyId}/refresh`, { method: 'POST', body: '{}' }),
  companyVerdict: (companyId: number) =>
    request<VerdictReport>(`/companies/${companyId}/verdict`, { method: 'POST', body: '{}' }),
  updateContact: (
    companyId: number,
    contactId: number,
    patch: { name?: string | null; role?: string | null; email?: string | null },
  ) =>
    request<{ contact: CompanyContact; merged: number }>(
      `/companies/${companyId}/contacts/${contactId}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    ),
  deleteContact: (companyId: number, contactId: number) =>
    request<{ deleted: boolean }>(`/companies/${companyId}/contacts/${contactId}`, { method: 'DELETE' }),
  /** A contact added by hand from the studio page. */
  addContact: (companyId: number, body: { email: string; name?: string; role?: string }) =>
    request<{ email: string; created: boolean }>(`/companies/${companyId}/contacts`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  outreachStats: () => request<OutreachStats>('/stats/outreach'),
  prepareFollowups: () =>
    request<{ due: number; created: number }>('/outreach/followups', { method: 'POST', body: '{}' }),
  /**
   * Generic operation call. All operation routes share one shape, so the interface does
   * not need to know each one: it draws them as a list from their description.
   */
  /** Getro networks in order: the Operations page goes through them one at a time. */
  getroNetworks: () => request<{ networks: string[] }>('/sources/getro/networks'),
  run: (path: string, body: Record<string, unknown> = {}) =>
    request<Record<string, unknown>>(path, { method: 'POST', body: JSON.stringify(body) }),
  prepareDrafts: (limit?: number) =>
    request<{ candidates: number; created: number; needsAttention: number }>('/outreach/prepare', {
      method: 'POST',
      body: JSON.stringify({ limit }),
    }),
  updateDraft: (id: number, body: { subject?: string; body?: string; contactEmail?: string | null; contactName?: string | null }) =>
    request<DraftRow>(`/outreach/drafts/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  discardDraft: (id: number) =>
    request<{ deleted: boolean }>(`/outreach/drafts/${id}`, { method: 'DELETE' }),
  sendDraft: (id: number) =>
    request<{ sent: boolean; blockers: Blocker[] }>(`/outreach/drafts/${id}/send`, {
      method: 'POST',
      body: '{}',
    }),
  fullStats: () => request<FullStats>('/stats/full'),
  similar: (companyId: number) =>
    request<{ companyId: number; name: string; domain: string; kind: string; similarity: number }[]>(
      `/companies/${companyId}/similar`,
    ),
  embed: (limit = 200) =>
    request<{ itemsFound: number; itemsNew: number; errors: string[] }>('/embed', {
      method: 'POST',
      body: JSON.stringify({ limit }),
    }),
  enrich: (limit = 25) =>
    request<{ checked: number; withPeople: number; withEmail: number; contactsAdded: number }>(
      '/enrich',
      { method: 'POST', body: JSON.stringify({ limit }) },
    ),
  discover: (limit = 25) =>
    request<{ checked: number; withAts: number; withHtml: number; itemsNew: number }>('/discover', {
      method: 'POST',
      body: JSON.stringify({ limit }),
    }),
  runDou: (limit = 40) =>
    request<{ itemsFound: number; itemsNew: number }>('/catalogs/dou/run', {
      method: 'POST',
      body: JSON.stringify({ limit }),
    }),
};

export function formatDate(ms: number | null): string {
  return ms ? new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' }) : '';
}
