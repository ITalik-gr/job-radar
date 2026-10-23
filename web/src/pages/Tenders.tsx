import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Anchor,
  Badge,
  Card,
  Checkbox,
  EmptyState,
  Group,
  Paper,
  SegmentedControl,
  NumberInput,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { ExternalLink, Landmark, Search } from 'lucide-react';
import { api, formatDate, type LeadParams, type LeadRow } from '../lib/api';
import { href } from '../lib/route';
import { useRoute } from '../lib/useRoute';
import { openCompany } from '../lib/listMemory';
import { PageHeader } from '../components/ui';

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
const DEADLINES = [
  { value: '', label: 'any deadline' },
  { value: '3', label: 'within 3 days' },
  { value: '7', label: 'within a week' },
  { value: '14', label: 'within 2 weeks' },
  { value: '30', label: 'within a month' },
];

const SORTS = [
  { value: 'deadline', label: 'nearest deadline' },
  { value: 'budget', label: 'largest budget' },
  { value: 'fit', label: 'best fit' },
  { value: 'new', label: 'newest' },
];

export function TendersPage() {
  const client = useQueryClient();
  /*
   * The filter lives in the address (`#/tenders?maxBudget=50000&minFit=67`), so a tender opened
   * and closed again returns to the same list, and a useful filter can be bookmarked.
   */
  const { query: params, setQuery } = useRoute();
  const filter: LeadParams = {
    source: params.source ?? '',
    status: params.status ?? '',
    all: params.all ?? '',
    q: params.q ?? '',
    minBudget: params.minBudget ?? '',
    maxBudget: params.maxBudget ?? '',
    minFit: params.minFit ?? '',
    deadlineDays: params.deadlineDays ?? '',
    sort: params.sort ?? '',
  };
  const [search] = useDebouncedValue(filter.q ?? '', 300);
  const key = JSON.stringify({ ...filter, q: search });
  const active = ['minBudget', 'maxBudget', 'minFit', 'deadlineDays', 'status', 'q'].filter(
    (name) => filter[name as keyof LeadParams],
  ).length;

  const { data, error, isLoading } = useQuery({
    queryKey: ['leads', key],
    queryFn: () => api.leads({ ...filter, q: search }),
    placeholderData: keepPreviousData,
  });

  const update = useMutation({
    mutationFn: ({ id, next }: { id: number; next: string }) => api.setLeadStatus(id, next),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['leads'] }),
    onError: (mutationError) => notifications.show({ color: 'red', title: 'Not saved', message: String(mutationError) }),
  });

  const companyKeys = (data ?? [])
    .filter((lead) => lead.companyId)
    .map((lead) => lead.companyDomain || `id-${lead.companyId}`);

  return (
    <>
      <PageHeader
        icon={Landmark}
        title="Tenders"
        description={data ? `${data.length} leads, open tenders by deadline and funding news` : 'loading'}
      >
        <TextInput
          placeholder="title, text or buyer"
          leftSection={<Search size={14} />}
          value={filter.q}
          onChange={(event) => setQuery({ q: event.currentTarget.value })}
          w={260}
          radius="xl"
        />
      </PageHeader>

      <Group gap="md" px="lg" py="sm" align="flex-end" style={{ borderBottom: '1px solid var(--mantine-color-gray-2)' }}>
        <SegmentedControl
          size="xs"
          data={[
            { value: '', label: 'all' },
            { value: 'prozorro', label: 'tenders' },
            { value: 'ain', label: 'AIN.ua' },
            { value: 'devua', label: 'dev.ua' },
          ]}
          value={filter.source ?? ''}
          onChange={(value) => setQuery({ source: value })}
        />
        <NumberInput
          label="Budget from"
          w={140}
          placeholder="any"
          thousandSeparator=" "
          min={0}
          step={10_000}
          value={filter.minBudget}
          onChange={(value) => setQuery({ minBudget: value === '' ? '' : String(value) })}
        />
        <NumberInput
          label="Budget to"
          w={140}
          placeholder="any"
          thousandSeparator=" "
          min={0}
          step={10_000}
          value={filter.maxBudget}
          onChange={(value) => setQuery({ maxBudget: value === '' ? '' : String(value) })}
        />
        <Select
          label="Fit"
          w={170}
          data={[
            { value: '', label: 'any, rated or not' },
            { value: '50', label: 'unclear or better' },
            { value: '67', label: 'a solo build' },
          ]}
          value={filter.minFit ?? ''}
          onChange={(value) => setQuery({ minFit: value ?? '' })}
          allowDeselect={false}
        />
        <Select
          label="Deadline"
          w={150}
          data={DEADLINES}
          value={filter.deadlineDays ?? ''}
          onChange={(value) => setQuery({ deadlineDays: value ?? '' })}
          allowDeselect={false}
        />
        <Select
          label="Status"
          w={140}
          placeholder="any"
          data={LEAD_STATUSES}
          value={filter.status || null}
          onChange={(value) => setQuery({ status: value ?? '' })}
          clearable
        />
        <Select
          label="Sort"
          w={170}
          data={SORTS}
          value={filter.sort || 'deadline'}
          onChange={(value) => setQuery({ sort: value === 'deadline' ? '' : (value ?? '') })}
          allowDeselect={false}
        />
        <Checkbox
          mb={8}
          label="include closed"
          checked={filter.all === '1'}
          onChange={(event) => setQuery({ all: event.currentTarget.checked ? '1' : '' })}
        />
        {active > 0 && (
          <Anchor
            component="button"
            size="sm"
            mb={8}
            onClick={() =>
              setQuery({ q: '', minBudget: '', maxBudget: '', minFit: '', deadlineDays: '', status: '', sort: '', all: '' })
            }
          >
            clear
          </Anchor>
        )}
      </Group>
      {(filter.minBudget || filter.maxBudget) && (
        <Text size="xs" c="dimmed" px="lg" pt={6}>
          A budget bound hides leads without a stated budget, news included. Prozorro budgets are in UAH.
        </Text>
      )}

      <Stack gap="sm" p="lg">
      {error && (
        <Alert color="red" title="Could not read the leads">
          {error instanceof Error ? error.message : String(error)}
        </Alert>
      )}

      {isLoading && (
        <Text size="sm" c="dimmed">
          loading
        </Text>
      )}

      {data?.length === 0 && (
        <Card>
          <EmptyState
            icon={<Landmark size={28} />}
            withIndicatorBackground
            title={active > 0 || filter.source ? 'Nothing matches these filters' : 'No open leads'}
            description={
              active > 0 || filter.source
                ? 'Widen the budget or the deadline, or clear the filters.'
                : 'Run prozorro, ain or devua on the Sources page. They also run every morning on their own.'
            }
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
                        onClick={(event) => {
                          event.preventDefault();
                          openCompany(lead.companyDomain || `id-${lead.companyId}`, companyKeys);
                        }}
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
    </>
  );
}
