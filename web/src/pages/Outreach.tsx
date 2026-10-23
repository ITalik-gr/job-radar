import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  EmptyState,
  Group,
  Paper,
  SegmentedControl,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  Check,
  CircleSlash,
  Clock,
  FileText,
  Mail,
  Mailbox,
  Mails,
  MessageSquare,
  Send,
  TriangleAlert,
} from 'lucide-react';
import { PageHeader, StatStrip } from '../components/ui';
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

export function OutreachPage() {
  const client = useQueryClient();
  /*
   * The tab lives in the address too: `#/outreach/attention` links to what needs
   * attention, and it can be kept for tomorrow or dropped into a reminder.
   */
  const [chosen, setChosen] = useSelection('outreach');
  const tab = chosen ?? 'waiting';
  const setTab = (value: string) => setChosen(value === 'waiting' ? null : value);
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

  const waiting = (data ?? []).filter((row) => !row.replyType);
  const answered = (data ?? []).filter((row) => row.replyType);
  const overdue = waiting.filter((row) => (row.waitingDays ?? 0) >= 7);
  const positive = answered.filter((row) => row.replyType === 'positive');

  // Three tabs instead of one long table: day to day only the silent ones matter.
  const rows = tab === 'answered' ? answered : tab === 'all' ? (data ?? []) : waiting;

  const header = (
    <PageHeader
      icon={Mails}
      title="Outreach"
      description="Who was written to and who replied. Seven silent days is the moment for one follow-up, not a second letter."
    />
  );

  if (error) {
    return (
      <>
        {header}
        <Alert color="red" m="lg" title="Could not read the correspondence">
          {error instanceof Error ? error.message : String(error)}
        </Alert>
      </>
    );
  }

  if (isLoading || !data) {
    return (
      <>
        {header}
        <Text size="sm" c="dimmed" p="lg">
          loading
        </Text>
      </>
    );
  }

  if (data.length === 0) {
    return (
      <>
        {header}
        <Paper m="lg">
          <EmptyState
            py="xl"
            icon={<Send size={24} />}
            withIndicatorBackground
            title="No letters yet"
            description="Work through the leads and send letters from the Outbox, or mark them with the Contacted button."
          />
        </Paper>
      </>
    );
  }

  return (
    <>
      {header}
      <Stack gap="md" p="lg">
        <StatStrip
          items={[
            { label: 'letters total', value: data.length },
            { label: 'awaiting reply', value: waiting.length },
            {
              label: 'silent 7+ days',
              value: overdue.length,
              color: overdue.length ? 'yellow.8' : undefined,
              hint: 'highlighted rows: time for one follow-up',
            },
            { label: 'replied', value: answered.length },
            { label: 'positive', value: positive.length, color: positive.length ? 'green.7' : undefined },
          ]}
        />

        <SegmentedControl
          size="sm"
          w="fit-content"
          value={tab}
          onChange={setTab}
          data={[
            { value: 'waiting', label: `Waiting ${waiting.length}` },
            { value: 'answered', label: `Replied ${answered.length}` },
            { value: 'all', label: `All ${data.length}` },
          ]}
        />

        <Paper style={{ overflow: 'hidden' }}>
          <>
            <Table stickyHeader layout="fixed">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={90}>when</Table.Th>
                  <Table.Th w={200}>company</Table.Th>
                  <Table.Th w={170}>to</Table.Th>
                  <Table.Th>subject</Table.Th>
                  <Table.Th w={100}>channel</Table.Th>
                  <Table.Th w={150}>template</Table.Th>
                  <Table.Th w={90}>language</Table.Th>
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
                        <Text size="xs" className="mono" c="gray.7">
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
                        <Text size="sm" truncate c={row.subject ? undefined : 'dimmed'}>
                          {row.subject ?? 'no subject recorded'}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Group gap={4} wrap="nowrap" c="gray.6">
                          {row.channel === 'email' ? <Mail size={13} /> : <MessageSquare size={13} />}
                          <Text size="xs">{row.channel}</Text>
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        {row.templateUsed ? (
                          <Badge color="gray" leftSection={<FileText size={11} />} maw="100%">
                            {row.templateUsed}
                          </Badge>
                        ) : (
                          <Text size="sm" c="dimmed">
                            -
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" c="dimmed" className="mono">
                          {row.language ?? '-'}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        {row.bounceType ? (
                          <Badge color={row.bounceType === 'hard' ? 'red' : 'orange'} leftSection={<TriangleAlert size={11} />}>
                            bounce, {row.bounceType}
                          </Badge>
                        ) : row.replyType ? (
                          <Badge
                            variant="dot"
                            color={
                              row.replyType === 'positive' ? 'green' : row.replyType === 'rejection' ? 'red' : 'gray'
                            }
                          >
                            {REPLY_LABELS[row.replyType] ?? row.replyType}
                          </Badge>
                        ) : (
                          <Badge color={late ? 'yellow' : 'gray'} leftSection={<Clock size={11} />} className="tabular">
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
                      <Table.Tr bg="gray.0">
                        <Table.Td colSpan={9} py="md">
                          {/* What actually went out. A snapshot, not a rebuild from the template. */}
                          <Text size="xs" c="dimmed" mb={6} className="mono">
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
          </>

          {rows.length === 0 && (
            <Text c="dimmed" size="sm" p="lg" ta="center">
              nothing in this tab
            </Text>
          )}
        </Paper>
      </Stack>
    </>
  );
}
