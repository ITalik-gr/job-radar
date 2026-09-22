import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Badge,
  Box,
  Button,
  Group,
  Paper,
  Skeleton,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Play } from 'lucide-react';
import { Dot } from '../components/statuses';
import { api, type SourceRow } from '../lib/api';

function when(ms: number | undefined): string {
  if (!ms) return 'never';
  const hours = Math.floor((Date.now() - ms) / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/*
 * The `warn` status in the database means two different things: the adapter returned
 * zero where it used to return more, or the run finished but with errors on individual
 * companies. One label for both lied: greenhouse with 1633 vacancies found and three
 * failed boards showed up as "empty result".
 */
function statusLabel(run: SourceRow['lastRun']): string {
  if (!run) return 'never run';
  if (run.status === 'running') return 'running';
  if (run.status === 'error') return 'error';
  if (run.status === 'warn') {
    if (run.itemsFound === 0) return 'empty result';
    const count = run.errors.length;
    return count > 0 ? `partial, ${count} errors` : 'working';
  }
  return 'working';
}

function statusColor(run: SourceRow['lastRun']): string {
  if (!run) return 'gray';
  if (run.status === 'error') return 'red';
  if (run.status === 'running') return 'blue';
  return run.status === 'warn' ? 'yellow' : 'green';
}

/**
 * An error from the database driver drags along the whole query, with a list of hundreds
 * of question marks and every parameter. In a tooltip that is a wall hiding the error
 * itself, so long lists are collapsed and the parameter tail is cut off.
 */
function shorten(message: string): string {
  return message
    .replace(/\(\s*\?(?:\s*,\s*\?)+\s*\)/g, '(... many values)')
    .replace(/\s*params:.*$/s, '')
    .trim()
    .slice(0, 300);
}

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
      notifications.show({ color: 'green', title: id, message: `found ${result.itemsFound}` });
      void client.invalidateQueries({ queryKey: ['sources'] });
    },
    onError: (mutationError, id) =>
      notifications.show({ color: 'red', title: id, message: String(mutationError) }),
  });

  if (error) {
    return (
      <Box p="lg">
        <Alert color="red" title="Could not read source status">
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
          <Stat label="adapters" value={data.length} />
          <Stat label="need attention" value={broken.length} color={broken.length ? 'red.8' : undefined} />
          <Text size="sm" c="dimmed" maw={360} ml="auto">
            An empty result after a non-empty history is flagged as an error: scrapers break quietly
            and look like they work.
          </Text>
        </Group>
      </Paper>

      <Paper style={{ overflow: 'hidden' }}>
        <Table layout="fixed">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>source</Table.Th>
              <Table.Th w={110}>kind</Table.Th>
              <Table.Th w={150}>last run</Table.Th>
              <Table.Th w={190}>status</Table.Th>
              <Table.Th w={110} ta="right">
                found
              </Table.Th>
              <Table.Th w={100} ta="right">
                new
              </Table.Th>
              <Table.Th>errors</Table.Th>
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
                    <Group gap={8} wrap="nowrap">
                      <Dot color={statusColor(row.lastRun)} />
                      <Text size="sm" truncate>
                        {statusLabel(row.lastRun)}
                      </Text>
                    </Group>
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
                      <Tooltip label={row.lastRun.errors.map(shorten).join('; ')} multiline w={420}>
                        <Badge color="red">{row.lastRun.errors.length}, hover to read</Badge>
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
                        title={row.requiresSlug ? 'works only for companies with a saved slug' : undefined}
                      >
                        Run
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
