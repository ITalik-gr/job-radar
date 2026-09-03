import { Checkbox as Primitive } from 'radix-ui';
import { Check } from 'lucide-react';

export function Checkbox({
  checked,
  onCheckedChange,
  label,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-base text-ink-2 select-none hover:text-ink">
      <Primitive.Root
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next === true)}
        className="flex size-4 items-center justify-center rounded border border-line-strong bg-surface data-[state=checked]:border-accent-ink data-[state=checked]:bg-accent data-[state=checked]:text-white"
      >
        <Primitive.Indicator>
          <Check className="size-3" strokeWidth={3} />
        </Primitive.Indicator>
      </Primitive.Root>
      {label}
    </label>
  );
}
