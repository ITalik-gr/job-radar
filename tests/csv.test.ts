import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/cli/commands.js';

describe('parseCsv', () => {
  it('читає заголовок і рядки', () => {
    const rows = parseCsv('name,domain,country,note\nAcme,acme.com,UA,привіт\n');
    expect(rows).toEqual([{ name: 'Acme', domain: 'acme.com', country: 'UA', note: 'привіт' }]);
  });

  it('розуміє лапки, коми і подвоєні лапки всередині', () => {
    const rows = parseCsv('name,note\n"Acme, Inc","каже ""привіт"""\n');
    expect(rows[0]).toEqual({ name: 'Acme, Inc', note: 'каже "привіт"' });
  });

  it('пропускає порожні рядки і терпить відсутній кінцевий перенос', () => {
    const rows = parseCsv('name,domain\n\nAcme,acme.com');
    expect(rows).toHaveLength(1);
  });

  it('порожній файл дає порожній масив', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('name,domain\n')).toEqual([]);
  });
});
