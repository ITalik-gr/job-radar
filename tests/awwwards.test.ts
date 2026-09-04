import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDirectory, parseProfile } from '../src/sources/catalogs/awwwards.js';

const directory = readFileSync('fixtures/awwwards/directory.html', 'utf8');
const profile = readFileSync('fixtures/awwwards/profile-obys.html', 'utf8');

describe('awwwards, каталог', () => {
  it('знаходить профілі студій і не повертає нуль', () => {
    // Правило 3 в CLAUDE.md: порожній результат це помилка, не успіх.
    expect(parseDirectory(directory).length).toBeGreaterThan(8);
  });

  it('службові сторінки не потрапляють у список студій', () => {
    const slugs = parseDirectory(directory);
    for (const junk of ['blog', 'academy', 'jobs', 'privacy-policy', 'directory', 'websites']) {
      expect(slugs).not.toContain(junk);
    }
  });

  it('знаходить справжні студії', () => {
    const slugs = parseDirectory(directory);
    expect(slugs.some((slug) => ['obys', 'locomotive', 'resn', 'dogstudio'].includes(slug))).toBe(true);
  });
});

describe('awwwards, профіль', () => {
  it('бере назву і власний домен студії', () => {
    const company = parseProfile(profile, 'obys');

    expect(company).not.toBeNull();
    expect(company!.name).toBe('Obys');
    expect(company!.domain).toBe('obys.agency');
    expect(company!.sourceUrl).toBe('https://www.awwwards.com/obys/');
  });

  it('соцмережі не приймаються за сайт студії', () => {
    const company = parseProfile(profile, 'obys');
    expect(company!.domain).not.toMatch(/facebook|twitter|linkedin|instagram/);
  });

  it('піддомени зводяться до кореня', () => {
    // У профілі поруч лежать obys.agency, experiment.obys.agency і library.obys.agency.
    expect(parseProfile(profile, 'obys')!.domain).toBe('obys.agency');
  });

  it('ставить теги дизайну: сам факт присутності в каталозі це вже профіль студії', () => {
    expect(parseProfile(profile, 'obys')!.tags).toContain('Web Design');
  });

  it('домен клієнта не приймається за сайт студії', () => {
    /*
     * На живих даних Immersive Garden отримав cartier.com, а AQuest gucci.com:
     * у профілі роботи для одного великого клієнта згадуються частіше за власний сайт.
     * Тому спершу шукається домен, схожий на назву, і лише потім найчастіший.
     */
    const html = `<body><h1>Immersive Garden</h1>
      <a href="https://cartier.com/a">1</a>
      <a href="https://cartier.com/b">2</a>
      <a href="https://cartier.com/c">3</a>
      <a href="https://immersive-g.com">свій</a>
    </body>`;
    expect(parseProfile(html, 'immersive-g')!.domain).toBe('immersive-g.com');
  });

  it('складений домен не обрізається до суфікса', () => {
    // resn.co.nz зводився до co.nz, тобто в базу лягав суфікс замість сайта.
    const html = '<body><h1>Resn</h1><a href="https://resn.co.nz/work">роботи</a></body>';
    expect(parseProfile(html, 'resn')!.domain).toBe('resn.co.nz');
  });

  it('якщо схожого за назвою немає, береться найчастіший', () => {
    const html = `<body><h1>Загадкова студія</h1>
      <a href="https://alpha.com/1">1</a>
      <a href="https://alpha.com/2">2</a>
      <a href="https://beta.com">3</a>
    </body>`;
    expect(parseProfile(html, 'zagadka')!.domain).toBe('alpha.com');
  });

  it('сторінка без h1 не дає компанію, а не вигадану', () => {
    expect(parseProfile('<body><p>нічого</p></body>', 'x')).toBeNull();
  });

  it('профіль без зовнішніх посилань не дає компанію без домену', () => {
    expect(parseProfile('<body><h1>Studio</h1></body>', 'x')).toBeNull();
  });
});
