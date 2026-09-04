import { Group, Text } from '@mantine/core';
import {
  Ban,
  Circle,
  Clock,
  CornerDownLeft,
  Send,
  Star,
  ThumbsDown,
  XCircle,
} from 'lucide-react';

/**
 * Один опис статусу на весь застосунок: підпис, колір крапки і іконка.
 * Іконка потрібна в дропдауні: сім схожих українських слів поспіль розрізняються
 * погано, а форма іконки читається швидше за текст.
 */
export const STATUS_META: Record<
  string,
  { label: string; color: string; icon: typeof Circle; hint: string }
> = {
  new: { label: 'нова', color: 'gray', icon: Circle, hint: 'ще нічого не вирішено' },
  interesting: { label: 'цікава', color: 'brand', icon: Star, hint: 'відкладена на потім, лишається у списках' },
  contacted: { label: 'написали', color: 'yellow', icon: Send, hint: 'лист надіслано, чекаємо відповідь' },
  replied: { label: 'відповіли', color: 'green', icon: CornerDownLeft, hint: 'відповідь отримана' },
  rejected_by_me: { label: 'відкинув сам', color: 'gray', icon: ThumbsDown, hint: 'не цікаво, зі списків прибрана' },
  rejected_by_them: { label: 'відмовили', color: 'red', icon: XCircle, hint: 'компанія відмовила' },
  blacklist: { label: 'блокліст', color: 'red', icon: Ban, hint: 'ніколи не показувати' },
  snoozed: { label: 'відкладена', color: 'gray', icon: Clock, hint: 'прихована до вказаної дати' },
};

export const STATUS_ORDER = [
  'new',
  'interesting',
  'contacted',
  'replied',
  'rejected_by_me',
  'rejected_by_them',
  'blacklist',
  'snoozed',
];

export const STATUS_OPTIONS = STATUS_ORDER.map((value) => ({
  value,
  label: STATUS_META[value]?.label ?? value,
}));

export function statusLabel(status: string | null): string {
  return STATUS_META[status ?? 'new']?.label ?? status ?? 'нова';
}

export function statusColor(status: string | null): string {
  return STATUS_META[status ?? 'new']?.color ?? 'gray';
}

/**
 * Крапка стану власним span, а не через Mantine Indicator. Indicator виносить
 * крапку окремим позиціонованим шаром, і в таблиці з липкою шапкою вона лізла
 * поверх заголовка колонки при скролі.
 */
export function Dot({ color }: { color: string }) {
  return (
    <span
      style={{
        width: 7,
        height: 7,
        borderRadius: '50%',
        flex: 'none',
        background: `var(--mantine-color-${color}-6)`,
      }}
    />
  );
}

export function StatusDot({ status }: { status: string | null }) {
  return <Dot color={statusColor(status)} />;
}

export function StatusCell({ status }: { status: string | null }) {
  return (
    <Group gap={8} wrap="nowrap">
      <StatusDot status={status} />
      <Text size="sm" truncate>
        {statusLabel(status)}
      </Text>
    </Group>
  );
}

/** Іконка поточного статусу для тригера селекта. */
export function StatusIcon({ status, size = 15 }: { status: string | null; size?: number }) {
  const meta = STATUS_META[status ?? 'new'];
  const Icon = meta?.icon ?? Circle;
  return <Icon size={size} color={`var(--mantine-color-${meta?.color ?? 'gray'}-6)`} />;
}

/** Рядок дропдауна: іконка, підпис і коротке пояснення, що статус означає. */
export function renderStatusOption({ option }: { option: { value: string; label: string } }) {
  const meta = STATUS_META[option.value];
  const Icon = meta?.icon ?? Circle;

  return (
    <Group gap="sm" wrap="nowrap">
      <Icon size={15} color={`var(--mantine-color-${meta?.color ?? 'gray'}-6)`} />
      <div style={{ minWidth: 0 }}>
        <Text size="sm">{option.label}</Text>
        {meta?.hint && (
          <Text size="xs" c="dimmed">
            {meta.hint}
          </Text>
        )}
      </div>
    </Group>
  );
}
