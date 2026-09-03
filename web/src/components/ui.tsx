import type { ReactNode } from 'react';

export function Tag({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' }) {
  const tones = {
    neutral: 'bg-[var(--color-panel-2)] text-[var(--color-muted)] border-[var(--color-line)]',
    good: 'bg-[#12271c] text-[var(--color-accent)] border-[#1e4433]',
    warn: 'bg-[#2a2213] text-[var(--color-warn)] border-[#4a3a19]',
    bad: 'bg-[#2a1618] text-[var(--color-danger)] border-[#4a2226]',
  } as const;

  return (
    <span className={`inline-block rounded border px-1.5 py-px text-[11px] leading-4 ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  tone = 'neutral',
  disabled,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: 'neutral' | 'good' | 'bad';
  disabled?: boolean;
  title?: string;
}) {
  const tones = {
    neutral: 'border-[var(--color-line)] hover:bg-[var(--color-panel-2)]',
    good: 'border-[#1e4433] text-[var(--color-accent)] hover:bg-[#12271c]',
    bad: 'border-[#4a2226] text-[var(--color-danger)] hover:bg-[#2a1618]',
  } as const;

  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`rounded border px-2 py-1 text-[12px] disabled:opacity-40 ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded border border-[var(--color-line)] bg-[var(--color-panel)] ${className}`}>
      {children}
    </div>
  );
}

export function Score({ value }: { value: number | null }) {
  const score = value ?? 0;
  const tone = score >= 12 ? 'good' : score >= 6 ? 'warn' : 'neutral';
  return <Tag tone={tone}>{score.toFixed(1)}</Tag>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-[var(--color-muted)]">{label}</span>
      <span>{children}</span>
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  return (
    <div className="rounded border border-[#4a2226] bg-[#2a1618] p-2 text-[var(--color-danger)]">
      {error instanceof Error ? error.message : String(error)}
    </div>
  );
}
