/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://clutch.co/web-developers" }
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Smoke-тест збирача каталогів. Правило 2 в CLAUDE.md вимагає тест на фікстурі
 * для кожного адаптера джерела, а розширення це такий самий адаптер, просто
 * виконується в браузері власника. Без цього тесту зміна верстки Clutch ламала б
 * збір тихо: сторінка відкрилась, карток нуль, і це виглядає як порожній каталог.
 *
 * Парсер написаний як звичайний скрипт для сторінки, тому виконується як є,
 * у jsdom, і читає той самий `document`, що й у справжній вкладці.
 */

/*
 * DOM-типи навмисно не додані в tsconfig проєкту: воркер і CLI не мають доступу
 * до document, і глобальний lib "DOM" дозволив би написати там браузерний код,
 * який упаде тільки в проді. Тому оголошення локальні, рівно на цей файл.
 */
declare const document: { open(): void; write(html: string): void; close(): void };
declare const window: unknown;

interface ParsedItem {
  name: string;
  domain: string | null;
  city: string | null;
  country: string | null;
  sizeHint: string | null;
  tags: string[];
  description: string | null;
  sourceUrl: string | null;
  rating: number | null;
  reviewsCount: number | null;
  minProject: string | null;
  hourlyRate: string | null;
  foundedYear: number | null;
  extra: Record<string, string>;
}

interface Parsers {
  parse(): { site: string; known: boolean; method: string; items: ParsedItem[]; nextPage: string | null };
}

function loadParsers(html: string): Parsers {
  document.open();
  document.write(html);
  document.close();

  // Скрипт кладе себе у window.JobRadarParsers, як і в справжній вкладці.
  // eslint-disable-next-line no-eval
  (0, eval)(readFileSync('extension/parsers.js', 'utf8'));
  return (window as unknown as { JobRadarParsers: Parsers }).JobRadarParsers;
}

describe('парсер каталогів у розширенні', () => {
  let result: ReturnType<Parsers['parse']>;

  beforeAll(() => {
    result = loadParsers(readFileSync('fixtures/clutch/web-developers.html', 'utf8')).parse();
  });

  it('впізнає Clutch і розбирає картки, а не запасний JSON-LD', () => {
    expect(result.site).toBe('clutch.co');
    expect(result.known).toBe(true);
    expect(result.method).toBe('cards');
    expect(result.items.length).toBeGreaterThan(0);
  });

  // Правило 3: нуль карток при живій сторінці це помилка, а не порожній каталог.
  it('на чужій розмітці повертає нуль, а не вигадані картки', () => {
    const empty = loadParsers('<html><body><p>Just a moment...</p></body></html>').parse();
    expect(empty.items).toEqual([]);
  });

  it('бере назву і домен компанії, а не посилання на сам каталог', () => {
    const first = result.items[0]!;
    expect(first.name).toBe('Imaginovation');
    expect(first.domain).toBe('imaginovation.net');
    expect(result.items.every((item) => !/clutch\.co/.test(item.domain ?? ''))).toBe(true);
  });

  it('бере оцінку, кількість відгуків, ставку і мінімальний проєкт', () => {
    const first = result.items[0]!;
    expect(first.rating).toBe(4.9);
    expect(first.reviewsCount).toBe(16);
    expect(first.hourlyRate).toBe('$50 - $99 / hr');
    expect(first.minProject).toBe('$10,000+');
    expect(first.sizeHint).toBe('10 - 49');
  });

  it('ставка і мінімальний проєкт не дублюються в тегах послуг', () => {
    const first = result.items[0]!;
    expect(first.tags).not.toContain('$50 - $99 / hr');
    expect(first.tags.some((tag) => /Web Development/i.test(tag))).toBe(true);
  });

  it('блок "Інше" не тягне підписи кнопок і лічильники послуг', () => {
    for (const item of result.items) {
      for (const [label, value] of Object.entries(item.extra)) {
        // "See X Reviews", "Show more about provider" це підписи кнопок, не дані.
        expect(label).not.toMatch(/^(see|show|view|read|visit|\d+%)\b/i);
        expect(value).not.toMatch(/^(\+\d+ services?|show more|\d+ reviews?)$/i);
      }
    }
    // Перевірений профіль на Clutch це справжня ознака, вона лишається.
    expect(result.items[0]!.extra['Перевірений профіль']).toBe('так');
  });

  it('блок "Інше" не тягне підписи, у яких уже є свої колонки', () => {
    for (const item of result.items) {
      const labels = Object.keys(item.extra).join(' ');
      expect(labels).not.toMatch(/min\.? project|hourly rate|employees|location/i);
      for (const value of Object.values(item.extra)) {
        expect(value.length).toBeGreaterThan(0);
        expect(value.length).toBeLessThanOrEqual(120);
      }
      expect(Object.keys(item.extra).length).toBeLessThanOrEqual(12);
    }
  });

  it('оцінка лишається в межах шкали, а відгуки цілим числом', () => {
    for (const item of result.items) {
      if (item.rating !== null) {
        expect(item.rating).toBeGreaterThan(0);
        expect(item.rating).toBeLessThanOrEqual(5);
      }
      if (item.reviewsCount !== null) expect(Number.isInteger(item.reviewsCount)).toBe(true);
    }
  });
});
