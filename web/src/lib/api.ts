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
  /** Коли картку показали вперше. Раніше за сьогодні означає, що її перенесли. */
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
  /** Репутація в каталозі. null означає, що каталог її не показував. */
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
 * Деталі компанії. Тип описує саме те, що повертає GET /companies/:id, і навмисно
 * не успадковує CompanyRow: рахунку в цій відповіді немає, він рахується на льоту
 * лише для списку. Раніше тип обіцяв поле score, і в інтерфейсі показувався нуль.
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
  contacts: { id: number; name: string | null; role: string | null; email: string | null }[];
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
  /** Репутація в каталозі. null означає, що каталог її не показував. */
  rating: number | null;
  reviewsCount: number | null;
  minProject: string | null;
  hourlyRate: string | null;
  foundedYear: number | null;
  /** Блок "Інше": усе, що каталог показав понад перелічені поля. */
  extra: Record<string, string>;
  description: string | null;
  careersUrl: string | null;
  sourceUrl: string | null;
  sources: string[];
  status: string;
  openVacancies: number;
  score: number;
  why: { reason: string; weight: number }[];
  contacts: { name: string | null; role: string | null; email: string | null }[];
  lastContactedAt: number | null;
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

/** Тільки те, що править інтерфейс. Решта конфіга ходить туди-назад як є. */
export interface Rules {
  threshold: number;
  stopWords: string[];
  weights: { titleMultiplier: number; bodyCap: number; terms: Record<string, number> };
  roleGate: { enabled: boolean; mustMatch: string[]; neverMatch: string[] };
  geo: { enabled: boolean; homeCity: string[]; blockedRegions: string[] } & Record<string, unknown>;
  companies: {
    threshold: number;
    /** Репутація з каталогу. Може бути відсутня в конфізі, збереженому до її появи. */
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
  /** Тип компанії, під який заточений текст. Порожнє означає універсальний. */
  forKind: string | null;
  subject: string | null;
  /** Статичний перший абзац. Тіло підставляє його через {{intro}}. */
  intro: string | null;
  body: string;
  note: string | null;
  archived: boolean;
  /** uk | en. За мовою шаблон підбирається під країну компанії. */
  language: string;
  /** vacancy | studio_named | studio_generic | followup. Порожнє означає ручне копіювання. */
  targetType: string | null;
  /** Скільки листів написано цим ключем. Показується перед видаленням. */
  usageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface Stats {
  vacancies: { total: number; open: number; aboveThreshold: number; stopped: number; needsReview: number };
  funnel: Record<string, number>;
  llmBudgetLeft: number;
  /** anthropic або workers-ai. Видно, за що саме платиться класифікація. */
  llmProvider: string;
  llmModel: string;
  threshold: number;
}

/**
 * Токен потрібен, коли радар задеплоєний. Береться з `?token=...` при першому заході
 * і далі живе в localStorage. Локально його просто немає, і сервер не питає.
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

/** Стан підключення Gmail. Порожній екран замість пояснення тут не годиться. */
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
}

/** Чернетка листа на сторінці "До відправки". */
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
 * Посилання на підключення пошти. Токен радара мусить іти в query: OAuth
 * повертається редіректом браузера, і заголовок туди не покласти.
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
    throw new Error(body.error ?? `${response.status} на ${path}`);
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
  draftForCompany: (companyId: number, vacancyId?: number | null) =>
    request<{ id: number | null; reason: string | null }>('/outreach/drafts', {
      method: 'POST',
      body: JSON.stringify({ companyId, vacancyId }),
    }),
  regenerateIntro: (id: number) =>
    request<DraftRow>(`/outreach/drafts/${id}/regenerate`, { method: 'POST', body: '{}' }),
  outreachStats: () => request<OutreachStats>('/stats/outreach'),
  prepareFollowups: () =>
    request<{ due: number; created: number }>('/outreach/followups', { method: 'POST', body: '{}' }),
  /**
   * Універсальний виклик операції. Усі роути операцій однакової форми, тому
   * інтерфейсу не треба знати про кожну окремо: він малює їх списком з опису.
   */
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
  updateDraft: (id: number, body: { subject?: string; body?: string }) =>
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

/** Скільки повних доби картка чекає рішення. Нуль означає, що її показали сьогодні. */
export function waitingDays(firstShownAt: number): number {
  return Math.floor((Date.now() - firstShownAt) / 86_400_000);
}

export function formatDate(ms: number | null): string {
  return ms ? new Date(ms).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' }) : '';
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
