import { forwardRef } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const button = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap select-none disabled:pointer-events-none disabled:opacity-45 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'border-line bg-surface text-ink hover:bg-subtle hover:border-line-strong',
        primary: 'border-accent-ink bg-accent text-white hover:bg-accent-ink',
        good: 'border-good-line bg-good-soft text-good-ink hover:border-good',
        bad: 'border-bad-line bg-bad-soft text-bad-ink hover:border-bad',
        ghost: 'border-transparent bg-transparent text-ink-2 hover:bg-subtle hover:text-ink',
      },
      size: {
        sm: 'h-6 px-2 text-xs [&_svg]:size-3',
        md: 'h-7 px-2.5 text-sm [&_svg]:size-3.5',
        lg: 'h-8 px-3 text-base [&_svg]:size-4',
        icon: 'size-7 [&_svg]:size-3.5',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => (
    <button ref={ref} type={type} className={cn(button({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = 'Button';
