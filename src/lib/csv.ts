/**
 * Building CSV. A module of its own, because the escaping here is not obvious: a
 * space in a vacancy title is harmless, but a comma, a quote, or a line break breaks
 * the file so that the table opens with shifted columns, and it is not obvious right away.
 */

/** Characters after which a value must be quoted. */
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
   * A BOM at the start. Without it Excel opens the file as cp1251 and Cyrillic turns
   * into question marks, and that is the most common way this file gets opened.
   */
  return `﻿${lines.join('\r\n')}\r\n`;
}
