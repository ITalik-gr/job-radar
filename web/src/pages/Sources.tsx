import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Badge,
  Box,
  Button,
  Group,
  Indicator,
  Paper,
  Skeleton,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Play } from 'lucide-react';
import { api, type SourceRow } from '../lib/api';

function when(ms: number | undefined): string {
  if (!ms) return 'ніколи';
  const hours = Math.floor((Date.now() - ms) / 3_600_000);
  if (hours < 1) return 'щойно';
  if (hours < 24) return `${hours} год тому`;
  return `${Math.floor(hours / 24)} дн тому`;
}

const STATUS_LABELS: Record<string, string> = {
  ok: 'працює',
  warn: 'порожній результат',
  error: 'помилка',
};

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

export function SourcesPage() {
  const client = useQueryClient();
  const { data, error, isLoading } = useQuery({ queryKey: ['sources'], queryFn: () => api.sources() });

  const run = useMutation({
    mutationFn: (id: string) => api.runSource(id),
    onSuccess: (result, id) => {
      notifications.show({ color: 'green', title: id, message: `знайдено ${result.itemsFound}` });
      void client.invalidateQueries({ queryKey: ['sources'] });
    },
    onError: (mutationError, id) =>
      notifications.show({ color: 'red', title: id, message: String(mutationError) }),
  });

  if (error) {
    return (
      <Box p="lg">
        <Alert color="red" title="Не вдалось прочитати стан джерел">
          {error instanceof Error ? error.message : String(error)}
        </Alert>
      </Box>
    );
  }

  if (isLoading || !data) {
    return (
      <Box p="lg">
        <Skeleton h={360} />
      </Box>
    );
  }

  const broken = data.filter((row) => row.lastRun?.status === 'warn' || row.lastRun?.status === 'error');

  return (
    <Stack gap="md" p="lg">
      <Paper p="lg">
        <Group gap="xl">
          <Stat label="адаптерів" value={data.length} />
          <Stat label="потребують уваги" value={broken.length} color={broken.length ? 'red.8' : undefined} />
          <Text size="sm" c="dimmed" maw={360} ml="auto">
            Порожній результат при непорожній історії підсвічується як помилка: скрейпери ламаються тихо
            і виглядають робочими.
          </Text>
        </Group>
      </Paper>

      <Paper style={{ overflow: 'hidden' }}>
        <Table layout="fixed">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>джерело</Table.Th>
              <Table.Th w={110}>тип</Table.Th>
              <Table.Th w={150}>останній запуск</Table.Th>
              <Table.Th w={190}>стан</Table.Th>
              <Table.Th w={110} ta="right">
                знайдено
              </Table.Th>
              <Table.Th w={100} ta="right">
                нових
              </Table.Th>
              <Table.Th>помилки</Table.Th>
              <Table.Th w={140} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.map((row: SourceRow) => {
              const status = row.lastRun?.status;
              const bad = status === 'warn' || status === 'error';
              const busy = run.isPending && run.variables === row.id;

              return (
                <Table.Tr key={row.id} bg={bad ? 'red.0' : undefined}>
                  <Table.Td>
                    <Text fw={500}>{row.id}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {row.kind}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{when(row.lastRun?.startedAt)}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Indicator
                      color={status === 'error' ? 'red' : status === 'warn' ? 'yellow' : row.lastRun ? 'green' : 'gray'}
                      size={7}
                      position="middle-start"
                      offset={-2}
                    >
                      <Text size="sm" pl="sm">
                        {row.lastRun ? (STATUS_LABELS[status ?? 'ok'] ?? status) : 'не запускався'}
                      </Text>
                    </Indicator>
                  </Table.Td>
                  <Table.Td ta="right">
                    <Text size="sm" className="tabular">
                      {row.lastRun?.itemsFound ?? ''}
                    </Text>
                  </Table.Td>
                  <Table.Td ta="right">
                    <Text size="sm" className="tabular">
                      {row.lastRun?.itemsNew ?? ''}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    {row.lastRun?.errors.length ? (
                      <Tooltip label={row.lastRun.errors.join('; ')} multiline w={320}>
                        <Badge color="red">{row.lastRun.errors.length} шт, навести щоб прочитати</Badge>
                      </Tooltip>
                    ) : (
                      <Text size="sm" c="dimmed">
                        -
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Group justify="flex-end">
                      <Button
                        variant="default"
                        loading={busy}
                        disabled={run.isPending && !busy}
                        leftSection={<Play size={14} />}
                        onClick={() => run.mutate(row.id)}
                        title={row.requiresSlug ? 'працює лише для компаній зі збереженим slug' : undefined}
                      >
                        Запустити
                      </Button>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Paper>
    </Stack>
  );
}
