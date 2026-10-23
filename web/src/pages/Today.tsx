import { useQuery } from '@tanstack/react-query';
import { Alert, Anchor, Box, EmptyState, Group, Kbd, Text } from '@mantine/core';
import { Sun } from 'lucide-react';
import { api } from '../lib/api';
import { href } from '../lib/route';
import { LeadList, useCardAction } from '../components/LeadList';
import { PageHeader, StatStrip } from '../components/ui';

/**
 * Today: the stat strip and the fixed daily slice as full-width rows, nothing else on the screen.
 * The slice does not reshuffle under the owner's hands: an acted-on card stays in place, dimmed,
 * and unreviewed cards roll over to the next day (section 11 of CLAUDE.md).
 */
export function TodayPage() {
  const queue = useQuery({ queryKey: ['queue'], queryFn: api.queue });
  const { data: stats } = useQuery({ queryKey: ['stats'], queryFn: () => api.stats(), retry: false });
  const { data: waiting } = useQuery({ queryKey: ['followups'], queryFn: () => api.outreach(7) });
  const act = useCardAction();

  const cards = queue.data?.cards ?? [];
  const done = cards.filter((card) => card.done).length;

  return (
    <>
      <PageHeader
        icon={Sun}
        title="Today"
        description={
          queue.data
            ? `${new Date(`${queue.data.day}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}` +
              (queue.data.carried > 0 ? `, ${queue.data.carried} carried over from earlier days` : '')
            : 'loading the slice'
        }
      >
        <Text size="xs" c="dimmed">
          <Kbd>j</Kbd> <Kbd>k</Kbd> move, <Kbd>enter</Kbd> open, <Kbd>i</Kbd> <Kbd>n</Kbd> <Kbd>s</Kbd> <Kbd>b</Kbd> act
        </Text>
      </PageHeader>

      <Box px="lg" py="md" style={{ borderBottom: '1px solid var(--mantine-color-gray-2)' }}>
        <StatStrip
          items={[
            { label: 'in the slice', value: cards.length, hint: `the slice size is set on the Rules page (queue.size)` },
            { label: 'done', value: `${done}/${cards.length}`, color: done > 0 && done === cards.length ? 'green.7' : undefined },
            { label: 'could be in a slice', value: queue.data?.eligible ?? '-', hint: 'above the threshold, with an email or a phone, not contacted recently' },
            { label: 'replied', value: stats?.funnel.replied ?? '-' },
            {
              label: 'no reply 7+ days',
              value: waiting?.length ?? '-',
              color: waiting && waiting.length > 0 ? 'yellow.8' : undefined,
              hint: 'letters waiting for a follow-up, on the Outreach page',
            },
          ]}
        />
      </Box>

      {queue.error ? (
        <Alert color="red" m="lg" title="Could not read today's slice">
          {queue.error instanceof Error ? queue.error.message : String(queue.error)}
        </Alert>
      ) : (
        <LeadList
          cards={cards}
          loading={queue.isLoading}
          onAct={act}
          empty={
            <EmptyState
              py="xl"
              icon={<Sun size={24} />}
              withIndicatorBackground
              title="Nothing in today's slice"
              description={
                <Group gap={4} justify="center">
                  A company gets here above the score threshold and with an email or a phone.
                  <Anchor href={href('studios')} size="sm">
                    Open all leads
                  </Anchor>
                </Group>
              }
            />
          }
        />
      )}
    </>
  );
}
