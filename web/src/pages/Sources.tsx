import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Badge, Button, Group, Paper, Stack, Table, Text, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Briefcase, Building2, Database, Landmark, Play, TriangleAlert, type LucideIcon } from 'lucide-react';
import { api, type SourceRow } from '../lib/api';
import { PageHeader, StatStrip } from '../components/ui';

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

/** What a source feeds: companies from a catalog, demand, or only the hiring signal. */
const KINDS: Record<string, { label: string; icon: LucideIcon }> = {
  catalog: { label: 'catalog', icon: Building2 },
  lead: { label: 'demand', icon: Landmark },
  board: { label: 'hiring signal', icon: Briefcase },
};

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

  const header = (
    <PageHeader
      icon={Database}
      title="Sources"
      description="Adapter health and manual runs. An empty result after a non-empty history is flagged: scrapers break quietly and look like they work."
    />
  );

  if (error || isLoading || !data) {
    return (
      <>
        {header}
        {error ? (
          <Alert color="red" m="lg" title="Could not read source status">
            {error instanceof Error ? error.message : String(error)}
          </Alert>
        ) : (
          <Text size="sm" c="dimmed" p="lg">
            loading
          </Text>
        )}
      </>
    );
  }

  const broken = data.filter((row) => row.lastRun?.status === 'warn' || row.lastRun?.status === 'error');
  const never = data.filter((row) => !row.lastRun);

  return (
    <>
      {header}
      <Stack gap="md" p="lg">
        <StatStrip
          items={[
            { label: 'adapters', value: data.length },
            { label: 'working', value: data.length - broken.length - never.length, color: 'green.7' },
            { label: 'need attention', value: broken.length, color: broken.length ? 'red.7' : undefined },
            { label: 'never run', value: never.length, color: never.length ? 'gray.6' : undefined },
          ]}
        />

        <Paper style={{ overflow: 'hidden' }}>
          <Table layout="fixed">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>source</Table.Th>
                <Table.Th w={150}>feeds</Table.Th>
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
                      <Text fw={600} size="sm" className="mono">
                        {row.id}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <KindLabel kind={row.kind} />
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" className="mono" c="gray.7">
                        {when(row.lastRun?.startedAt)}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Badge variant="dot" color={statusColor(row.lastRun)} maw="100%">
                        {statusLabel(row.lastRun)}
                      </Badge>
                    </Table.Td>
                    <Table.Td ta="right">
                      <Text size="sm" className="mono">
                        {row.lastRun?.itemsFound ?? ''}
                      </Text>
                    </Table.Td>
                    <Table.Td ta="right">
                      <Text size="sm" className="mono" c={row.lastRun?.itemsNew ? 'green.7' : undefined}>
                        {row.lastRun?.itemsNew ?? ''}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {row.lastRun?.errors.length ? (
                        <Tooltip label={row.lastRun.errors.map(shorten).join('; ')} multiline w={420}>
                          <Badge color="red" leftSection={<TriangleAlert size={11} />}>
                            {row.lastRun.errors.length}, hover to read
                          </Badge>
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
    </>
  );
}

function KindLabel({ kind }: { kind: string }) {
  const known = KINDS[kind];
  const Icon = known?.icon ?? Database;
  return (
    <Group gap={6} wrap="nowrap" c="gray.7">
      <Icon size={14} strokeWidth={1.75} />
      <Text size="sm">{known?.label ?? kind}</Text>
    </Group>
  );
}
