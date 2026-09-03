import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

/**
 * Таблиця з липким заголовком. Скрол живе на обгортці, а не на сторінці,
 * щоб заголовки колонок не тікали при перегляді сотні компаній.
 */
export function Table({
  head,
  children,
  maxHeight = '68vh',
}: {
  head: ReactNode;
  children: ReactNode;
  maxHeight?: string;
}) {
  return (
    <div className="scroll-thin overflow-auto rounded-lg border border-line bg-surface" style={{ maxHeight }}>
      <table className="w-full border-collapse text-base">
        <thead className="sticky top-0 z-10 bg-surface">
          <tr className="border-b border-line">{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Th({
  children,
  className,
  align = 'left',
}: {
  children?: ReactNode;
  className?: string;
  align?: 'left' | 'right';
}) {
  return (
    <th
      className={cn(
        'label px-2.5 py-1.5 font-medium whitespace-nowrap',
        align === 'right' ? 'text-right' : 'text-left',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Tr({
  children,
  onClick,
  tone,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: 'warn' | 'bad';
  className?: string;
}) {
  return (
    <tr
      onClick={onClick}
      className={cn(
        'border-b border-line last:border-0',
        tone === 'warn' && 'bg-warn-soft',
        tone === 'bad' && 'bg-bad-soft',
        onClick && 'cursor-pointer hover:bg-hover',
        className,
      )}
    >
      {children}
    </tr>
  );
}

export function Td({
  children,
  className,
  align = 'left',
  colSpan,
}: {
  children?: ReactNode;
  className?: string;
  align?: 'left' | 'right';
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      className={cn('px-2.5 py-1.5', align === 'right' && 'text-right tabular-nums', className)}
    >
      {children}
    </td>
  );
}
