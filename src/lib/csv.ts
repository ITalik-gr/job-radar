/**
 * Формування CSV. Окремим модулем, бо екранування тут не очевидне: пробіл у назві
 * вакансії нешкідливий, а кома, лапки або перенос рядка ламають файл так, що
 * таблиця відкриється зі зсунутими стовпцями і цього не видно одразу.
 */

/** Символи, після яких значення обовʼязково береться в лапки. */
const NEEDS_QUOTES = /[",\n\r;]/;

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (!NEEDS_QUOTES.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  if (rows.length === 0) return '';
  const keys = columns ?? Object.keys(rows[0]!);

  const lines = [
    keys.map(csvCell).join(','),
    ...rows.map((row) => keys.map((key) => csvCell(row[key])).join(',')),
  ];

  /*
   * BOM на початку. Без нього Excel відкриває файл у cp1251 і кирилиця
   * перетворюється на питання, а це найпоширеніший спосіб відкрити такий файл.
   */
  return `﻿${lines.join('\r\n')}\r\n`;
}
