import { cn } from '../../lib/utils';

/**
 * Рахунок читається як число, не як прогресбар: власнику потрібно порівнювати значення.
 * Колір лише підказує зону, тому число завжди видно.
 */
export function Score({ value, className }: { value: number | null; className?: string }) {
  const score = value ?? 0;
  const tone =
    score >= 12
      ? 'border-good-line bg-good-soft text-good-ink'
      : score >= 6
        ? 'border-accent-line bg-accent-soft text-accent-ink'
        : score <= -50
          ? 'border-bad-line bg-bad-soft text-bad-ink'
          : 'border-line bg-subtle text-ink-2';

  return (
    <span
      className={cn(
        'inline-flex h-6 min-w-9 items-center justify-center rounded border px-1 text-base font-medium tabular-nums',
        tone,
        className,
      )}
    >
      {score.toFixed(1)}
    </span>
  );
}
