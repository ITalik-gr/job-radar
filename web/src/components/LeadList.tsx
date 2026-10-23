import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { ActionIcon, Box, Group, Kbd, Text, Tooltip } from '@mantine/core';
import { Ban, Clock, Mail, Phone, SkipForward, Star, UserRound } from 'lucide-react';
import { api, companyKey, type ListCard } from '../lib/api';
import { useHotkeys } from '../lib/hotkeys';
import { openCompany, useListMemory } from '../lib/listMemory';
import { Score } from './Score';
import { FitBadge, ReasonChip, reasons, SegmentBadge } from './ui';

export type CardAction = { action: 'interesting' } | { action: 'not_interesting' } | { action: 'blacklist' } | { action: 'snooze'; days: number };

const QUICK: { key: string; label: string; icon: typeof Star; body: CardAction; color?: string }[] = [
  { key: 'i', label: 'Interesting', icon: Star, body: { action: 'interesting' } },
  { key: 'n', label: 'Skip: not interesting, leaves the list', icon: SkipForward, body: { action: 'not_interesting' } },
  { key: 's', label: 'Snooze for 60 days', icon: Clock, body: { action: 'snooze', days: 60 } },
  { key: 'b', label: 'Block: never show again', icon: Ban, body: { action: 'blacklist' }, color: 'red' },
];

const DONE: Record<CardAction['action'], string> = {
  interesting: 'marked interesting',
  not_interesting: 'skipped',
  snooze: 'snoozed for 60 days',
  blacklist: 'blocked',
};

/**
 * Loads the full card of a row the cursor or the mouse rests on, so Enter opens a page that is
 * already complete. A short delay keeps a fast J J J from fetching every row it passes.
 */
export function usePrefetchCompany(): (key: string) => void {
  const client = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  return useCallback(
    (key: string) => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void client.prefetchQuery({ queryKey: ['company-card', key], queryFn: () => api.companyCard(key) });
      }, 150);
    },
    [client],
  );
}

/** A card action from a list row or the company page, with the lists refreshed after it. */
export function useCardAction(): (card: Pick<ListCard, 'companyId' | 'name'>, body: CardAction) => void {
  const client = useQueryClient();
  const act = useMutation({
    mutationFn: ({ id, body }: { id: number; body: CardAction; name: string }) => api.companyAction(id, body),
    onSuccess: (_result, { name, body }) => {
      notifications.show({ color: 'green', title: name, message: DONE[body.action] });
      for (const key of ['studios', 'queue', 'stats', 'companies', 'company', 'company-card']) {
        void client.invalidateQueries({ queryKey: [key] });
      }
    },
    onError: (error) => notifications.show({ color: 'red', title: 'not saved', message: String(error) }),
  });
  const { mutate } = act;
  return useCallback((card, body) => mutate({ id: card.companyId, body, name: card.name }), [mutate]);
}

function Reach({ card }: { card: ListCard }) {
  const named = card.contacts.find((contact) => contact.name);
  const email = card.contacts.some((contact) => contact.email && contact.emailValid);
  return (
    <Group gap={8} wrap="nowrap" c="gray.6" w={64} justify="flex-end">
      {named && (
        <Tooltip label={`named contact: ${named.name}${named.role ? `, ${named.role}` : ''}`}>
          <UserRound size={15} strokeWidth={1.75} aria-label="named contact" />
        </Tooltip>
      )}
      {email && (
        <Tooltip label="has an email">
          <Mail size={15} strokeWidth={1.75} aria-label="email" />
        </Tooltip>
      )}
      {card.phone && (
        <Tooltip label={card.phone}>
          <Phone size={15} strokeWidth={1.75} aria-label="phone" />
        </Tooltip>
      )}
    </Group>
  );
}

/**
 * The full-width list of Today and Leads: one row per company with its segment, the one main
 * reason to write, score and reach, quick actions on hover. A click or Enter opens the company
 * page; back returns here with the scroll and the opened row in place.
 *
 * J and K move a cursor, the quick action keys act on the row under it, so a slice can be worked
 * without the mouse.
 */
