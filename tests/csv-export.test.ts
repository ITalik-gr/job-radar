import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from '../src/lib/csv.js';

describe('csv', () => {
  it('звичайне значення не береться в лапки', () => {
    expect(csvCell('Frontend Developer')).toBe('Frontend Developer');
  });

  it('кома, лапки і перенос рядка екрануються', () => {
    expect(csvCell('Kyiv, Ukraine')).toBe('"Kyiv, Ukraine"');
    expect(csvCell('каже "привіт"')).toBe('"каже ""привіт"""');
    expect(csvCell('перший\nдругий')).toBe('"перший\nдругий"');
  });

  it('порожні значення це порожня клітинка, а не рядок null', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(0)).toBe('0');
  });

  it('файл починається з BOM, інакше Excel псує кирилицю', () => {
    expect(toCsv([{ назва: 'Розробник' }]).startsWith('﻿')).toBe(true);
  });

  it('заголовок береться з ключів першого рядка', () => {
    const csv = toCsv([{ a: 1, b: 2 }]);
    expect(csv).toContain('a,b');
  });

  it('порядок стовпців можна задати явно', () => {
    const csv = toCsv([{ a: 1, b: 2 }], ['b', 'a']);
    expect(csv.split('\r\n')[0]).toBe('﻿b,a');
  });

  it('порожній список дає порожній файл, а не самі заголовки', () => {
    expect(toCsv([])).toBe('');
  });
});
