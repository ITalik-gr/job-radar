import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Card,
  DataList,
  Divider,
  Drawer,
  EmptyState,
  Group,
  Paper,
  Select,
  Skeleton,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { Building2, ExternalLink, Mail, Search } from 'lucide-react';
import { api, formatDate, type CompanyRow } from '../lib/api';
import { Score } from '../components/Score';
import { useSelection } from '../lib/useRoute';
import { ContactRow } from '../components/ContactRow';
import {
  STATUS_OPTIONS,
  StatusCell,
  StatusIcon,
  renderStatusOption,
  statusLabel,
} from '../components/statuses';

const ATS_KINDS = ['greenhouse', 'lever', 'ashby', 'html', 'rss', 'none', 'unknown'];

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <Text size="xs" tt="uppercase" fw={500} c="dimmed" style={{ letterSpacing: '0.04em' }}>
      {children}
    </Text>
  );
}

/**
 * Details open in a side drawer rather than a centred modal: the table stays in place,
 * and you can see which row is open. That makes it easier to go down the list.
 */
function Detail({ row, onClose }: { row: CompanyRow; onClose: () => void }) {
  const id = row.id;
  const client = useQueryClient();
  const { data, error } = useQuery({ queryKey: ['company', id], queryFn: () => api.company(id) });

  const setState = useMutation({
    mutationFn: (status: string) => api.setCompanyState(id, { status }),
    onSuccess: (_result, status) => {
      notifications.show({ color: 'green', title: 'Status changed', message: statusLabel(status) });
      void client.invalidateQueries({ queryKey: ['company', id] });
      void client.invalidateQueries({ queryKey: ['companies'] });
    },
  });

  const open = data?.vacancies.filter((vacancy) => !vacancy.closedAt) ?? [];
  const closed = data?.vacancies.filter((vacancy) => vacancy.closedAt) ?? [];

  return (
    <Drawer
      opened
      onClose={onClose}
      position="right"
      size={620}
      padding="lg"
      title={
        data && (
          <Box>
            <Title order={3}>{data.company.name}</Title>
            <Anchor href={`https://${data.company.domain}`} target="_blank" rel="noreferrer" size="sm">
              {data.company.domain}
            </Anchor>
          </Box>
        )
      }
    >
      {error && (
        <Alert color="red" title="Could not read the company">
          {error instanceof Error ? error.message : String(error)}
        </Alert>
      )}
      {!data && !error && <Skeleton h={280} />}

      {data && (
        <Stack gap="lg">
          <Select
            label="Status"
            data={STATUS_OPTIONS}
            value={data.state?.status ?? 'new'}
            onChange={(status) => status && setState.mutate(status)}
            renderOption={renderStatusOption}
            leftSection={<StatusIcon status={data.state?.status ?? 'new'} />}
            allowDeselect={false}
            maxDropdownHeight={400}
            comboboxProps={{ width: 320, position: 'bottom-start' }}
          />

          <DataList labelWidth={128} gap="sm">
            <DataList.Item>
              <DataList.ItemLabel>score</DataList.ItemLabel>
              <DataList.ItemValue>
                {/* The score comes only from the list: the details endpoint does not compute it. */}
                <Score value={row.score} />
              </DataList.ItemValue>
            </DataList.Item>
            <DataList.Item>
              <DataList.ItemLabel>ats</DataList.ItemLabel>
              <DataList.ItemValue>
                <Group gap="xs">
                  <Text>{data.company.careersKind}</Text>
                  {data.company.careersUrl && (
                    <Anchor href={data.company.careersUrl} target="_blank" rel="noreferrer" size="sm">
                      careers page
                    </Anchor>
                  )}
                </Group>
              </DataList.ItemValue>
            </DataList.Item>
            <DataList.Item>
              <DataList.ItemLabel>location</DataList.ItemLabel>
              <DataList.ItemValue>
                {[data.company.city, data.company.country].filter(Boolean).join(', ') || (
                  <Text c="dimmed">not stated</Text>
                )}
              </DataList.ItemValue>
            </DataList.Item>
            <DataList.Item>
              <DataList.ItemLabel>sources</DataList.ItemLabel>
              <DataList.ItemValue>
                {data.company.sources.length === 0 ? (
                  <Text c="dimmed">unknown</Text>
                ) : (
                  <Group gap={6}>
                    {data.company.sources.map((source) => (
                      <Badge key={source} color="gray">
                        {source}
                      </Badge>
                    ))}
                  </Group>
                )}
              </DataList.ItemValue>
            </DataList.Item>
            <DataList.Item>
              <DataList.ItemLabel>stack from the site</DataList.ItemLabel>
              <DataList.ItemValue>
                {data.company.techHints.length === 0 ? (
                  <Text c="dimmed">not detected</Text>
                ) : (
                  <Group gap={6}>
                    {data.company.techHints.map((tech) => (
                      <Badge key={tech}>{tech}</Badge>
                    ))}
                  </Group>
                )}
              </DataList.ItemValue>
            </DataList.Item>
            <DataList.Item>
              <DataList.ItemLabel>first seen</DataList.ItemLabel>
              <DataList.ItemValue>
                <Text className="tabular">{formatDate(data.company.firstSeen) || 'unknown'}</Text>
              </DataList.ItemValue>
            </DataList.Item>
          </DataList>

          <Divider />

          <Box>
            <SectionTitle>
              vacancies: {open.length} open, {closed.length} closed
            </SectionTitle>
            {data.vacancies.length === 0 ? (
              <Text c="dimmed" size="sm" mt="xs">
                none seen
              </Text>
            ) : (
              <Stack gap={2} mt="xs">
                {data.vacancies.map((vacancy) => (
                  <Group key={vacancy.id} gap="sm" wrap="nowrap">
                    <Score value={vacancy.score} size="sm" />
                    <Tooltip label={vacancy.llmWhy} disabled={!vacancy.llmWhy} multiline w={280}>
                      <Anchor
                        href={vacancy.url}
                        target="_blank"
                        rel="noreferrer"
                        size="sm"
                        style={{ flex: 1, minWidth: 0 }}
                        truncate
                      >
                        {vacancy.title ?? vacancy.url}
                      </Anchor>
                    </Tooltip>
                    <Text size="xs" c="dimmed" className="tabular" style={{ whiteSpace: 'nowrap' }}>
                      {formatDate(vacancy.firstSeen)}
                      {vacancy.closedAt ? ` - ${formatDate(vacancy.closedAt)}` : ' to date'}
                    </Text>
                  </Group>
                ))}
              </Stack>
            )}
          </Box>

          <Box>
            <SectionTitle>contacts</SectionTitle>
            {data.contacts.length === 0 ? (
              <Text c="dimmed" size="sm" mt="xs">
                none, try enrichment
              </Text>
            ) : (
              <Stack gap={6} mt="xs">
                {data.contacts.map((contact) => (
                  <ContactRow key={contact.id} companyId={id} contact={contact} />
                ))}
              </Stack>
            )}
          </Box>

          <Box>
            <SectionTitle>correspondence</SectionTitle>
            {data.outreach.length === 0 ? (
              <Text c="dimmed" size="sm" mt="xs">
                no letters
              </Text>
            ) : (
              <Stack gap={6} mt="xs">
                {data.outreach.map((row) => (
                  <Group key={row.id} gap="xs">
                    <Text size="sm" className="tabular">
                      {formatDate(row.sentAt)}
                    </Text>
                    <Text size="sm" c="dimmed">
                      {row.channel}
                    </Text>
                    {row.templateUsed && (
                      <Badge color="gray" size="sm">
                        {row.templateUsed}
                      </Badge>
                    )}
                    <Badge size="sm" color={row.replyType === 'positive' ? 'green' : row.replyType ? 'gray' : 'yellow'}>
                      {row.replyType ?? 'no reply'}
                    </Badge>
                  </Group>
                ))}
              </Stack>
            )}
          </Box>

          <Box>
            <SectionTitle>page snapshots</SectionTitle>
            {data.snapshots.length === 0 ? (
              <Text c="dimmed" size="sm" mt="xs">
                none
              </Text>
            ) : (
              <Stack gap={4} mt="xs">
                {data.snapshots.map((snapshot) => (
                  <Group key={snapshot.id} gap="sm">
                    <Text size="xs" className="tabular">
                      {formatDate(snapshot.fetchedAt)}
                    </Text>
                    <Text size="xs" c="dimmed" ff="monospace">
                      {snapshot.contentHash.slice(0, 12)}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {snapshot.blocks} blocks
                    </Text>
                  </Group>
                ))}
              </Stack>
            )}
          </Box>
        </Stack>
      )}
    </Drawer>
  );
}

