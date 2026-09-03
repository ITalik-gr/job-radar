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
  careersKind: string;
  careersUrl: string | null;
  techHints: string[];
  sources: string[];
  lastChecked: number | null;
  status: string | null;
  snoozedUntil: number | null;
  openVacancies: number;
}

export interface CompanyDetail {
  company: CompanyRow & { careersSlug: string | null; sizeHint: string | null };
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
  replyAt: number | null;
  replyType: string | null;
  note: string | null;
  waitingDays: number | null;
}

export interface StudioCard {
  companyId: number;
  name: string;
  domain: string;
  country: string | null;
  city: string | null;
  sizeHint: string | null;
  tags: string[];
  techHints: string[];
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

export interface Stats {
  vacancies: { total: number; open: number; aboveThreshold: number; stopped: number; needsReview: number };
  funnel: Record<string, number>;
  llmBudgetLeft: number;
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
    return request<{ threshold: number; cards: StudioCard[] }>(`/studios${query ? `?${query}` : ''}`);
  },
  companyAction: (id: number, body: Record<string, unknown>) =>
    request<{ status: string }>(`/companies/${id}/action`, { method: 'POST', body: JSON.stringify(body) }),
  recalc: () => request<Record<string, number>>('/score/recalc', { method: 'POST', body: '{}' }),
  sources: () => request<SourceRow[]>('/sources'),
  runSource: (id: string) => request<{ itemsFound: number }>(`/sources/${id}/run`, { method: 'POST', body: '{}' }),
  stats: () => request<Stats>('/stats'),
  fullStats: () => request<FullStats>('/stats/full'),
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