export function LeadList({
  cards,
  loading,
  onAct,
  empty,
}: {
  cards: (ListCard & { done?: boolean })[];
  loading: boolean;
  onAct: (card: ListCard, body: CardAction) => void;
  empty: React.ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const keys = useMemo(() => cards.map(companyKey), [cards]);
  const { opened } = useListMemory(scroller, cards.length > 0);

  const [cursor, setCursor] = useState(() => Math.max(0, opened ? keys.indexOf(opened) : 0));
  const current = cards[Math.min(cursor, cards.length - 1)];

  // The row under the cursor stays on screen and takes focus, so Tab and Enter agree with J and K.
  useEffect(() => {
    if (!current) return;
    const row = scroller.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(companyKey(current))}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [current]);

  const open = (card: ListCard) => openCompany(companyKey(card), keys, scroller.current);
  const prefetch = usePrefetchCompany();
  useEffect(() => {
    if (current) prefetch(companyKey(current));
  }, [current, prefetch]);
  const move = (delta: number) => setCursor((value) => Math.min(Math.max(value + delta, 0), cards.length - 1));

  useHotkeys(
    useMemo(
      () => ({
        j: () => move(1),
        arrowdown: () => move(1),
        k: () => move(-1),
        arrowup: () => move(-1),
        enter: () => current && open(current),
        ...Object.fromEntries(QUICK.map((item) => [item.key, () => current && onAct(current, item.body)])),
      }),
      [current, cards, onAct],
    ),
    cards.length > 0,
  );

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-auto">
      {loading && (
        <Text size="sm" c="dimmed" px="lg" py="md">
          loading
        </Text>
      )}
      {!loading && cards.length === 0 && empty}

      {cards.map((card, position) => {
        const key = companyKey(card);
        const [main, ...more] = reasons(card);
        return (
          <Box
            key={card.companyId}
            data-key={key}
            data-active={position === cursor}
            data-returned={key === opened}
            className="list-row"
            tabIndex={0}
            role="link"
            aria-label={`open ${card.name}`}
            onClick={() => open(card)}
            onFocus={() => setCursor(position)}
            onMouseEnter={() => prefetch(key)}
            px="lg"
            py={10}
            style={{ cursor: 'pointer', outline: 'none', opacity: card.done ? 0.45 : undefined }}
          >
            <Group gap="md" wrap="nowrap">
              <Score value={card.score} size="md" />

              {/* What they are and what they do: the first question about any row. */}
              <Box style={{ minWidth: 0, flex: '1 1 360px' }}>
                <Group gap={8} wrap="nowrap">
                  <Text fw={600} size="sm" truncate style={{ flexShrink: 0, maxWidth: '55%' }}>
                    {card.name}
                  </Text>
                  <Text size="xs" c="dimmed" truncate>
                    {[card.domain || 'no site', [card.city, card.country].filter(Boolean).join(', ')]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </Group>
                <Text size="xs" c={card.description ? 'gray.7' : 'gray.5'} truncate>
                  {card.description ?? (card.industry ? `industry: ${card.industry}` : 'no description yet')}
                </Text>
              </Box>

              <Group gap={6} wrap="nowrap" w={250} style={{ flexShrink: 0 }}>
                <SegmentBadge kind={card.kind} />
                <FitBadge fit={card.fit} service={card.fitService} />
              </Group>

              <Group gap={6} wrap="nowrap" w={280} style={{ flexShrink: 0, minWidth: 0 }}>
                {main && <ReasonChip reason={main} maw={240} />}
                {more.length > 0 && (
                  <Tooltip label={more.map((item) => item.label).join(', ')} multiline maw={360}>
                    <Text size="xs" c="dimmed" className="mono" style={{ whiteSpace: 'nowrap' }}>
                      +{more.length}
                    </Text>
                  </Tooltip>
                )}
              </Group>

              <Reach card={card} />

              <Group gap={2} wrap="nowrap" className="row-actions" onClick={(event) => event.stopPropagation()}>
                {QUICK.map((item) => (
                  <Tooltip
                    key={item.key}
                    label={
                      <Group gap={6} wrap="nowrap">
                        {item.label}
                        <Kbd>{item.key}</Kbd>
                      </Group>
                    }
                  >
                    <ActionIcon
                      color={item.color ?? 'gray'}
                      aria-label={item.label}
                      onClick={() => onAct(card, item.body)}
                      disabled={card.done}
                    >
                      <item.icon size={16} strokeWidth={1.75} />
                    </ActionIcon>
                  </Tooltip>
                ))}
              </Group>
            </Group>
          </Box>
        );
      })}
    </div>
  );
}
