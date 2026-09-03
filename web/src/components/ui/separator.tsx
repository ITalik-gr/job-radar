import { Separator as Primitive } from 'radix-ui';
import { cn } from '../../lib/utils';

export function Separator({
  orientation = 'horizontal',
  className,
}: {
  orientation?: 'horizontal' | 'vertical';
  className?: string;
}) {
  return (
    <Primitive.Root
      orientation={orientation}
      className={cn('shrink-0 bg-line', orientation === 'vertical' ? 'h-4 w-px' : 'h-px w-full', className)}
    />
  );
}
