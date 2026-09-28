/**
 * Split a list into slices. D1 accepts at most a hundred bound parameters per query, so a
 * multi-row insert or an `in (...)` has to stay under that: rows times columns for an insert,
 * list length for `in`. Local SQLite takes more, the lower limit wins because the code is shared.
 */
export function chunk<T>(items: T[], size: number): T[][] {
  const slices: T[][] = [];
  for (let i = 0; i < items.length; i += size) slices.push(items.slice(i, i + size));
  return slices;
}

/** How many rows of `columns` columns fit into one D1 query. */
export function rowsPerQuery(columns: number): number {
  return Math.max(1, Math.floor(100 / columns));
}
