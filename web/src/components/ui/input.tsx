import { forwardRef } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '../../lib/utils';

const base =
  'h-7 w-full rounded-md border border-line bg-surface px-2 text-base text-ink placeholder:text-ink-3 hover:border-line-strong disabled:opacity-45';

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => <input ref={ref} className={cn(base, className)} {...props} />,
);
Input.displayName = 'Input';

/** Пошук із іконкою і хрестиком очищення. Хрестик потрібен, бо фільтр легко забути скинути. */
export function SearchInput({
  value,
  onValueChange,
  placeholder,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-ink-3" />
      <input
        value={value}
        placeholder={placeholder}
        onChange={(event) => onValueChange(event.target.value)}
        className={cn(base, 'pr-6 pl-7')}
      />
      {value && (
        <button
          type="button"
          aria-label="очистити"
          onClick={() => onValueChange('')}
          className="absolute top-1/2 right-1.5 -translate-y-1/2 text-ink-3 hover:text-ink"
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(base, 'h-auto min-h-16 py-1.5', className)} {...props} />;
}
