import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Box,
  Card,
  EmptyState,
  Group,
  Paper,
  ScrollArea,
  Skeleton,
  Stack,
  Table,
  Tabs,
  Text,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Check, CircleSlash, Mailbox, Send } from 'lucide-react';
import { api, formatDate, type OutreachRow } from '../lib/api';
import { companyHref } from '../lib/route';
import { useSelection } from '../lib/useRoute';

const REPLY_LABELS: Record<string, string> = {
  positive: 'positive',
  rejection: 'rejection',
  auto: 'auto-reply',
};

const REPLY_ACTIONS = [
  { type: 'positive', label: 'Positive reply', icon: Check, color: 'green' },
  { type: 'rejection', label: 'Rejection', icon: CircleSlash, color: 'red' },
  { type: 'auto', label: 'Auto-reply, nothing to read', icon: Mailbox, color: 'gray' },
] as const;

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <Box>
      <Text size="xs" tt="uppercase" fw={500} c="dimmed" style={{ letterSpacing: '0.04em' }}>
        {label}
      </Text>
      <Text size="xl" fw={600} c={color} className="tabular">
        {value}
      </Text>
    </Box>
  );
}

export function OutreachPage() {
  const client = useQueryClient();
  /*
   * The tab lives in the address too: `#/outreach/attention` links to what needs
   * attention, and it can be kept for tomorrow or dropped into a reminder.
   */
  const [chosen, setChosen] = useSelection('outreach');
  const tab = chosen ?? 'waiting';
  const setTab = (value: string | null) => setChosen(value === 'waiting' ? null : value);
  // Clicking a row shows the letter text: without it the history is dates with no content.
  const [expanded, setExpanded] = useState<number | null>(null);
  const { data, error, isLoading } = useQuery({ queryKey: ['outreach'], queryFn: () => api.outreach() });

  const reply = useMutation({
    mutationFn: ({ id, type }: { id: number; type: string; company: string }) => api.reply(id, type),
    onSuccess: (_result, { type, company }) => {
      notifications.show({
        color: 'green',
        title: company,
        message: `reply: ${REPLY_LABELS[type] ?? type}`,
      });
      for (const key of ['outreach', 'followups', 'stats', 'companies']) {
        void client.invalidateQueries({ queryKey: [key] });
      }
    },
    onError: (mutationError) =>
      notifications.show({ color: 'red', title: 'not saved', message: String(mutationError) }),
  });

  if (error) {
    return (
      <Box p="lg">
        <Alert color="red" title="Could not read the correspondence">
          {error instanceof Error ? error.message : String(error)}
        </Alert>
      </Box>
    );
  }

  if (isLoading || !data) {
    return (
      <Box p="lg">
        <Skeleton h={420} />
      </Box>
    );
  }

  if (data.length === 0) {
    return (
      <Box p="lg">
        <Card>
          <EmptyState
            icon={<Send size={28} />}
            withIndicatorBackground
            title="No letters yet"
            description="Work through the queue and mark sent letters with the Contacted button."
          />
        </Card>
      </Box>
    );
  }

  const waiting = data.filter((row) => !row.replyType);
  const answered = data.filter((row) => row.replyType);
  const overdue = waiting.filter((row) => (row.waitingDays ?? 0) >= 7);

  // Three tabs instead of one long table: day to day only the silent ones matter.
  const rows = tab === 'answered' ? answered : tab === 'all' ? data : waiting;

  return (
    <Stack gap="md" p="lg">
      <Paper p="lg">
        <Group gap="xl">
          <Stat label="letters total" value={data.length} />
          <Stat label="awaiting reply" value={waiting.length} />
          <Stat label="silent over 7 days" value={overdue.length} color={overdue.length ? 'yellow.8' : undefined} />
          <Stat label="replied" value={answered.length} />
          <Text size="sm" c="dimmed" maw={320} ml="auto">
            Highlighted rows: seven days without a reply. That is the moment for one follow-up, not a second letter.
          </Text>
        </Group>
      </Paper>

      <Tabs value={tab} onChange={setTab}>
        <Tabs.List>
          <Tabs.Tab value="waiting" rightSection={<Badge size="sm" color="yellow">{waiting.length}</Badge>}>
            Waiting
          </Tabs.Tab>
          <Tabs.Tab value="answered" rightSection={<Badge size="sm" color="gray">{answered.length}</Badge>}>
            Replied
          </Tabs.Tab>
          <Tabs.Tab value="all">All</Tabs.Tab>
        </Tabs.List>
      </Tabs>

      <Paper style={{ overflow: 'hidden' }}>
        <ScrollArea.Autosize mah="calc(100dvh - 340px)">
          <Table stickyHeader layout="fixed">
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={90}>when</Table.Th>
                <Table.Th w={200}>company</Table.Th>
                <Table.Th w={170}>to</Table.Th>
                <Table.Th>vacancy</Table.Th>
                <Table.Th w={100}>channel</Table.Th>
                <Table.Th w={150}>template</Table.Th>
                <Table.Th w={90}>intro</Table.Th>
                <Table.Th w={160}>reply</Table.Th>
                <Table.Th w={130} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((row: OutreachRow) => {
                const late = !row.replyType && (row.waitingDays ?? 0) >= 7;
                const open = expanded === row.id;
                return (
                  <Fragment key={row.id}>
                  <Table.Tr
                    bg={late ? 'yellow.0' : undefined}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setExpanded(open ? null : row.id)}
                  >
                    <Table.Td>
                      <Text size="sm" className="tabular">
                        {formatDate(row.sentAt)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {/*
                        The name leads to the company card in the app.
                        A reply comes a week after the letter, and the first
                        question is always the same: which company was that.
                        A click on the name must not expand the row, so the event
                        stops here: following a link and expanding are different intents.
                      */}
                      <Anchor
                        href={companyHref(row.domain)}
                        size="sm"
                        fw={500}
                        truncate
                        onClick={(event) => event.stopPropagation()}
                      >
                        {row.company}
                      </Anchor>
                    </Table.Td>
                    <Table.Td>
                      {row.contactName ? (
                        <Text size="sm" truncate title={row.contactEmail ?? undefined}>
                          {row.contactName}
                        </Text>
                      ) : (
                        <Text size="sm" c="dimmed">
                          {row.contactEmail ?? 'not set'}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      {row.vacancyUrl ? (
                        <Anchor href={row.vacancyUrl} target="_blank" rel="noreferrer" size="sm" truncate>
                          {row.vacancyTitle ?? row.vacancyUrl}
                        </Anchor>
                      ) : (
                        <Text size="sm" c="dimmed">
                          no vacancy
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {row.channel}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {row.templateUsed ? (
                        <Badge color="gray">{row.templateUsed}</Badge>
                      ) : (
                        <Text size="sm" c="dimmed">
                          -
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4} wrap="nowrap">
                        <Badge size="sm" variant="light" color={row.aiUsed ? 'violet' : 'gray'}>
                          {row.aiUsed ? 'AI' : 'template'}
                        </Badge>
                        {row.language && (
                          <Text size="xs" c="dimmed">
                            {row.language}
                          </Text>
                        )}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      {row.bounceType ? (
                        <Badge color={row.bounceType === 'hard' ? 'red' : 'orange'}>
                          bounce, {row.bounceType}
                        </Badge>
                      ) : row.replyType ? (
                        <Badge
                          color={
                            row.replyType === 'positive' ? 'green' : row.replyType === 'rejection' ? 'red' : 'gray'
                          }
                        >
                          {REPLY_LABELS[row.replyType] ?? row.replyType}
                        </Badge>
                      ) : (
                        <Badge color={late ? 'yellow' : 'gray'} variant={late ? 'filled' : 'light'}>
                          waiting {row.waitingDays}d
                        </Badge>
                      )}
                    </Table.Td>
                    <Table.Td onClick={(event) => event.stopPropagation()}>
                      {!row.replyType && (
                        <Group gap={4} justify="flex-end" wrap="nowrap">
                          {REPLY_ACTIONS.map((action) => (
                            <Tooltip key={action.type} label={action.label}>
                              <ActionIcon
                                color={action.color}
                                variant="light"
                                size="md"
                                aria-label={action.label}
                                onClick={() => reply.mutate({ id: row.id, type: action.type, company: row.company })}
                              >
                                <action.icon size={15} />
                              </ActionIcon>
                            </Tooltip>
                          ))}
                        </Group>
                      )}
                    </Table.Td>
                  </Table.Tr>
                  {open && (
                    <Table.Tr>
                      <Table.Td colSpan={9}>
                        {/* What actually went out. A snapshot, not a rebuild from the template. */}
                        <Text size="xs" c="dimmed" mb={4}>
                          {row.isFollowup ? 'follow-up, same thread' : 'first letter'}
                          {row.subject ? `: ${row.subject}` : ''}
                        </Text>
                        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                          {row.body ?? 'no text saved, the letter was marked by hand'}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  )}
                  </Fragment>
                );
              })}
            </Table.Tbody>
          </Table>
        </ScrollArea.Autosize>

        {rows.length === 0 && (
          <Text c="dimmed" size="sm" p="lg" ta="center">
            nothing in this tab
          </Text>
        )}
      </Paper>
    </Stack>
  );
}
