import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

/**
 * Компактний порожній стан: рядок тексту і підказка, що робити далі.
 * Свідомо не на пів екрана, бо це робочий інструмент, а не онбординг.
 */
export function Empty({
  title,
  hint,
  action,
  className,
}: {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2.5', className)}>
      <div className="min-w-0">
        <div className="text-ink">{title}</div>
        {hint && <div className="text-sm text-ink-3">{hint}</div>}
      </div>
      {action && <div className="ml-auto shrink-0">{action}</div>}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  return (
    <div className="rounded-lg border border-bad-line bg-bad-soft px-3 py-2 text-bad-ink">
      {error instanceof Error ? error.message : String(error)}
    </div>
  );
}
