import type { ReactNode } from 'react';
import { DropdownMenu as Primitive } from 'radix-ui';

export function Dropdown({ trigger, children }: { trigger: ReactNode; children: ReactNode }) {
  return (
    <Primitive.Root>
      <Primitive.Trigger asChild>{trigger}</Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-56 rounded-md border border-line bg-surface p-1 shadow-[0_8px_24px_rgba(0,0,0,0.10)]"
        >
          {children}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}

export function DropdownItem({
  children,
  hint,
  onSelect,
  disabled,
}: {
  children: ReactNode;
  hint?: string;
  onSelect?: () => void;
  disabled?: boolean;
}) {
  return (
    <Primitive.Item
      disabled={disabled}
      onSelect={onSelect}
      className="cursor-pointer rounded px-1.5 py-1 text-base text-ink outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[highlighted]:bg-subtle"
    >
      <div className="flex items-center gap-2">{children}</div>
      {hint && <div className="text-xs text-ink-3">{hint}</div>}
    </Primitive.Item>
  );
}

export function DropdownLabel({ children }: { children: ReactNode }) {
  return <Primitive.Label className="label px-1.5 py-1">{children}</Primitive.Label>;
}

export function DropdownSeparator() {
  return <Primitive.Separator className="my-1 h-px bg-line" />;
}
