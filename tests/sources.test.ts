import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse as parseGreenhouse } from '../src/sources/boards/greenhouse.js';
import { parse as parseLever } from '../src/sources/boards/lever.js';
import { parse as parseAshby } from '../src/sources/boards/ashby.js';
import { parse as parseRemoteOk } from '../src/sources/boards/remoteok.js';
import { feedConfigs } from '../src/sources/boards/feeds.js';
import { createRssSource } from '../src/sources/boards/rss.js';
import type { RawVacancy } from '../src/sources/registry.js';

const fixture = (path: string) => readFileSync(`fixtures/${path}`, 'utf8');

/** Спільні інваріанти: якщо їх немає, адаптер вважається зламаним. */
function expectSane(items: RawVacancy[], source: string, min = 3) {
  expect(items.length).toBeGreaterThanOrEqual(min);
  for (const item of items) {
    expect(item.source).toBe(source);
    expect(item.title, `порожній title у ${source}`).toBeTruthy();
    expect(item.url).toMatch(/^https?:\/\//);
    expect(item.rawText.length, `порожній rawText у ${source}: ${item.title}`).toBeGreaterThan(50);
    expect(item.rawText).not.toMatch(/<(div|p|script|span)\b/i);
    expect(item.rawText).not.toMatch(/&lt;|&nbsp;/);
  }
}

describe('greenhouse', () => {
  const items = parseGreenhouse(fixture('greenhouse/vercel-jobs.json'));

  it('парсить фікстуру', () => expectSane(items, 'greenhouse'));

  it('витягує назву, id, локацію і компанію', () => {
    const job = items[0]!;
    expect(job.externalId).toMatch(/^\d+$/);
    expect(job.companyName).toBe('Vercel');
    expect(job.location).toBeTruthy();
    expect(job.postedAt).toBeGreaterThan(Date.parse('2020-01-01'));
  });

  it('розгортає подвійно екранований HTML опису', () => {
    expect(items[0]!.rawText).toContain('Vercel');
  });

  it('порожня дошка це порожній масив, не виняток', () => {
    expect(parseGreenhouse('{"jobs":[],"meta":{"total":0}}')).toEqual([]);
  });
});

describe('lever', () => {
  const items = parseLever(fixture('lever/spotify-postings.json'));

  it('парсить фікстуру', () => expectSane(items, 'lever'));

  it('склеює кілька локацій і читає workplaceType', () => {
    const job = items[0]!;
    expect(job.url).toContain('jobs.lever.co');
    expect(job.location).toBeTruthy();
    expect([true, false, null]).toContain(job.remote);
  });

  it('кидає помилку на несподіваній формі відповіді', () => {
    expect(() => parseLever('{"postings":[]}')).toThrow();
  });
});

describe('ashby', () => {
  const items = parseAshby(fixture('ashby/ramp-board.json'));

  it('парсить фікстуру', () => expectSane(items, 'ashby'));

  it('бере вилку з compensation і прапорець isRemote', () => {
    const withSalary = items.find((i) => i.rawText.includes('Compensation:'));
    expect(withSalary).toBeDefined();
    expect(items.some((i) => i.remote === true)).toBe(true);
  });

  it('відкидає неопубліковані вакансії', () => {
    const payload = JSON.stringify({
      jobs: [{ id: 'x', title: 'Hidden', jobUrl: 'https://jobs.ashbyhq.com/x/1', isListed: false }],
    });
    expect(parseAshby(payload)).toEqual([]);
  });
});

describe('remoteok', () => {
  const items = parseRemoteOk(fixture('remoteok/api.json'));

  it('парсить фікстуру', () => expectSane(items, 'remoteok'));

  it('викидає юридичну примітку з першого елемента', () => {
    expect(items.every((i) => i.title !== null)).toBe(true);
    expect(items.some((i) => i.rawText.includes('API Terms of Service'))).toBe(false);
  });

  it('додає теги і вилку в текст', () => {
    expect(items.some((i) => i.rawText.includes('Tags:'))).toBe(true);
  });
});

describe('rss', () => {
  const byId = Object.fromEntries(feedConfigs.map((f) => [f.id, f]));
  const files: Record<string, string> = {
    'rss:weworkremotely': 'rss/weworkremotely.xml',
    'rss:himalayas': 'rss/himalayas.xml',
    'rss:remotive': 'rss/remotive.xml',
  };

  for (const [id, file] of Object.entries(files)) {
    describe(id, () => {
      const source = createRssSource(byId[id]!);
      const items = source.parse(fixture(file));

      it('парсить фікстуру', () => expectSane(items, id, 3));

      it('визначає компанію', () => {
        expect(items.every((i) => Boolean(i.companyName))).toBe(true);
      });

      it('має дату публікації', () => {
        expect(items.every((i) => typeof i.postedAt === 'number')).toBe(true);
      });
    });
  }

  it('weworkremotely відрізає компанію від назви', () => {
    const source = createRssSource(byId['rss:weworkremotely']!);
    const items = source.parse(fixture('rss/weworkremotely.xml'));
    expect(items[0]!.companyName).toBe('Vercel');
    expect(items[0]!.title).not.toContain(':');
  });

  it('порожній фід дає порожній масив', () => {
    const source = createRssSource(byId['rss:remotive']!);
    expect(source.parse('<rss><channel><title>x</title></channel></rss>')).toEqual([]);
  });
});
