import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Card,
  Checkbox,
  EmptyState,
  Group,
  Paper,
  SegmentedControl,
  Select,
  Skeleton,
  Stack,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { ExternalLink, Gavel } from 'lucide-react';
import { api, formatDate, type LeadRow } from '../lib/api';
import { href } from '../lib/route';

const LEAD_STATUSES = [
  { value: 'new', label: 'new' },
  { value: 'interesting', label: 'interesting' },
  { value: 'contacted', label: 'contacted' },
  { value: 'skipped', label: 'skipped' },
];

const SOURCE_LABELS: Record<string, string> = { prozorro: 'Prozorro', ain: 'AIN.ua', devua: 'dev.ua' };

const money = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 });

/** "in 3 days", "today", "closed": the deadline is what decides whether a tender is worth an evening. */
function DaysLeft({ deadline }: { deadline: number | null }) {
  if (!deadline) return <Text size="sm" c="dimmed">-</Text>;
  const days = Math.ceil((deadline - Date.now()) / 86_400_000);
  const color = days < 0 ? 'gray' : days <= 3 ? 'red' : days <= 7 ? 'yellow' : 'green';
  const label = days < 0 ? 'closed' : days === 0 ? 'today' : `${days} d`;
  return (
    <Tooltip label={formatDate(deadline)}>
      <Badge color={color} variant="light">
        {label}
      </Badge>
    </Tooltip>
  );
}

/**
 * Explicit demand, section 9 of CLAUDE.md: open tenders by deadline, nearest first, then funding
 * news. A tender buyer opens in Companies; a news item has no company until the owner finds it.
 */
export function TendersPage() {
  const client = useQueryClient();
  const [source, setSource] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [all, setAll] = useState(false);

  const { data, error, isLoading } = useQuery({
    queryKey: ['leads', source, status, all],
    queryFn: () => api.leads({ source: source || undefined, status: status ?? undefined, all }),
  });

  const update = useMutation({
    mutationFn: ({ id, next }: { id: number; next: string }) => api.setLeadStatus(id, next),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['leads'] }),
    onError: (mutationError) => notifications.show({ color: 'red', title: 'Not saved', message: String(mutationError) }),
  });

  if (error) {
    return (
      <Box p="lg">
        <Alert color="red" title="Could not read the leads">
          {error instanceof Error ? error.message : String(error)}
        </Alert>
      </Box>
    );
  }

  return (
    <Stack gap="sm" p="lg">
      <Paper p="md">
        <Group gap="md">
          <SegmentedControl
            size="xs"
            data={[
              { value: '', label: 'all' },
              { value: 'prozorro', label: 'tenders' },
              { value: 'ain', label: 'AIN.ua' },
              { value: 'devua', label: 'dev.ua' },
            ]}
            value={source}
            onChange={setSource}
          />
          <Select
            size="xs"
            placeholder="any status"
            data={LEAD_STATUSES}
            value={status}
            onChange={setStatus}
            clearable
            w={160}
          />
          <Checkbox
            size="xs"
            label="include closed"
            checked={all}
            onChange={(event) => setAll(event.currentTarget.checked)}
          />
          <Text size="sm" c="dimmed" ml="auto">
            {data ? `${data.length} leads` : 'loading'}
          </Text>
        </Group>
      </Paper>

      {isLoading && <Skeleton h={320} />}

      {data?.length === 0 && (
        <Card>
          <EmptyState
            icon={<Gavel size={28} />}
            withIndicatorBackground
            title="No open leads"
            description="Run prozorro, ain or devua on the Sources page. They also run every morning on their own."
          />
        </Card>
      )}

      {data && data.length > 0 && (
        <Paper style={{ overflow: 'hidden' }}>
          <Table layout="fixed" stickyHeader>
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={80}>deadline</Table.Th>
                <Table.Th w={56}>fit</Table.Th>
                <Table.Th>lead</Table.Th>
                <Table.Th w={260}>company</Table.Th>
                <Table.Th w={140} ta="right">
                  budget
                </Table.Th>
                <Table.Th w={100}>source</Table.Th>
                <Table.Th w={150}>status</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {data.map((lead: LeadRow) => (
                <Table.Tr key={lead.id} style={lead.status === 'skipped' ? { opacity: 0.5 } : undefined}>
                  <Table.Td>
                    <DaysLeft deadline={lead.deadlineAt} />
                  </Table.Td>
                  <Table.Td>
                    {lead.fit === null ? (
                      <Text size="sm" c="dimmed">
                        -
                      </Text>
                    ) : (
                      <Tooltip label="model estimate: how well the tender fits a solo developer">
                        <Badge size="sm" color={lead.fit >= 67 ? 'green' : lead.fit >= 50 ? 'yellow' : 'gray'}>
                          {lead.fit}
                        </Badge>
                      </Tooltip>
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Tooltip label={lead.text ?? lead.title} multiline maw={520} openDelay={400}>
                      <Anchor href={lead.url} target="_blank" rel="noreferrer" size="sm" lineClamp={2}>
                        {lead.title} <ExternalLink size={11} />
                      </Anchor>
                    </Tooltip>
                  </Table.Td>
                  <Table.Td>
                    {lead.companyId ? (
                      <Anchor
                        href={href('companies', lead.companyDomain || `id-${lead.companyId}`)}
                        size="sm"
                        lineClamp={2}
                      >
                        {lead.companyName}
                      </Anchor>
                    ) : (
                      <Text size="sm" c="dimmed">
                        named in the article
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td ta="right">
                    <Text size="sm" className="tabular">
                      {lead.budget !== null ? `${money.format(lead.budget)} ${lead.currency ?? ''}` : ''}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge color="gray" size="sm">
                      {SOURCE_LABELS[lead.source] ?? lead.source}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Select
                      size="xs"
                      data={LEAD_STATUSES}
                      value={lead.status}
                      onChange={(next) => next && update.mutate({ id: lead.id, next })}
                      allowDeselect={false}
                    />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Paper>
      )}
    </Stack>
  );
}
