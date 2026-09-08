/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://studio.example.com/" }
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Smoke-тест читача намальованої сторінки, правило 2 в CLAUDE.md.
 *
 * Цей скрипт інжектиться у фонову вкладку і бачить уже готовий DOM, тому перевіряти
 * його треба так само: покласти в jsdom справжню сторінку і подивитись, що він з неї
 * дістав. Без тесту зміна в ньому ламала б збір тихо, а виглядало б це як "на сайті
 * нічого немає", і власник ходив би вписувати пошту руками.
 */
declare const document: { open(): void; write(html: string): void; close(): void };

interface SiteResult {
  domain: string;
  emails: { email: string; name: string | null; role: string | null; generic: boolean }[];
  techHints: string[];
  copyrightYear: number | null;
  lastPostAt: number | null;
  textLength: number;
}

function readSite(html: string): SiteResult {
  document.open();
  document.write(html);
  document.close();

  // Останній вираз файла це результат, який забирає chrome.scripting.
  // eslint-disable-next-line no-eval
  return (0, eval)(readFileSync('extension/site.js', 'utf8')) as SiteResult;
}

const page = `
  <html><head><script src="/_next/static/chunk.js"></script></head>
  <body>
    <h1>Studio</h1>
    <p>We build headless commerce on Shopify Plus with Sanity and Next.js.</p>
    <a href="mailto:hello@studio.example.com">Write to us</a>
    <p>Anna Koval, CTO: <a href="mailto:anna@studio.example.com">anna@studio.example.com</a></p>
    <footer>© 2026 Studio. Last post 2026-08-14.</footer>
  </body></html>
`;

describe('читач намальованої сторінки', () => {
  const result = readSite(page);

  it('бере пошту з посилань і з тексту', () => {
    expect(result.emails.map((item) => item.email)).toEqual(
      expect.arrayContaining(['hello@studio.example.com', 'anna@studio.example.com']),
    );
  });

  /*
   * Іменна адреса цінніша за hello@: її читає людина, а не менеджер із загальної
   * скриньки. Порядок тут визначає, кого сервер запише контактом першим.
   */
  it('іменна адреса йде поперед загальної', () => {
    expect(result.emails[0]?.email).toBe('anna@studio.example.com');
    expect(result.emails.find((item) => item.email.startsWith('hello@'))?.generic).toBe(true);
  });

  it('бере стек і з тексту, і з розмітки', () => {
    expect(result.techHints).toEqual(
      expect.arrayContaining(['headless cms', 'shopify', 'sanity', 'next.js']),
    );
  });

  it('бере ознаки живості і домен без www', () => {
    expect(result.copyrightYear).toBe(2026);
    expect(result.lastPostAt).toBe(Date.parse('2026-08-14'));
    expect(result.domain).toBe('studio.example.com');
  });

  it('порожня сторінка не вигадує нічого', () => {
    const empty = readSite('<html><body><div id="root"></div></body></html>');
    expect(empty.emails).toEqual([]);
    expect(empty.techHints).toEqual([]);
    expect(empty.copyrightYear).toBeNull();
  });
});
