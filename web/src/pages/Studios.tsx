import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  Alert,
  Anchor,
  Button,
  Checkbox,
  EmptyState,
  MultiSelect,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Group,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { Download, Funnel, ListChecks, Rocket, Search } from 'lucide-react';
import { api, cleanFilter, filterParams, type CompanyFilter } from '../lib/api';
import { useRoute } from '../lib/useRoute';
import { LeadList, useCardAction } from '../components/LeadList';
import { FIT_SERVICES, FIT_STAGES, PageHeader } from '../components/ui';

export interface CompanyListProps {
  /** Empty means everything except product companies. */
  kind?: string;
  emptyTitle?: string;
  emptyHint?: string;
}

/**
 * Leads and Startups are the same screen over different slices of the database, so the page is
 * parameterised by kind instead of being copied a second time.
 *
 * The filters live in the address (`#/studios?country=UA&named=1`), so coming back from a company
 * page finds the list exactly as it was left, and a filtered list can be bookmarked.
 */
export function StudiosPage({ kind, emptyTitle, emptyHint }: CompanyListProps = {}) {
  const { query: params, setQuery } = useRoute();
  const filters = {
    q: params.q ?? '',
    country: params.country ?? '',
    min: params.min ?? '',
    rating: params.rating ?? '',
    all: params.all ?? '',
    named: params.named ?? '',
    email: params.email ?? '',
    hiring: params.hiring ?? '',
    market: params.market ?? '',
    industry: params.industry ?? '',
    fit: params.fit ?? '',
    service: params.service ?? '',
    stage: params.stage ?? '',
  };
  const split = (value: string) => (value ? value.split(',') : undefined);
  const active = Object.entries(filters).filter(([key, value]) => key !== 'q' && value).length;
  const [filtersOpen, setFiltersOpen] = useState(active > 0);
  const facets = useQuery({ queryKey: ['facets'], queryFn: api.facets, enabled: filtersOpen });

  /*
   * Search waits until typing stops. Without that every key press is a separate request, and a
   * request here is not cheap: the score is computed over the whole database.
   */
  const [search] = useDebouncedValue(filters.q, 300);
  const query = useMemo<CompanyFilter>(
    () =>
      cleanFilter({
        search,
        country: filters.country || undefined,
        minScore: filters.min === '' ? undefined : Number(filters.min),
        minRating: filters.rating === '' ? undefined : Number(filters.rating),
        includeContacted: filters.all === '1' || undefined,
        hasNamedContact: filters.named === '1' || undefined,
        hasEmail: filters.email === '1' || undefined,
        hiring: filters.hiring === '1' || undefined,
        market: filters.market === 'ua' || filters.market === 'intl' ? filters.market : undefined,
        industry: split(filters.industry),
        minFit: filters.fit === '' ? undefined : Number(filters.fit),
        fitService: split(filters.service),
        fitStage: split(filters.stage),
        kind: kind ? [kind] : undefined,
      }),
    // The params object is new on every render; its serialised form is what changes.
    [search, JSON.stringify(filters), kind],
  );

  // A new filter keeps the old rows on screen until the new ones arrive: no blank list in between.
  const list = useQuery({ queryKey: ['studios', query], queryFn: () => api.studios(query), placeholderData: keepPreviousData });
  const data = list.data;
  const act = useCardAction();

  return (
    <>
      <PageHeader
        icon={kind === 'startup' ? Rocket : ListChecks}
        title={kind === 'startup' ? 'Startups' : 'Leads'}
        description={
          data ? (
            <>
              {data.cards.length} of {data.total} companies
              {data.total > data.aboveThreshold && (
                <Tooltip label="the threshold can be changed on the Rules page">
                  <Text span c="dimmed">
                    {' '}
                    · threshold {data.threshold} hid {data.total - data.aboveThreshold}
                  </Text>
                </Tooltip>
              )}
            </>
          ) : (
            'loading'
          )
        }
      >
        <TextInput
          placeholder="name, domain or tag"
          leftSection={<Search size={14} />}
          value={filters.q}
          onChange={(event) => setQuery({ q: event.currentTarget.value })}
          w={260}
          radius="xl"
        />
        <Button
          leftSection={<Funnel size={15} />}
          variant={filtersOpen ? 'light' : 'default'}
          color={filtersOpen ? 'brand' : undefined}
          onClick={() => setFiltersOpen((value) => !value)}
        >
          Filters{active > 0 ? ` ${active}` : ''}
        </Button>
        {/*
          Export through a plain link rather than fetch: the browser saves the file itself from
          the content-disposition header, with no blob juggling.
        */}
        <Button
          component="a"
          href={`/api/export/studios?${new URLSearchParams(filterParams(query)).toString()}`}
          download
          leftSection={<Download size={15} />}
        >
          CSV
        </Button>
      </PageHeader>

      {filtersOpen && (
        <Group gap="md" px="lg" py="sm" align="flex-end" style={{ borderBottom: '1px solid var(--mantine-color-gray-2)' }}>
          <SegmentedControl
            size="xs"
            data={[
              { value: '', label: 'any market' },
              { value: 'ua', label: 'UA' },
              { value: 'intl', label: 'intl' },
            ]}
            value={filters.market}
            onChange={(value) => setQuery({ market: value })}
          />
          <Select
            label="Would they buy"
            w={170}
            data={[
              { value: '', label: 'any, rated or not' },
              { value: '67', label: 'possible or likely' },
              { value: '100', label: 'likely only' },
            ]}
            value={filters.fit}
            onChange={(value) => setQuery({ fit: value ?? '' })}
            allowDeselect={false}
          />
          <MultiSelect
            label="Service"
            w={220}
            placeholder={filters.service ? undefined : 'any'}
            data={Object.entries(FIT_SERVICES).map(([value, label]) => ({ value, label }))}
            value={split(filters.service) ?? []}
            onChange={(value) => setQuery({ service: value.join(',') })}
            clearable
          />
          <MultiSelect
            label="Stage"
            w={200}
            placeholder={filters.stage ? undefined : 'any'}
            data={Object.entries(FIT_STAGES).map(([value, label]) => ({ value, label }))}
            value={split(filters.stage) ?? []}
            onChange={(value) => setQuery({ stage: value.join(',') })}
            clearable
          />
          <MultiSelect
            label="Industry"
            w={220}
            placeholder={filters.industry ? undefined : 'any'}
            data={(facets.data?.industry ?? []).map((row) => ({ value: row.key, label: `${row.key} (${row.count})` }))}
            value={split(filters.industry) ?? []}
            onChange={(value) => setQuery({ industry: value.join(',') })}
            searchable
            clearable
          />
          <TextInput
            label="Country"
            placeholder="UA"
            w={90}
            value={filters.country}
            onChange={(event) => setQuery({ country: event.currentTarget.value })}
          />
          <NumberInput
            label="Min score"
            w={110}
            placeholder={String(data?.threshold ?? 5)}
            value={filters.min}
            onChange={(value) => setQuery({ min: value === '' ? '' : String(value) })}
          />
          <NumberInput
            label="Min rating"
            w={110}
            placeholder="4.5"
            step={0.1}
            min={0}
            max={5}
            value={filters.rating}
            onChange={(value) => setQuery({ rating: value === '' ? '' : String(value) })}
          />
          <Stack gap={6} pb={4}>
            {/* The main working filter: a letter to hello@ is read by a manager, not a decision maker. */}
            <Checkbox
              label="named contact"
              checked={filters.named === '1'}
              onChange={(event) => setQuery({ named: event.currentTarget.checked ? '1' : '' })}
            />
            <Checkbox
              label="has email"
              checked={filters.email === '1'}
              onChange={(event) => setQuery({ email: event.currentTarget.checked ? '1' : '' })}
            />
          </Stack>
          <Stack gap={6} pb={4}>
            <Checkbox
              label="hiring developers"
              checked={filters.hiring === '1'}
              onChange={(event) => setQuery({ hiring: event.currentTarget.checked ? '1' : '' })}
            />
            <Checkbox
              label="include contacted"
              checked={filters.all === '1'}
              onChange={(event) => setQuery({ all: event.currentTarget.checked ? '1' : '' })}
            />
          </Stack>
          <Anchor
            component="button"
            size="sm"
            pb={8}
            onClick={() => setQuery(Object.fromEntries(Object.keys(filters).map((key) => [key, ''])))}
          >
            clear
          </Anchor>
        </Group>
      )}

      {list.error ? (
        <Alert color="red" m="lg" title="Could not read the list">
          {list.error instanceof Error ? list.error.message : String(list.error)}
        </Alert>
      ) : (
        <LeadList
          cards={data?.cards ?? []}
          loading={list.isLoading}
          onAct={act}
          empty={
            <EmptyState
              py="xl"
              icon={<ListChecks size={24} />}
              withIndicatorBackground
              title={emptyTitle ?? 'Nothing matches these filters'}
              description={emptyHint ?? 'Lower the minimum score or collect more catalog pages with the browser extension.'}
            />
          }
        />
      )}
    </>
  );
}
