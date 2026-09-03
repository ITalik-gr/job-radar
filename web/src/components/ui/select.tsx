import { Select as Primitive } from 'radix-ui';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface Option {
  value: string;
  label: string;
}

/**
 * Radix Select замість нативного: нативний на macOS не дає керувати виглядом
 * і на щільній сітці виглядає чужим. API навмисно вузьке, лише список опцій.
 */
export function Select({
  value,
  onValueChange,
  options,
  placeholder = 'вибрати',
  className,
  ariaLabel,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: Option[];
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <Primitive.Root value={value || '__any'} onValueChange={(next) => onValueChange(next === '__any' ? '' : next)}>
      <Primitive.Trigger
        aria-label={ariaLabel}
        className={cn(
          'flex h-7 items-center gap-1.5 rounded-md border border-line bg-surface px-2 text-base text-ink hover:border-line-strong data-[placeholder]:text-ink-3',
          className,
        )}
      >
        <span className="truncate">
          <Primitive.Value placeholder={placeholder} />
        </span>
        <Primitive.Icon className="ml-auto text-ink-3">
          <ChevronDown className="size-3.5" />
        </Primitive.Icon>
      </Primitive.Trigger>

      <Primitive.Portal>
        <Primitive.Content
          position="popper"
          sideOffset={4}
          className="scroll-thin z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-auto rounded-md border border-line bg-surface p-1 shadow-[0_8px_24px_rgba(0,0,0,0.10)]"
        >
          <Primitive.Viewport>
            {options.map((option) => (
              <Primitive.Item
                key={option.value}
                value={option.value || '__any'}
                className="flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-base text-ink outline-none data-[highlighted]:bg-subtle"
              >
                <Primitive.ItemIndicator>
                  <Check className="size-3" />
                </Primitive.ItemIndicator>
                <Primitive.ItemText>{option.label}</Primitive.ItemText>
              </Primitive.Item>
            ))}
          </Primitive.Viewport>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
