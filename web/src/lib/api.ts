export interface QueueCard {
  queueItemId: number;
  position: number;
  decision: string | null;
  vacancyId: number;
  title: string | null;
  url: string;
  score: number | null;
  stack: string[];
  seniority: string | null;
  remote: boolean | null;
  location: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  currency: string | null;
  why: string | null;
  rawText: string | null;
  needsReview: boolean;
  companyId: number;
  company: string;
  domain: string;
  careersUrl: string | null;
  companyStatus: string;
  contactedNote: string | null;
  /** When the card was first shown. Earlier than today means it was carried over. */
  firstShownAt: number;
}

export interface QueueResponse {
  day: string;
  pending: number;
  total: number;
  cards: QueueCard[];
}

export interface CompanyRow {
  id: number;
  name: string;
  domain: string;
  country: string | null;
  city: string | null;
  sizeHint: string | null;
  tags: string[];
  sourceUrl: string | null;
  score: number;
  /** Catalog reputation. null means the catalog did not show it. */
  rating: number | null;
  reviewsCount: number | null;
  careersKind: string;
  careersUrl: string | null;
  techHints: string[];
  sources: string[];
  lastChecked: number | null;
  status: string | null;
  snoozedUntil: number | null;
  openVacancies: number;
}

/**
 * Company details. The type describes exactly what GET /companies/:id returns and
 * deliberately does not extend CompanyRow: this response has no score, it is computed
 * on the fly only for the list. The type used to promise a score field, and the
 * interface showed a zero.
 */
