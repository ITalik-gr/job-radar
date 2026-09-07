import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { firstLink, parseHeader, parseHnThread } from '../src/sources/boards/hnhiring.js';

/** Фікстура це вісім перших оголошень зі справжньої вересневої гілки. */
const payload = readFileSync('fixtures/hn/who-is-hiring.json', 'utf8');

describe('розбір заголовка оголошення', () => {
  it('витягує компанію, роль і локацію', () => {
    expect(parseHeader('Modash.io | Senior Product Engineer | Remote (Europe) | Full-time | €75k')).toMatchObject({
      company: 'Modash.io',
      title: 'Senior Product Engineer',
      remote: true,
    });
  });

  it('вилка і тип зайнятості не стають локацією', () => {
    const parsed = parseHeader('Quill | Fullstack SWE | Full-time | Remote | $150 - 210K USD');
    expect(parsed.location).toBe('Remote');
    expect(parsed.title).toBe('Fullstack SWE');
  });

  it('офіс без слова remote читається як не віддалено', () => {
    expect(parseHeader('Acme | Backend Engineer | Berlin | ONSITE').remote).toBe(false);
  });

  it('рядок без рисок дає лише назву', () => {
    expect(parseHeader('просто текст')).toMatchObject({ company: 'просто текст', title: null });
  });
});

describe('посилання', () => {
  it('бере перше зовнішнє, а не посилання на сам HN', () => {
    const html = '<a href="https://news.ycombinator.com/item?id=1">a</a> <a href="https:&#x2F;&#x2F;acme.com">b</a>';
    expect(firstLink(html)).toBe('https://acme.com');
  });

  it('без посилань це null, а не порожній рядок', () => {
    expect(firstLink('<p>нічого</p>')).toBeNull();
  });
});

describe('гілка цілком', () => {
  const posts = parseHnThread(payload);

  it('віддає оголошення з доменом компанії', () => {
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every((post) => post.companyDomain && post.companyName)).toBe(true);
  });

  it('посилається на коментар, бо там контакт для відповіді', () => {
    expect(posts[0]!.url).toMatch(/news\.ycombinator\.com\/item\?id=\d+/);
  });

  it('текст оголошення зберігається цілком, без html', () => {
    expect(posts[0]!.rawText).not.toContain('<a href');
    expect(posts[0]!.rawText.length).toBeGreaterThan(100);
  });

  it('порожня гілка це нуль записів, а не виняток', () => {
    expect(parseHnThread('{"id":1,"children":[]}')).toEqual([]);
  });
});