export function CompaniesPage() {
  const [filters, setFilters] = useState({ q: '', status: '', ats: '', country: '' });
  const [selected, setSelected] = useState<CompanyRow | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  /*
   * The open company is the second address segment: `#/companies/acme.com`. The domain
   * rather than an id, deliberately: the link stays readable, and you can see where it
   * leads before clicking.
   */
  const [domain, select] = useSelection('companies');

  // Search waits until typing stops: otherwise every letter is a query over the whole database.
  const [search] = useDebouncedValue(filters.q, 300);
  const query = useMemo(() => ({ ...filters, q: search }), [filters, search]);

  const { data, error, isLoading } = useQuery({
    queryKey: ['companies', query],
    queryFn: () => api.companies(query),
  });

  /*
   * A company from the address is found through the list, not opened directly.
   *
   * The reason is technical: the details take the score from the list row, because the
   * `GET /companies/:id` response has none, it is computed on the fly only for the list.
   * So if the company is not in the current list, a search by its domain is switched on
   * first. A useful side effect: the filter stays visible, and it is clear why the table
   * has one row.
   */
  useEffect(() => {
    if (!domain) {
      setSelected(null);
      return;
    }
    if (selected?.domain === domain) return;

    const found = data?.find((row) => row.domain === domain);
    if (found) {
      setSelected(found);
      return;
    }

    // The search is switched on only when the company really is missing from the current list.
    if (data && filters.q !== domain) setFilters({ q: domain, status: '', ats: '', country: '' });
  }, [domain, data, selected, filters.q]);

  /*
   * Rows have a fixed height, so nothing needs measuring: the virtualizer computes
   * positions arithmetically. An overscan of 12 rows removes white gaps on fast scrolling,
   * and that is cheaper than drawing the whole list.
   */
  const virtualizer = useVirtualizer({
    count: data?.length ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 45,
    overscan: 12,
  });

  const items = virtualizer.getVirtualItems();
  const rows = items.map((item) => data![item.index]!);
  const padTop = items.length > 0 ? items[0]!.start : 0;
  const padBottom =
    items.length > 0 ? virtualizer.getTotalSize() - items[items.length - 1]!.end : 0;

  if (error) {
    return (
      <Box p="lg">
        <Alert color="red" title="Could not read the company list">
          {error instanceof Error ? error.message : String(error)}
        </Alert>
      </Box>
    );
  }

  return (
    <Stack gap="md" p="lg">
      <Paper p="md">
        <Group gap="md">
          <TextInput
            placeholder="name or domain"
            leftSection={<Search size={14} />}
            value={filters.q}
            onChange={(event) => setFilters({ ...filters, q: event.currentTarget.value })}
            w={280}
          />
          <Select
            placeholder="any status"
            data={STATUS_OPTIONS}
            value={filters.status || null}
            onChange={(status) => setFilters({ ...filters, status: status ?? '' })}
            renderOption={renderStatusOption}
            leftSection={filters.status ? <StatusIcon status={filters.status} /> : undefined}
            maxDropdownHeight={400}
            comboboxProps={{ width: 320, position: 'bottom-start' }}
            clearable
            w={200}
          />
          <Select
            placeholder="any ats"
            data={ATS_KINDS}
            value={filters.ats || null}
            onChange={(ats) => setFilters({ ...filters, ats: ats ?? '' })}
            clearable
            w={180}
          />
          {/*
            The most common question about this page: is this where letters are written. No.
            It is a directory of the whole database, the working lists are Queue and Studios.
          */}
          <Text size="sm" c="dimmed" maw={420} ml="auto">
            Directory of the whole database: {data?.length ?? 0} companies. Letters are written from
            Queue and Studios, this page is for search, statuses and each company's history.
          </Text>
        </Group>
      </Paper>

      {selected && <Detail row={selected} onClose={() => select(null)} />}

      {isLoading && <Skeleton h={420} />}

      {data?.length === 0 && (
        <Card>
          <EmptyState
            icon={<Building2 size={28} />}
            withIndicatorBackground
            title="No companies match these filters"
            description="Clear the search, or collect a catalog with the browser extension."
          />
        </Card>
      )}

      {data && data.length > 0 && (
        <Paper style={{ overflow: 'hidden' }}>
          {/*
            The scroll is native here, not ScrollArea: the virtualizer needs an element
            it can ask for the scroll position. The database has thousands of companies,
            and without virtualization the browser draws thousands of rows at once, after
            which the page thinks for a second on every click.
          */}
          <div ref={scrollRef} style={{ maxHeight: 'calc(100dvh - 224px)', overflowY: 'auto' }}>
            {/* Fixed layout: otherwise the name column stretches and pushes the status
                and counters past the right edge. */}
            <Table stickyHeader layout="fixed">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={90}>score</Table.Th>
                  <Table.Th>company</Table.Th>
                  <Table.Th w={110}>size</Table.Th>
                  <Table.Th w={110}>rating</Table.Th>
                  <Table.Th w={190}>location</Table.Th>
                  <Table.Th w={130}>ats</Table.Th>
                  <Table.Th w={150}>status</Table.Th>
                  <Table.Th w={110} ta="right">
                    open
                  </Table.Th>
                  <Table.Th w={130} ta="right">
                    checked
                  </Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {padTop > 0 && (
                  <Table.Tr aria-hidden style={{ height: padTop }}>
                    <Table.Td colSpan={9} p={0} />
                  </Table.Tr>
                )}
                {rows.map((row: CompanyRow) => (
                  <Table.Tr
                    key={row.id}
                    onClick={() => select(row.domain)}
                    style={{ cursor: 'pointer' }}
                    bg={selected?.id === row.id ? 'brand.0' : undefined}
                  >
                    <Table.Td>
                      <Score value={row.score} size="sm" />
                    </Table.Td>
                    <Table.Td>
                      <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                        <Text fw={500} truncate style={{ minWidth: 0 }}>
                          {row.name}
                        </Text>
                        <Anchor
                          href={`https://${row.domain}`}
                          target="_blank"
                          rel="noreferrer"
                          size="xs"
                          c="dimmed"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <Group gap={4} wrap="nowrap">
                            {row.domain}
                            <ExternalLink size={11} />
                          </Group>
                        </Anchor>
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c="dimmed">
                        {row.sizeHint ?? ''}
                      </Text>
                    </Table.Td>
                    {/* Catalog rating and reviews: the quickest sign of a living studio. */}
                    <Table.Td>
                      <Text size="sm" c="dimmed" className="tabular">
                        {row.rating === null
                          ? ''
                          : `${row.rating.toFixed(1)}${row.reviewsCount ? ` · ${row.reviewsCount}` : ''}`}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" truncate>
                        {[row.city, row.country].filter(Boolean).join(', ')}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      {row.careersKind === 'unknown' || row.careersKind === 'none' ? (
                        <Text size="sm" c="dimmed">
                          {row.careersKind}
                        </Text>
                      ) : (
                        <Badge>{row.careersKind}</Badge>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <StatusCell status={row.status} />
                    </Table.Td>
                    <Table.Td ta="right">
                      <Text size="sm" c={row.openVacancies ? undefined : 'dimmed'} className="tabular">
                        {row.openVacancies}
                      </Text>
                    </Table.Td>
                    <Table.Td ta="right">
                      <Text size="sm" c="dimmed" className="tabular">
                        {formatDate(row.lastChecked) || 'never'}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
                {padBottom > 0 && (
                  <Table.Tr aria-hidden style={{ height: padBottom }}>
                    <Table.Td colSpan={9} p={0} />
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
          </div>
        </Paper>
      )}
    </Stack>
  );
}
