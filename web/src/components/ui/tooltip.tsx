import type { ReactNode } from 'react';
import { Tooltip as Primitive } from 'radix-ui';

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <Primitive.Provider delayDuration={250}>{children}</Primitive.Provider>;
}

export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  if (!content) return <>{children}</>;
  return (
    <Primitive.Root>
      <Primitive.Trigger asChild>{children}</Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          sideOffset={5}
          className="z-50 max-w-80 rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink shadow-[0_8px_24px_rgba(0,0,0,0.12)]"
        >
          {content}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
