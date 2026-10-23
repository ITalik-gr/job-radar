import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
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
  TagsInput,
  Text,
  Title,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { Building2, ExternalLink, Mail, Phone, UserRound } from 'lucide-react';
import { api, cleanFilter, companyKey, formatDate, type CompanyFilter, type StudioCard } from '../lib/api';
import { CompanyFilters } from '../components/CompanyFilters';
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
function Detail({ row, onClose }: { row: StudioCard; onClose: () => void }) {
  const id = row.companyId;
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

  const audit = data?.audits[0] ?? null;

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
            {data.company.domain ? (
              <Anchor href={`https://${data.company.domain}`} target="_blank" rel="noreferrer" size="sm">
                {data.company.domain}
              </Anchor>
            ) : (
              <Text size="sm" c="dimmed">
                no site{data.company.phone ? `, ${data.company.phone}` : ''}
              </Text>
            )}
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
              site audit{audit ? `, ${formatDate(audit.checkedAt)}` : ''}
            </SectionTitle>
            {!audit ? (
              <Text c="dimmed" size="sm" mt="xs">
                not checked yet
              </Text>
            ) : (
              <Stack gap={4} mt="xs">
                <Group gap="xs">
                  {audit.perfScore !== null && (
                    <Badge color={audit.perfScore >= 80 ? 'green' : audit.perfScore >= 50 ? 'yellow' : 'red'}>
                      speed {audit.perfScore}
                    </Badge>
                  )}
                  {audit.fieldLcpMs !== null && (
                    <Badge color={audit.fieldLcpMs <= 2500 ? 'green' : audit.fieldLcpMs <= 4000 ? 'yellow' : 'red'}>
                      real visitors {(audit.fieldLcpMs / 1000).toFixed(1)} s
                    </Badge>
                  )}
                  {audit.lcpMs !== null && (
                    <Badge color="gray" variant="light">
                      lab {(audit.lcpMs / 1000).toFixed(1)} s
                    </Badge>
                  )}
                  {audit.mobileOk === false && <Badge color="red">no mobile layout</Badge>}
                  {audit.https === false && <Badge color="red">no https</Badge>}
                  {audit.cms && <Badge color="gray">{audit.cms}</Badge>}
                </Group>
                {audit.issues.map((issue) => (
                  <Text key={issue} size="sm">
                    {issue}
                  </Text>
                ))}
              </Stack>
            )}
          </Box>

          <Box>
            <SectionTitle>leads</SectionTitle>
            {data.leads.length === 0 ? (
              <Text c="dimmed" size="sm" mt="xs">
                no open requests or tenders
              </Text>
            ) : (
              <Stack gap={2} mt="xs">
                {data.leads.map((lead) => (
                  <Group key={lead.id} gap="sm" wrap="nowrap">
                    <Badge size="sm" color="gray">
                      {lead.source}
                    </Badge>
                    <Anchor
                      href={lead.url}
                      target="_blank"
                      rel="noreferrer"
                      size="sm"
                      style={{ flex: 1, minWidth: 0 }}
                      truncate
                    >
                      {lead.title}
                    </Anchor>
                    <Text size="xs" c="dimmed" className="tabular" style={{ whiteSpace: 'nowrap' }}>
                      {lead.deadlineAt ? `until ${formatDate(lead.deadlineAt)}` : formatDate(lead.firstSeen)}
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

        </Stack>
      )}
    </Drawer>
  );
}

/** The status a bulk action can set. Snoozing many at once needs no end date picker: 30 days. */
const BULK_STATUSES = STATUS_OPTIONS;

function BulkBar({ ids, cards, onDone }: { ids: number[]; cards: StudioCard[]; onDone: () => void }) {
  const client = useQueryClient();
  const [addTags, setAddTags] = useState<string[]>([]);

  // Tags the selected companies carry, the only ones worth offering for removal.
  const present = useMemo(() => {
    const chosen = new Set(ids);
    return [...new Set(cards.filter((card) => chosen.has(card.companyId)).flatMap((card) => card.tags))].sort();
  }, [ids, cards]);

  const bulk = useMutation({
    mutationFn: (body: { status?: string; addTags?: string[]; removeTags?: string[] }) => api.bulk({ ids, ...body }),
    onSuccess: (result) => {
      notifications.show({
        color: result.kept.length > 0 ? 'yellow' : 'green',
        title: `${result.changed} of ${ids.length} changed`,
        message:
          result.kept.length > 0
            ? `${result.kept.length} kept their status: a contacted or replied company is never downgraded`
            : 'saved',
      });
      setAddTags([]);
      void client.invalidateQueries({ queryKey: ['companies'] });
      void client.invalidateQueries({ queryKey: ['facets'] });
      void client.invalidateQueries({ queryKey: ['studios'] });
      void client.invalidateQueries({ queryKey: ['stats'] });
      onDone();
    },
    onError: (error) => notifications.show({ color: 'red', title: 'Not changed', message: String(error) }),
  });

  return (
    <Paper p="sm" bg="brand.0">
      <Group gap="sm">
        <Text size="sm" fw={500}>
          {ids.length} selected
        </Text>
        <Select
          size="xs"
          placeholder="set status"
          data={BULK_STATUSES}
          value={null}
          onChange={(status) => status && bulk.mutate({ status })}
          renderOption={renderStatusOption}
          comboboxProps={{ width: 320, position: 'bottom-start' }}
          maxDropdownHeight={400}
          w={160}
        />
        <TagsInput
          size="xs"
          placeholder="add tags, Enter"
          value={addTags}
          onChange={setAddTags}
          w={220}
        />
        <Button size="xs" variant="light" disabled={addTags.length === 0} onClick={() => bulk.mutate({ addTags })}>
          Add tags
        </Button>
        <Select
          size="xs"
          placeholder="remove a tag"
          data={present}
          value={null}
          onChange={(tag) => tag && bulk.mutate({ removeTags: [tag] })}
          searchable
          disabled={present.length === 0}
          w={180}
        />
        <Button size="xs" variant="subtle" color="gray" ml="auto" onClick={onDone}>
          Clear selection
        </Button>
      </Group>
    </Paper>
  );
}

export function CompaniesPage() {
  const [filter, setFilter] = useState<CompanyFilter>({});
  const [sort, setSort] = useState<'score' | 'name'>('score');
  const [selected, setSelected] = useState<StudioCard | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  /*
   * The open company is the second address segment: `#/companies/acme.com`. The domain
   * rather than an id, deliberately: the link stays readable, and you can see where it
   * leads before clicking.
   */
  const [domain, select] = useSelection('companies');

  // Search waits until typing stops: otherwise every letter is a query over the whole database.
  const [search] = useDebouncedValue(filter.search, 300);
  const query = useMemo(() => cleanFilter({ ...filter, search }), [filter, search]);

  const { data, error, isLoading } = useQuery({
    queryKey: ['companies', query, sort],
    queryFn: () => api.companies(query, sort),
  });
  const cards = data?.cards;

  // A selection belongs to the rows on screen: a new filter starts a new one.
  useEffect(() => setChecked(new Set()), [query]);

  /*
   * A company from the address is found through the list, not opened directly: the details
   * take the score from the list row. So if the company is not in the current list, a search
   * by its domain is switched on first, and the filter stays visible to say why the table
   * has one row.
   */
  useEffect(() => {
    if (!domain) {
      setSelected(null);
      return;
    }
    if (selected && companyKey(selected) === domain) return;

    const found = cards?.find((row) => companyKey(row) === domain);
    if (found) {
      setSelected(found);
      return;
    }
    // A company without a site has no domain to search by: clearing the filter is all that helps.
    if (domain.startsWith('id-')) {
      if (cards && Object.keys(filter).length > 0) setFilter({});
      return;
    }
    if (cards && filter.search !== domain) setFilter({ search: domain });
  }, [domain, cards, selected, filter.search]);

  /*
   * Rows have a fixed height, so nothing needs measuring: the virtualizer computes
   * positions arithmetically. An overscan of 12 rows removes white gaps on fast scrolling.
   */
  const virtualizer = useVirtualizer({
    count: cards?.length ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 45,
    overscan: 12,
  });

  const items = virtualizer.getVirtualItems();
  const rows = items.map((item) => cards![item.index]!);
  const padTop = items.length > 0 ? items[0]!.start : 0;
  const padBottom = items.length > 0 ? virtualizer.getTotalSize() - items[items.length - 1]!.end : 0;

  const allChecked = Boolean(cards?.length) && checked.size === cards!.length;
  const toggle = (id: number) =>
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
    <Stack gap="sm" p="lg">
      <Paper p="md">
        <CompanyFilters
          value={filter}
          onChange={setFilter}
          summary={data ? `${data.cards.length} of ${data.total} companies` : 'loading'}
        />
      </Paper>

      {checked.size > 0 && cards && (
        <BulkBar ids={[...checked]} cards={cards} onDone={() => setChecked(new Set())} />
      )}

      {selected && <Detail row={selected} onClose={() => select(null)} />}

      {isLoading && <Skeleton h={420} />}

      {cards?.length === 0 && (
        <Card>
          <EmptyState
            icon={<Building2 size={28} />}
            withIndicatorBackground
            title="No companies match these filters"
            description="Clear a filter, or collect a catalog on the Sources page."
          />
        </Card>
      )}

      {cards && cards.length > 0 && (
        <Paper style={{ overflow: 'hidden' }}>
          {/*
            The scroll is native here, not ScrollArea: the virtualizer needs an element
            it can ask for the scroll position. The database has thousands of companies.
          */}
          <div ref={scrollRef} style={{ maxHeight: 'calc(100dvh - 300px)', overflowY: 'auto' }}>
            <Table stickyHeader layout="fixed">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={40}>
                    <Checkbox
                      size="xs"
                      aria-label="select all"
                      checked={allChecked}
                      indeterminate={checked.size > 0 && !allChecked}
                      onChange={() =>
                        setChecked(allChecked ? new Set() : new Set(cards.map((card) => card.companyId)))
                      }
                    />
                  </Table.Th>
                  <Table.Th w={80}>
                    <UnstyledButton onClick={() => setSort('score')} fw={sort === 'score' ? 600 : undefined}>
                      score
                    </UnstyledButton>
                  </Table.Th>
                  <Table.Th>
                    <UnstyledButton onClick={() => setSort('name')} fw={sort === 'name' ? 600 : undefined}>
                      company
                    </UnstyledButton>
                  </Table.Th>
                  <Table.Th w={110}>segment</Table.Th>
                  <Table.Th w={110}>industry</Table.Th>
                  <Table.Th w={160}>location</Table.Th>
                  <Table.Th w={80}>reach</Table.Th>
                  <Table.Th w={70} ta="right">
                    issues
                  </Table.Th>
                  <Table.Th w={150}>status</Table.Th>
                  <Table.Th w={70} ta="right">
                    hiring
                  </Table.Th>
                  <Table.Th w={100} ta="right">
                    checked
                  </Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {padTop > 0 && (
                  <Table.Tr aria-hidden style={{ height: padTop }}>
                    <Table.Td colSpan={11} p={0} />
                  </Table.Tr>
                )}
                {rows.map((row) => {
                  const email = row.contacts.some((contact) => contact.email && contact.emailValid);
                  const named = row.contacts.some((contact) => contact.name);
                  const issues = row.audit?.issues ?? [];
                  return (
                    <Table.Tr
                      key={row.companyId}
                      onClick={() => select(companyKey(row))}
                      style={{ cursor: 'pointer' }}
                      bg={selected?.companyId === row.companyId ? 'brand.0' : undefined}
                    >
                      <Table.Td onClick={(event) => event.stopPropagation()}>
                        <Checkbox
                          size="xs"
                          aria-label={`select ${row.name}`}
                          checked={checked.has(row.companyId)}
                          onChange={() => toggle(row.companyId)}
                        />
                      </Table.Td>
                      <Table.Td>
                        <Score value={row.score} size="sm" />
                      </Table.Td>
                      <Table.Td>
                        <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                          <Text fw={500} truncate style={{ minWidth: 0 }}>
                            {row.name}
                          </Text>
                          {row.domain && (
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
                          )}
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c={row.kind === 'unknown' ? 'dimmed' : undefined}>
                          {row.kind}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed" truncate>
                          {row.industry ?? ''}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" truncate>
                          {[row.city, row.country].filter(Boolean).join(', ')}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        {/* A named contact is worth more than info@, so it gets its own mark. */}
                        <Group gap={6} wrap="nowrap">
                          {named && (
                            <Tooltip label="named contact">
                              <UserRound size={14} />
                            </Tooltip>
                          )}
                          {email && (
                            <Tooltip label="email">
                              <Mail size={14} />
                            </Tooltip>
                          )}
                          {row.phone && (
                            <Tooltip label={row.phone}>
                              <Phone size={14} />
                            </Tooltip>
                          )}
                        </Group>
                      </Table.Td>
                      <Table.Td ta="right">
                        {issues.length > 0 ? (
                          <Tooltip label={issues.join(', ')} multiline maw={320}>
                            <Badge color="red" size="sm">
                              {issues.length}
                            </Badge>
                          </Tooltip>
                        ) : (
                          <Text size="sm" c="dimmed">
                            {row.audit ? '0' : '-'}
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <StatusCell status={row.status} />
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text size="sm" c={row.hiring ? undefined : 'dimmed'} className="tabular">
                          {row.hiring ? (row.hiringRoles ?? 'yes') : '-'}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text size="sm" c="dimmed" className="tabular">
                          {formatDate(row.lastChecked) || 'never'}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
                {padBottom > 0 && (
                  <Table.Tr aria-hidden style={{ height: padBottom }}>
                    <Table.Td colSpan={11} p={0} />
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
