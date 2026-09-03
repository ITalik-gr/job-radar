import { cn } from '../../lib/utils';

/** Заглушка на час завантаження. Без пульсації: тут не потрібно привертати увагу. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('rounded bg-subtle', className)} />;
}

export function SkeletonRows({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-1.5', className)}>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-7" />
      ))}
    </div>
  );
}
