import type { ReactNode } from 'react';
import { Dialog as Primitive } from 'radix-ui';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';

export function Dialog({
  open,
  onOpenChange,
  title,
  hint,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 z-40 bg-black/25" />
        <Primitive.Content
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex max-h-[88vh] w-[min(1000px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-line bg-surface shadow-[0_16px_48px_rgba(0,0,0,0.18)]',
            className,
          )}
        >
          <div className="flex items-start gap-3 border-b border-line px-3 py-2">
            <div className="min-w-0">
              <Primitive.Title className="truncate text-lg font-medium">{title}</Primitive.Title>
              {hint && <Primitive.Description asChild><div className="text-sm text-ink-3">{hint}</div></Primitive.Description>}
            </div>
            <Primitive.Close
              aria-label="закрити"
              className="ml-auto shrink-0 rounded p-1 text-ink-3 hover:bg-subtle hover:text-ink"
            >
              <X className="size-4" />
            </Primitive.Close>
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-auto">{children}</div>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
