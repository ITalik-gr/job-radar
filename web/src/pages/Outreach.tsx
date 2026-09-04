import { useState } from 'react';
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

const REPLY_LABELS: Record<string, string> = {
  positive: 'позитивна',
  rejection: 'відмова',
  auto: 'автовідповідь',
};

const REPLY_ACTIONS = [
  { type: 'positive', label: 'Позитивна відповідь', icon: Check, color: 'green' },
  { type: 'rejection', label: 'Відмова', icon: CircleSlash, color: 'red' },
  { type: 'auto', label: 'Автовідповідь, читати нічого', icon: Mailbox, color: 'gray' },
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
  const [tab, setTab] = useState<string | null>('waiting');
  const { data, error, isLoading } = useQuery({ queryKey: ['outreach'], queryFn: () => api.outreach() });

  const reply = useMutation({
    mutationFn: ({ id, type }: { id: number; type: string; company: string }) => api.reply(id, type),
    onSuccess: (_result, { type, company }) => {
      notifications.show({
        color: 'green',
        title: company,
        message: `відповідь: ${REPLY_LABELS[type] ?? type}`,
      });
      for (const key of ['outreach', 'followups', 'stats', 'companies']) {
        void client.invalidateQueries({ queryKey: [key] });
      }
    },
    onError: (mutationError) =>
      notifications.show({ color: 'red', title: 'не збереглось', message: String(mutationError) }),
  });

  if (error) {
    return (
      <Box p="lg">
        <Alert color="red" title="Не вдалось прочитати листування">
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
            title="Ще нікому не писали"
            description="Розберись із чергою і познач надіслані листи кнопкою Написав."
          />
        </Card>
      </Box>
    );
  }

  const waiting = data.filter((row) => !row.replyType);
  const answered = data.filter((row) => row.replyType);
  const overdue = waiting.filter((row) => (row.waitingDays ?? 0) >= 7);

  // Три вкладки замість однієї довгої таблиці: у роботі потрібні тільки ті, хто молчить.
  const rows = tab === 'answered' ? answered : tab === 'all' ? data : waiting;

  return (
    <Stack gap="md" p="lg">
      <Paper p="lg">
        <Group gap="xl">
          <Stat label="усього листів" value={data.length} />
          <Stat label="чекають відповіді" value={waiting.length} />
          <Stat label="понад 7 днів тишi" value={overdue.length} color={overdue.length ? 'yellow.8' : undefined} />
          <Stat label="відповіли" value={answered.length} />
          <Text size="sm" c="dimmed" maw={320} ml="auto">
            Підсвічені рядки: сім днів без відповіді. Це момент для одного фолоу-апу, не для другого листа.
          </Text>
        </Group>
      </Paper>

      <Tabs value={tab} onChange={setTab}>
        <Tabs.List>
          <Tabs.Tab value="waiting" rightSection={<Badge size="sm" color="yellow">{waiting.length}</Badge>}>
            Чекають
          </Tabs.Tab>
          <Tabs.Tab value="answered" rightSection={<Badge size="sm" color="gray">{answered.length}</Badge>}>
            Відповіли
          </Tabs.Tab>
          <Tabs.Tab value="all">Усі</Tabs.Tab>
        </Tabs.List>
      </Tabs>

      <Paper style={{ overflow: 'hidden' }}>
        <ScrollArea.Autosize mah="calc(100dvh - 340px)">
          <Table stickyHeader layout="fixed">
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={90}>коли</Table.Th>
                <Table.Th w={200}>компанія</Table.Th>
                <Table.Th w={170}>кому</Table.Th>
                <Table.Th>вакансія</Table.Th>
                <Table.Th w={100}>канал</Table.Th>
                <Table.Th w={150}>шаблон</Table.Th>
                <Table.Th w={160}>відповідь</Table.Th>
                <Table.Th w={130} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((row: OutreachRow) => {
                const late = !row.replyType && (row.waitingDays ?? 0) >= 7;
                return (
                  <Table.Tr key={row.id} bg={late ? 'yellow.0' : undefined}>
                    <Table.Td>
                      <Text size="sm" className="tabular">
                        {formatDate(row.sentAt)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" fw={500} truncate>
                        {row.company}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {row.contactName ? (
                        <Text size="sm" truncate title={row.contactEmail ?? undefined}>
                          {row.contactName}
                        </Text>
                      ) : (
                        <Text size="sm" c="dimmed">
                          {row.contactEmail ?? 'не вказано'}
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
                          без вакансії
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
                      {row.replyType ? (
                        <Badge
                          color={
                            row.replyType === 'positive' ? 'green' : row.replyType === 'rejection' ? 'red' : 'gray'
                          }
                        >
                          {REPLY_LABELS[row.replyType] ?? row.replyType}
                        </Badge>
                      ) : (
                        <Badge color={late ? 'yellow' : 'gray'} variant={late ? 'filled' : 'light'}>
                          чекаємо {row.waitingDays} дн
                        </Badge>
                      )}
                    </Table.Td>
                    <Table.Td>
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
                );
              })}
            </Table.Tbody>
          </Table>
        </ScrollArea.Autosize>

        {rows.length === 0 && (
          <Text c="dimmed" size="sm" p="lg" ta="center">
            у цій вкладці порожньо
          </Text>
        )}
      </Paper>
    </Stack>
  );
}
