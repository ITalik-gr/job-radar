/** The list starting from position `offset`, wrapping around. */
export function rotate<T>(items: T[], offset: number): T[] {
  if (items.length === 0) return items;
  const start = ((offset % items.length) + items.length) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}
