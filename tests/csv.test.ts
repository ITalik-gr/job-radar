import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/cli/commands.js';

describe('parseCsv', () => {
  it('reads the header and the rows', () => {
    // Cyrillic note kept: notes are the owner's own free text and are often written in Ukrainian.
    const rows = parseCsv('name,domain,country,note\nAcme,acme.com,UA,привіт\n');
    expect(rows).toEqual([{ name: 'Acme', domain: 'acme.com', country: 'UA', note: 'привіт' }]);
  });

  it('understands quotes, commas and doubled quotes inside a field', () => {
    const rows = parseCsv('name,note\n"Acme, Inc","каже ""привіт"""\n');
    expect(rows[0]).toEqual({ name: 'Acme, Inc', note: 'каже "привіт"' });
  });

  it('skips empty lines and tolerates a missing trailing newline', () => {
    const rows = parseCsv('name,domain\n\nAcme,acme.com');
    expect(rows).toHaveLength(1);
  });

  it('an empty file gives an empty array', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('name,domain\n')).toEqual([]);
  });
});
