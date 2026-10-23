/**
 * The levels of the model's fit read, lowest first, the same order as `buyer` in
 * `config/fit.json`. A small module of its own so scoring can read a level without pulling in the
 * model client.
 */
export const FIT_LEVELS = ['no', 'unlikely', 'possible', 'likely'] as const;
export type FitLevel = (typeof FIT_LEVELS)[number];

/** A stored 0 to 100 back into its level. */
export function fitLevel(fit: number | null): FitLevel | null {
  if (fit === null) return null;
  const index = Math.round((fit / 100) * (FIT_LEVELS.length - 1));
  return FIT_LEVELS[Math.min(Math.max(index, 0), FIT_LEVELS.length - 1)]!;
}
