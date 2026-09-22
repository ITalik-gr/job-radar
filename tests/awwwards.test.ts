import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDirectory, parseProfile } from '../src/sources/catalogs/awwwards.js';

const directory = readFileSync('fixtures/awwwards/directory.html', 'utf8');
const profile = readFileSync('fixtures/awwwards/profile-obys.html', 'utf8');

describe('awwwards, directory', () => {
  it('finds studio profiles and does not return zero', () => {
    // Rule 3 in CLAUDE.md: an empty result is an error, not a success.
    expect(parseDirectory(directory).length).toBeGreaterThan(8);
  });

  it('service pages do not end up in the studio list', () => {
    const slugs = parseDirectory(directory);
    for (const junk of ['blog', 'academy', 'jobs', 'privacy-policy', 'directory', 'websites']) {
      expect(slugs).not.toContain(junk);
    }
  });

  it('finds real studios', () => {
    const slugs = parseDirectory(directory);
    expect(slugs.some((slug) => ['obys', 'locomotive', 'resn', 'dogstudio'].includes(slug))).toBe(true);
  });
});

describe('awwwards, profile', () => {
  it('takes the studio name and its own domain', () => {
    const company = parseProfile(profile, 'obys');

    expect(company).not.toBeNull();
    expect(company!.name).toBe('Obys');
    expect(company!.domain).toBe('obys.agency');
    expect(company!.sourceUrl).toBe('https://www.awwwards.com/obys/');
  });

  it('social networks are not accepted as the studio site', () => {
    const company = parseProfile(profile, 'obys');
    expect(company!.domain).not.toMatch(/facebook|twitter|linkedin|instagram/);
  });

  it('subdomains collapse to the root', () => {
    // The profile has obys.agency, experiment.obys.agency and library.obys.agency side by side.
    expect(parseProfile(profile, 'obys')!.domain).toBe('obys.agency');
  });

  it('sets design tags: presence in the catalog is itself a studio profile', () => {
    expect(parseProfile(profile, 'obys')!.tags).toContain('Web Design');
  });

  it('a client domain is not accepted as the studio site', () => {
    /*
     * On live data Immersive Garden got cartier.com, and AQuest got gucci.com:
     * a profile mentions work for one big client more often than the studio's own site.
     * So the domain closest to the name is tried first, and only then the most frequent one.
     */
    const html = `<body><h1>Immersive Garden</h1>
      <a href="https://cartier.com/a">1</a>
      <a href="https://cartier.com/b">2</a>
      <a href="https://cartier.com/c">3</a>
      <a href="https://immersive-g.com">own site</a>
    </body>`;
    expect(parseProfile(html, 'immersive-g')!.domain).toBe('immersive-g.com');
  });

  it('a compound domain is not trimmed down to its suffix', () => {
    // resn.co.nz used to collapse to co.nz, so the database ended up with the suffix instead of the site.
    const html = '<body><h1>Resn</h1><a href="https://resn.co.nz/work">work</a></body>';
    expect(parseProfile(html, 'resn')!.domain).toBe('resn.co.nz');
  });

  it('if nothing is close to the name, the most frequent one is taken', () => {
    const html = `<body><h1>Mystery Studio</h1>
      <a href="https://alpha.com/1">1</a>
      <a href="https://alpha.com/2">2</a>
      <a href="https://beta.com">3</a>
    </body>`;
    expect(parseProfile(html, 'zagadka')!.domain).toBe('alpha.com');
  });

  it('a page without an h1 does not produce a company, not a made-up one', () => {
    expect(parseProfile('<body><p>nothing</p></body>', 'x')).toBeNull();
  });

  it('a profile without outbound links does not produce a company without a domain', () => {
    expect(parseProfile('<body><h1>Studio</h1></body>', 'x')).toBeNull();
  });
});