export interface CompanyDetail {
  company: {
    id: number;
    name: string;
    domain: string;
    country: string | null;
    city: string | null;
    sizeHint: string | null;
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
  vacancies: {
    id: number;
    title: string | null;
    url: string;
    score: number | null;
    stack: string[];
    firstSeen: number;
    lastSeen: number;
    closedAt: number | null;
    llmWhy: string | null;
  }[];
  contacts: CompanyContact[];
  outreach: OutreachRow[];
  snapshots: { id: number; url: string; fetchedAt: number; contentHash: string; blocks: number }[];
}

export interface OutreachRow {
  id: number;
  companyId: number;
  company: string;
  domain: string;
  vacancyId: number | null;
  vacancyTitle: string | null;
  vacancyUrl: string | null;
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
  aiUsed: boolean;
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
  kind: string;
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
  sourceUrl: string | null;
  sources: string[];
  status: string;
  openVacancies: number;
  score: number;
  why: { reason: string; weight: number }[];
  contacts: CompanyContact[];
  lastContactedAt: number | null;
}

/** A company contact. `id` is there so it can be edited right from the card. */
export interface CompanyContact {
  id: number;
  name: string | null;
  role: string | null;
  email: string | null;
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

export interface FullStats {
  topTech: { tech: string; count: number }[];
  salariesBySeniority: { group: string; median: number | null; count: number }[];
  salariesByCountry: { group: string; median: number | null; count: number }[];
  lifetimes: {
    medianDays: number | null;
    closedCount: number;
    ghosts: { id: number; title: string | null; company: string; url: string; days: number }[];
  };
  perDay: { day: string; count: number }[];
  funnel: Record<string, number>;
}

export interface RulesPayload {
  rules: Rules;
  source: 'db' | 'file' | 'bundled';
}

/** Only what the interface edits. The rest of the config goes back and forth as is. */
export interface Rules {
  threshold: number;
  stopWords: string[];
  weights: { titleMultiplier: number; bodyCap: number; terms: Record<string, number> };
  roleGate: { enabled: boolean; mustMatch: string[]; neverMatch: string[] };
  geo: { enabled: boolean; homeCity: string[]; blockedRegions: string[] } & Record<string, unknown>;
  companies: {
    threshold: number;
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
  /** Static first paragraph. The body inserts it through {{intro}}. */
  intro: string | null;
  body: string;
  note: string | null;
  archived: boolean;
  /** uk | en. The language is how a template is matched to the company's country. */
  language: string;
  /** vacancy | studio_named | studio_generic | followup. Empty means manual copying. */
  targetType: string | null;
  /** How many letters were sent under this key. Shown before deletion. */
  usageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface Stats {
  vacancies: { total: number; open: number; aboveThreshold: number; stopped: number; needsReview: number };
  funnel: Record<string, number>;
  llmBudgetLeft: number;
  /** anthropic or workers-ai. Shows what exactly classification is billed to. */
  llmProvider: string;
  llmModel: string;
  threshold: number;
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
  vacancyTitle: string | null;
  contactName: string | null;
  contactEmail: string | null;
  templateUsed: string | null;
  language: string | null;
  subject: string | null;
  body: string | null;
  aiUsed: boolean;
  aiFallbackReason: string | null;
  error: string | null;
  queuedAt: number | null;
  /** Every address of this company. Dead ones too, but marked. */
  companyContacts: { name: string | null; role: string | null; email: string; emailValid: boolean }[];
}

export interface OutreachStats {
  byTemplate: { template: string; sent: number; replied: number; positive: number }[];
  ai: { sent: number; replied: number; positive: number };
  static: { sent: number; replied: number; positive: number };
  fallbacks: { reason: string; count: number }[];
  fallbackShare: number;
  bounceRate: number;
  medianReplyHours: number | null;
  drafts: number;
  needsAttention: number;
}

export interface FactRow {
  id: number;
  key: string;
  textUk: string;
  textEn: string;
  isActive: boolean;
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
  queue: (day?: string) => request<QueueResponse>(`/queue${day ? `?day=${day}` : ''}`),
  act: (vacancyId: number, body: Record<string, unknown>) =>
    request<{ companyId: number; status: string }>(`/vacancies/${vacancyId}/action`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  companies: (params: Record<string, string>) => {
    const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
    return request<CompanyRow[]>(`/companies${query ? `?${query}` : ''}`);
  },
  company: (id: number) => request<CompanyDetail>(`/companies/${id}`),
  setCompanyState: (id: number, body: Record<string, unknown>) =>
    request<{ ok: true }>(`/companies/${id}/state`, { method: 'POST', body: JSON.stringify(body) }),
  outreach: (waiting?: number) => request<OutreachRow[]>(`/outreach${waiting ? `?waiting=${waiting}` : ''}`),
  reply: (id: number, replyType: string, note?: string) =>
    request<{ ok: true }>(`/outreach/${id}/reply`, {
      method: 'POST',
      body: JSON.stringify({ replyType, note }),
    }),
  studios: (params: Record<string, string>) => {
    const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value)).toString();
    return request<{
      cards: StudioCard[];
      total: number;
      aboveThreshold: number;
      threshold: number;
    }>(`/studios${query ? `?${query}` : ''}`);
  },
  companyAction: (id: number, body: Record<string, unknown>) =>
    request<{ status: string }>(`/companies/${id}/action`, { method: 'POST', body: JSON.stringify(body) }),
  recalc: () => request<Record<string, number>>('/score/recalc', { method: 'POST', body: '{}' }),

  rules: () => request<RulesPayload>('/rules'),
  saveRules: (next: Rules) => request<RulesPayload>('/rules', { method: 'PUT', body: JSON.stringify(next) }),
  resetRules: () => request<RulesPayload>('/rules/reset', { method: 'POST', body: '{}' }),
  stopWord: (word: string, remove = false) =>
    request<RulesPayload>('/rules/stop-words', { method: 'POST', body: JSON.stringify({ word, remove }) }),
  termWeight: (term: string, weight: number | null) =>
    request<RulesPayload>('/rules/weights', { method: 'POST', body: JSON.stringify({ term, weight }) }),

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
  draftForCompany: (companyId: number, vacancyId?: number | null, templateSlug?: string | null) =>
    request<{ id: number | null; reason: string | null }>('/outreach/drafts', {
      method: 'POST',
      body: JSON.stringify({ companyId, vacancyId, templateSlug }),
    }),
  /** A different template for a draft: the text is rebuilt, the intro carries over. */
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
  regenerateIntro: (id: number) =>
    request<DraftRow>(`/outreach/drafts/${id}/regenerate`, { method: 'POST', body: '{}' }),
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
  facts: () => request<FactRow[]>('/facts'),
  createFact: (body: Record<string, unknown>) =>
    request<FactRow>('/facts', { method: 'POST', body: JSON.stringify(body) }),
  updateFact: (id: number, body: Record<string, unknown>) =>
    request<FactRow>(`/facts/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteFact: (id: number) => request<{ deleted: boolean }>(`/facts/${id}`, { method: 'DELETE' }),
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
  topUpQueue: () =>
    request<{ added: number; total: number }>('/queue/top-up', { method: 'POST', body: '{}' }),
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

/** How many full days a card has waited for a decision. Zero means it was shown today. */
export function waitingDays(firstShownAt: number): number {
  return Math.floor((Date.now() - firstShownAt) / 86_400_000);
}

export function formatDate(ms: number | null): string {
  return ms ? new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' }) : '';
}

export function formatSalary(card: {
  salaryMin: number | null;
  salaryMax: number | null;
  currency: string | null;
}): string {
  if (!card.salaryMin && !card.salaryMax) return '';
  const range = [card.salaryMin, card.salaryMax].filter(Boolean).join(' - ');
  return `${range} ${card.currency ?? ''}`.trim();
}
