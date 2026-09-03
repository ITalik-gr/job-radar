import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('rounded-lg border border-line bg-surface', className)}>{children}</div>;
}

export function CardHeader({
  title,
  hint,
  actions,
  className,
}: {
  title: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-3 border-b border-line px-3 py-2', className)}>
      <div className="min-w-0">
        <div className="label">{title}</div>
        {hint && <div className="truncate text-xs text-ink-3">{hint}</div>}
      </div>
      {actions && <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('p-3', className)}>{children}</div>;
}
