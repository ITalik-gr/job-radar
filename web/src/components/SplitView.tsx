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

/**
 * Заголовок панелі. Один рядок центрується по висоті, багаторядковий вміст
 * отримує однакові відступи згори і знизу: раніше він тулився до нижньої межі.
 */
export function PaneHeader({ children, stacked = false }: { children: ReactNode; stacked?: boolean }) {
  return (
    <div
      className={stacked ? 'shrink-0' : 'flex shrink-0 items-center gap-3'}
      style={{
        padding: stacked ? '14px 16px' : '10px 16px',
        minHeight: stacked ? undefined : 52,
        borderBottom: '1px solid var(--mantine-color-gray-2)',
      }}
    >
      {children}
    </div>
  );
}

/**
 * Смуга дій під карткою. Липне до низу панелі, тому кнопки завжди видно.
 * Відступи по вертикалі навмисно великі: це найчастіше клікана зона застосунку,
 * і кнопки не мусять тулитись до краю екрана.
 */
export function PaneFooter({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-2"
      style={{
        padding: '24px 16px',
        borderTop: '1px solid var(--mantine-color-gray-2)',
        background: 'var(--mantine-color-body)',
      }}
    >
      {children}
    </div>
  );
}
