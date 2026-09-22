import type { ReactNode } from 'react';

/**
 * Two panes: the list on the left, one open card on the right.
 * The reason for this layout rather than a long column of cards: decisions are made
 * one item at a time, and the buttons have to sit in the same place on the screen
 * every time instead of travelling with the height of the card.
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
 * The pane header. A single line is centred vertically, multi-line content gets equal
 * padding above and below: before this it was pressed against the bottom edge.
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
 * The action bar under the card. It sticks to the bottom of the pane, so the buttons
 * are always visible. The vertical padding is deliberately generous: this is the most
 * clicked area of the application, and the buttons should not hug the screen edge.
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
