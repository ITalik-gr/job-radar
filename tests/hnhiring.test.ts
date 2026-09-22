import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { firstLink, parseHeader, parseHnThread } from '../src/sources/boards/hnhiring.js';

/** Fixture is the first eight postings from a real September thread. */
const payload = readFileSync('fixtures/hn/who-is-hiring.json', 'utf8');

describe('posting header parsing', () => {
  it('extracts company, role and location', () => {
    expect(parseHeader('Modash.io | Senior Product Engineer | Remote (Europe) | Full-time | €75k')).toMatchObject({
      company: 'Modash.io',
      title: 'Senior Product Engineer',
      remote: true,
    });
  });

  it('salary range and employment type do not become the location', () => {
    const parsed = parseHeader('Quill | Fullstack SWE | Full-time | Remote | $150 - 210K USD');
    expect(parsed.location).toBe('Remote');
    expect(parsed.title).toBe('Fullstack SWE');
  });

  it('an office without the word remote reads as not remote', () => {
    expect(parseHeader('Acme | Backend Engineer | Berlin | ONSITE').remote).toBe(false);
  });

  it('a line without dashes gives only a name', () => {
    expect(parseHeader('just text')).toMatchObject({ company: 'just text', title: null });
  });
});

describe('links', () => {
  it('takes the first external link, not a link to HN itself', () => {
    const html = '<a href="https://news.ycombinator.com/item?id=1">a</a> <a href="https:&#x2F;&#x2F;acme.com">b</a>';
    expect(firstLink(html)).toBe('https://acme.com');
  });

  it('no links means null, not an empty string', () => {
    expect(firstLink('<p>nothing</p>')).toBeNull();
  });
});

describe('whole thread', () => {
  const posts = parseHnThread(payload);

  it('returns postings with the company domain', () => {
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every((post) => post.companyDomain && post.companyName)).toBe(true);
  });

  it('links to the comment, since that is where the reply contact is', () => {
    expect(posts[0]!.url).toMatch(/news\.ycombinator\.com\/item\?id=\d+/);
  });

  it('posting text is kept whole, without html', () => {
    expect(posts[0]!.rawText).not.toContain('<a href');
    expect(posts[0]!.rawText.length).toBeGreaterThan(100);
  });

  it('an empty thread is zero records, not an exception', () => {
    expect(parseHnThread('{"id":1,"children":[]}')).toEqual([]);
  });
});
