import { describe, expect, it } from 'vitest';
import { scoreCompany, type AuditSignal } from '../src/pipeline/company-score.js';
import type { Company } from '../src/db/schema.js';

const NOW = Date.parse('2026-10-23T00:00:00Z');

const clinic = {
  id: 1,
  name: 'Clinic',
  domain: 'clinic.ua',
  country: 'UA',
  city: 'Львів',
  sizeHint: null,
  kind: 'smb',
  industry: 'dental',
  phone: '+380320000001',
  sources: ['places'],
  careersUrl: null,
  careersKind: 'unknown',
  careersSlug: null,
  techHints: [],
  tags: [],
  description: null,
  sourceUrl: null,
  copyrightYear: null,
  lastPostAt: null,
  rating: null,
  reviewsCount: null,
  minProject: null,
  hourlyRate: null,
  foundedYear: null,
  hiringDevs: false,
  hiringRoles: null,
  hiringSeenAt: null,
  extra: {},
  firstSeen: 0,
  lastChecked: null,
} as unknown as Company;

const studio = { ...clinic, name: 'Studio', domain: 'studio.com', kind: 'studio', country: 'PL', phone: null } as Company;

const audit = (patch: Partial<AuditSignal> = {}): AuditSignal => ({
  issues: [],
  perfScore: 60,
  mobileOk: true,
  cms: null,
  ...patch,
});

const score = (company: Company, extra: Omit<Parameters<typeof scoreCompany>[0], 'company'> = {}) =>
  scoreCompany({ company, now: NOW, ...extra });

const reasons = (company: Company, extra: Omit<Parameters<typeof scoreCompany>[0], 'company'> = {}) =>
  [...score(company, extra).positives, ...score(company, extra).negatives].map((item) => item.reason);

describe('site buyers: the audit speaks', () => {
  it('each issue adds, capped at three', () => {
    const none = score(clinic, { audit: audit() }).score;
    const two = score(clinic, { audit: audit({ issues: ['a', 'b'] }) }).score;
    const five = score(clinic, { audit: audit({ issues: ['a', 'b', 'c', 'd', 'e'] }) }).score;
    expect(two - none).toBe(4);
    expect(five - none).toBe(6);
  });

  it('a fresh fast site on a modern platform is a minus, a slow one is not', () => {
    const fresh = score(clinic, { audit: audit({ cms: 'next.js', perfScore: 92 }) }).score;
    const plain = score(clinic, { audit: audit() }).score;
    expect(fresh - plain).toBe(-4);
    const slowNext = reasons(clinic, { audit: audit({ cms: 'next.js', perfScore: 92, issues: ['x'] }) });
    expect(slowNext.some((reason) => reason.startsWith('fresh fast'))).toBe(false);
  });

  it('no site is a reason to write, if they can be reached', () => {
    const noSite = { ...clinic, domain: '' } as Company;
    expect(reasons(noSite)).toContain('no site');
    const unreachable = { ...noSite, phone: null } as Company;
    expect(reasons(unreachable)).not.toContain('no site');
    expect(reasons(unreachable, { contacts: [{ name: null, email: 'info@clinic.ua' }] })).toContain('no site');
  });

  it('stack weights and the stale penalty do not apply: a Tilda clinic with a 2019 footer is a lead', () => {
    const old = { ...clinic, techHints: ['tilda'], copyrightYear: 2019 } as Company;
    expect(score(old).score).toBe(score(clinic).score);
  });

  it('a studio keeps the old rules: stack counts, an old footer is a dead company, audit ignored', () => {
    expect(score({ ...studio, techHints: ['next.js'] } as Company).score).toBeGreaterThan(score(studio).score);
    expect(score({ ...studio, copyrightYear: 2019 } as Company).score).toBeLessThan(score(studio).score);
    expect(score(studio, { audit: audit({ issues: ['a', 'b'] }) }).score).toBe(score(studio).score);
  });
});

describe('demand and contacts', () => {
  it('an open tender is the biggest plus', () => {
    const base = score(clinic).score;
    expect(score(clinic, { openLead: { title: 'Розробка веб-сайту' } }).score - base).toBe(6);
    expect(reasons(clinic, { openLead: { title: 'Розробка веб-сайту' } })).toContain('open tender: Розробка веб-сайту');
  });

  it('a named contact with an email adds, a generic mailbox does not', () => {
    const base = score(studio).score;
    expect(score(studio, { contacts: [{ name: null, email: 'hello@studio.com' }] }).score).toBe(base);
    expect(score(studio, { contacts: [{ name: 'Olena K', email: 'olena@studio.com' }] }).score - base).toBe(2);
    expect(score(studio, { contacts: [{ name: 'Olena K', email: null }] }).score).toBe(base);
  });
});
