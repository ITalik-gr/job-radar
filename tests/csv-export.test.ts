import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from '../src/lib/csv.js';

describe('csv', () => {
  it('a plain value is not wrapped in quotes', () => {
    expect(csvCell('Frontend Developer')).toBe('Frontend Developer');
  });

  it('commas, quotes and line breaks are escaped', () => {
    expect(csvCell('Kyiv, Ukraine')).toBe('"Kyiv, Ukraine"');
    expect(csvCell('says "hello"')).toBe('"says ""hello"""');
    expect(csvCell('first\nsecond')).toBe('"first\nsecond"');
  });

  it('empty values are an empty cell, not the string null', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(0)).toBe('0');
  });

  it('the file starts with a BOM, otherwise Excel corrupts Cyrillic', () => {
    expect(toCsv([{ назва: 'Розробник' }]).startsWith('﻿')).toBe(true);
  });

  it('the header is taken from the keys of the first row', () => {
    const csv = toCsv([{ a: 1, b: 2 }]);
    expect(csv).toContain('a,b');
  });

  it('column order can be set explicitly', () => {
    const csv = toCsv([{ a: 1, b: 2 }], ['b', 'a']);
    expect(csv.split('\r\n')[0]).toBe('﻿b,a');
  });

  it('an empty list gives an empty file, not just headers', () => {
    expect(toCsv([])).toBe('');
  });
});
