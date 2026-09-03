import type { ReactNode } from 'react';

/**
 * Дві панелі: список ліворуч, одна відкрита картка праворуч.
 * Причина такої розмітки замість довгого списку карток: рішення ухвалюється
 * по одному елементу, і кнопки мусять лежати завжди в одному місці екрана,
 * а не мандрувати разом із висотою картки.
 */
export function SplitView({
  list,
  detail,
  listWidth = 360,
}: {
  list: ReactNode;
  detail: ReactNode;
  listWidth?: number;
}) {
  return (
    <div className="flex h-full min-h-0">
      <div
        className="flex min-h-0 shrink-0 flex-col"
        style={{ width: listWidth, borderRight: '1px solid var(--mantine-color-gray-2)' }}
      >
        {list}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{detail}</div>
    </div>
  );
}

/** Заголовок будь-якої панелі: однакова висота і однакові відступи всюди. */
export function PaneHeader({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex shrink-0 items-center gap-3 px-4"
      style={{ minHeight: 52, borderBottom: '1px solid var(--mantine-color-gray-2)' }}
    >
      {children}
    </div>
  );
}

/** Смуга дій під карткою. Липне до низу панелі, тому кнопки завжди видно. */
export function PaneFooter({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-3"
      style={{
        borderTop: '1px solid var(--mantine-color-gray-2)',
        background: 'var(--mantine-color-body)',
      }}
    >
      {children}
    </div>
  );
}
