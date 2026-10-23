import { useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Group,
  Paper,
  Select,
  Stack,
  Table,
  TagsInput,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { Building2, ExternalLink, Mail, Phone, UserRound } from 'lucide-react';
import {
  api,
  cleanFilter,
  companyKey,
  filterFromParams,
  filterParams,
  formatDate,
  type CompanyFilter,
  type ListCard,
} from '../lib/api';
import { CompanyFilters } from '../components/CompanyFilters';
import { Score } from '../components/Score';
import { PageHeader, SegmentBadge } from '../components/ui';
import { useRoute } from '../lib/useRoute';
import { openCompany, useListMemory } from '../lib/listMemory';
import { usePrefetchCompany } from '../components/LeadList';
import { STATUS_OPTIONS, StatusCell, renderStatusOption } from '../components/statuses';

/** The status a bulk action can set. Snoozing many at once needs no end date picker: 30 days. */
const BULK_STATUSES = STATUS_OPTIONS;

function BulkBar({ ids, cards, onDone }: { ids: number[]; cards: ListCard[]; onDone: () => void }) {
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
  /*
   * The filter and the sort live in the address (`#/companies?kind=smb&hasEmail=1`), so coming
   * back from a company page finds the directory exactly as it was left.
   */
  const { query: params, setQuery } = useRoute();
  const hash = JSON.stringify(params);
  const filter = useMemo(() => filterFromParams(params), [hash]);
  const sort: 'score' | 'name' = params.sort === 'name' ? 'name' : 'score';
  const replace = (next: Record<string, string | undefined>) =>
    setQuery({ ...Object.fromEntries(Object.keys(params).map((key) => [key, undefined])), ...next });
  const setFilter = (next: CompanyFilter) => replace({ ...filterParams(next), sort: params.sort });
  const setSort = (next: 'score' | 'name') => setQuery({ sort: next === 'name' ? 'name' : undefined });

  const [checked, setChecked] = useState<Set<number>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  // Search waits until typing stops: otherwise every letter is a query over the whole database.
  const [search] = useDebouncedValue(filter.search, 300);
  const query = useMemo(() => cleanFilter({ ...filter, search }), [filter, search]);

  const { data, error, isLoading } = useQuery({
    queryKey: ['companies', query, sort],
    queryFn: () => api.companies(query, sort),
    placeholderData: keepPreviousData,
  });
  const prefetch = usePrefetchCompany();
  const cards = data?.cards;
  const keys = useMemo(() => (cards ?? []).map(companyKey), [cards]);
  const { opened } = useListMemory(scrollRef, Boolean(cards?.length));

  // A selection belongs to the rows on screen: a new filter starts a new one.
  useEffect(() => setChecked(new Set()), [query]);

  /*
   * Rows have a fixed height, so nothing needs measuring: the virtualizer computes
   * positions arithmetically. An overscan of 12 rows removes white gaps on fast scrolling.
   */
  const virtualizer = useVirtualizer({
    count: cards?.length ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 41,
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

  return (
    <>
    <PageHeader
      icon={Building2}
      title="Companies"
      description={data ? `${data.cards.length} of ${data.total} companies, the whole database with nothing hidden` : 'loading'}
    />
    <Stack gap="sm" p="lg" style={{ flex: 1, minHeight: 0 }}>
      <Paper p="md">
        <CompanyFilters
          value={filter}
          onChange={setFilter}
          summary={data ? `${data.cards.length} of ${data.total} companies` : 'loading'}
        />
      </Paper>

      {error && (
        <Alert color="red" title="Could not read the company list">
          {error instanceof Error ? error.message : String(error)}
        </Alert>
      )}

      {checked.size > 0 && cards && (
        <BulkBar ids={[...checked]} cards={cards} onDone={() => setChecked(new Set())} />
      )}

      {isLoading && (
        <Text size="sm" c="dimmed">
          loading the directory
        </Text>
      )}

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
        <Paper style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
          {/*
            The scroll is native here, not ScrollArea: the virtualizer needs an element
            it can ask for the scroll position. The database has thousands of companies.
          */}
          <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
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
                  <Table.Th w={130}>segment</Table.Th>
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
                      data-key={companyKey(row)}
                      tabIndex={0}
                      onClick={() => openCompany(companyKey(row), keys, scrollRef.current)}
                      onMouseEnter={() => prefetch(companyKey(row))}
                      onKeyDown={(event) =>
                        event.key === 'Enter' && event.target === event.currentTarget && openCompany(companyKey(row), keys, scrollRef.current)
                      }
                      style={{
                        cursor: 'pointer',
                        outline: 'none',
                        ...(companyKey(row) === opened ? { boxShadow: 'inset 3px 0 0 #2563eb' } : {}),
                      }}
                      bg={companyKey(row) === opened ? 'brand.0' : undefined}
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
                          <Text fw={500} size="sm" truncate style={{ minWidth: 0, flexShrink: 0, maxWidth: '70%' }}>
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
                              style={{ minWidth: 0, overflow: 'hidden' }}
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
                        <SegmentBadge kind={row.kind} size="xs" />
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
    </>
  );
}
