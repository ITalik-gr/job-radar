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
 * One description of each status for the whole application: label, dot colour and icon.
 * The icon matters in the dropdown: seven similar words in a row are hard to tell
 * apart, and the shape of an icon reads faster than text.
 */
export const STATUS_META: Record<
  string,
  { label: string; color: string; icon: typeof Circle; hint: string }
> = {
  new: { label: 'new', color: 'gray', icon: Circle, hint: 'nothing decided yet' },
  interesting: { label: 'interesting', color: 'brand', icon: Star, hint: 'kept for later, stays in the lists' },
  contacted: { label: 'contacted', color: 'yellow', icon: Send, hint: 'letter sent, waiting for an answer' },
  replied: { label: 'replied', color: 'green', icon: CornerDownLeft, hint: 'an answer came in' },
  rejected_by_me: { label: 'rejected by me', color: 'gray', icon: ThumbsDown, hint: 'not interesting, removed from the lists' },
  rejected_by_them: { label: 'rejected by them', color: 'red', icon: XCircle, hint: 'the company said no' },
  blacklist: { label: 'blacklist', color: 'red', icon: Ban, hint: 'never show again' },
  snoozed: { label: 'snoozed', color: 'gray', icon: Clock, hint: 'hidden until the given date' },
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
  return STATUS_META[status ?? 'new']?.label ?? status ?? 'new';
}

export function statusColor(status: string | null): string {
  return STATUS_META[status ?? 'new']?.color ?? 'gray';
}

/**
 * The status dot is a plain span rather than a Mantine Indicator. Indicator renders the
 * dot as a separately positioned layer, and in a table with a sticky header it slid over
 * the column heading while scrolling.
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

/** Icon of the current status for the select trigger. */
export function StatusIcon({ status, size = 15 }: { status: string | null; size?: number }) {
  const meta = STATUS_META[status ?? 'new'];
  const Icon = meta?.icon ?? Circle;
  return <Icon size={size} color={`var(--mantine-color-${meta?.color ?? 'gray'}-6)`} />;
}

/** A dropdown row: icon, label and a short note on what the status means. */
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
