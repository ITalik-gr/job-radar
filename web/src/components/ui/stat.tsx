import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

/** Показник у шапці. Значення важливіше за підпис, тому воно більше і темніше. */
export function Stat({
  label,
  value,
  tone,
  className,
}: {
  label: string;
  value: ReactNode;
  tone?: 'warn' | 'bad';
  className?: string;
}) {
  return (
    <div className={cn('shrink-0', className)}>
      <div className="label">{label}</div>
      <div
        className={cn(
          'text-md leading-5 font-medium tabular-nums',
          tone === 'warn' && 'text-warn-ink',
          tone === 'bad' && 'text-bad-ink',
        )}
      >
        {value}
      </div>
    </div>
  );
}
