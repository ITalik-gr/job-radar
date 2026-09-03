import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const badge = cva(
  'inline-flex max-w-full items-center gap-1 truncate rounded border px-1.5 text-xs leading-[17px] font-medium',
  {
    variants: {
      tone: {
        neutral: 'border-line bg-subtle text-ink-2',
        outline: 'border-line bg-surface text-ink-2',
        accent: 'border-accent-line bg-accent-soft text-accent-ink',
        good: 'border-good-line bg-good-soft text-good-ink',
        warn: 'border-warn-line bg-warn-soft text-warn-ink',
        bad: 'border-bad-line bg-bad-soft text-bad-ink',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badge>;

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badge({ tone }), className)} {...props} />;
}

/** Крапка стану. Завжди йде разом із текстом, бо колір сам по собі нічого не значить. */
export function Dot({ tone = 'neutral' }: { tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'accent' }) {
  const tones = {
    neutral: 'bg-line-strong',
    accent: 'bg-accent',
    good: 'bg-good',
    warn: 'bg-warn',
    bad: 'bg-bad',
  } as const;
  return <span className={cn('inline-block size-1.5 shrink-0 rounded-full', tones[tone])} />;
}
