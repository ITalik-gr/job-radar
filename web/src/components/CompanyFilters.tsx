import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ActionIcon,
  Button,
  Chip,
  Group,
  MultiSelect,
  NumberInput,
  Popover,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Bookmark, Search, Trash2, X } from 'lucide-react';
import { api, cleanFilter, type Bucket, type CompanyFilter } from '../lib/api';
import { STATUS_OPTIONS } from './statuses';
import { FIT_SERVICES, FIT_STAGES } from './ui';

/** Facet values as select options, with the count beside the value. */
const options = (rows: Bucket[] | undefined) =>
  (rows ?? []).map((row) => ({ value: row.key, label: `${row.key} (${row.count})` }));

type Flag = 'hasEmail' | 'hasNamedContact' | 'hasSite' | 'hasAuditIssues' | 'hiring';

const FLAGS: { key: Flag; label: string }[] = [
  { key: 'hasEmail', label: 'has email' },
  { key: 'hasNamedContact', label: 'named contact' },
  { key: 'hasSite', label: 'has site' },
  { key: 'hasAuditIssues', label: 'audit issues' },
  { key: 'hiring', label: 'hiring' },
];

/**
 * The filter panel of the Companies page: every field of the shared filter shape, plus saved
 * filters. The values offered come from the database itself, so a filter can never ask for an
 * industry nobody has.
 */
export function CompanyFilters({
  value,
  onChange,
  summary,
}: {
  value: CompanyFilter;
  onChange: (next: CompanyFilter) => void;
  summary?: React.ReactNode;
}) {
  const client = useQueryClient();
  const facets = useQuery({ queryKey: ['facets'], queryFn: api.facets, staleTime: 60_000 });
  const saved = useQuery({ queryKey: ['saved-filters'], queryFn: api.savedFilters });
  const [active, setActive] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [saveOpen, setSaveOpen] = useState(false);

  const set = <K extends keyof CompanyFilter>(key: K, next: CompanyFilter[K]) => {
    setActive(null);
    onChange(cleanFilter({ ...value, [key]: next }));
  };

  const save = useMutation({
    mutationFn: () => api.saveFilter(name, value),
    onSuccess: (result) => {
      notifications.show({
        color: 'green',
        title: result.before ? 'Filter replaced' : 'Filter saved',
        message: result.after.name,
      });
      setActive(String(result.after.id));
      setSaveOpen(false);
      void client.invalidateQueries({ queryKey: ['saved-filters'] });
    },
    onError: (error) => notifications.show({ color: 'red', title: 'Not saved', message: String(error) }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.deleteFilter(id),
    onSuccess: () => {
      setActive(null);
      void client.invalidateQueries({ queryKey: ['saved-filters'] });
    },
  });

  const empty = Object.keys(cleanFilter(value)).length === 0;

  return (
    <Stack gap="sm">
      <Group gap="sm" wrap="nowrap">
        <TextInput
          placeholder="name, domain or tag"
          leftSection={<Search size={14} />}
          value={value.search ?? ''}
          onChange={(event) => set('search', event.currentTarget.value)}
          w={260}
        />
        <Select
          placeholder={saved.data?.length ? 'saved filters' : 'no saved filters'}
          data={(saved.data ?? []).map((row) => ({ value: String(row.id), label: row.name }))}
          value={active}
          onChange={(id) => {
            const found = saved.data?.find((row) => String(row.id) === id);
            setActive(id);
            if (found) onChange(found.query);
          }}
          leftSection={<Bookmark size={14} />}
          disabled={!saved.data?.length}
          clearable
          w={240}
        />
        {active && (
          <Tooltip label="delete this saved filter">
            <ActionIcon variant="subtle" color="red" onClick={() => remove.mutate(Number(active))}>
              <Trash2 size={14} />
            </ActionIcon>
          </Tooltip>
        )}
        <Popover opened={saveOpen} onChange={setSaveOpen} position="bottom-start" withArrow>
          <Popover.Target>
            <Button variant="subtle" disabled={empty} onClick={() => setSaveOpen((open) => !open)}>
              Save filter
            </Button>
          </Popover.Target>
          <Popover.Dropdown>
            <Group gap="xs">
              <TextInput
                placeholder="UA, clinics, slow site"
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                onKeyDown={(event) => event.key === 'Enter' && name.trim() && save.mutate()}
                w={240}
                data-autofocus
              />
              <Button onClick={() => save.mutate()} disabled={!name.trim()} loading={save.isPending}>
                Save
              </Button>
            </Group>
            <Text size="xs" c="dimmed" mt={6}>
              The same name replaces the saved one.
            </Text>
          </Popover.Dropdown>
        </Popover>
        {!empty && (
          <Button
            variant="subtle"
            color="gray"
            leftSection={<X size={14} />}
            onClick={() => {
              setActive(null);
              onChange({});
            }}
          >
            Clear
          </Button>
        )}
        <Text size="sm" c="dimmed" ml="auto" style={{ whiteSpace: 'nowrap' }}>
          {summary}
        </Text>
      </Group>

      <Group gap="sm" align="flex-end">
        <SegmentedControl
          size="xs"
          data={[
            { value: '', label: 'any market' },
            { value: 'ua', label: 'UA' },
            { value: 'intl', label: 'intl' },
          ]}
          value={value.market ?? ''}
          onChange={(market) => set('market', (market || undefined) as CompanyFilter['market'])}
        />
        <MultiSelect
          size="xs"
          placeholder={value.kind?.length ? undefined : 'segment'}
          data={options(facets.data?.kind)}
          value={value.kind ?? []}
          onChange={(kind) => set('kind', kind)}
          clearable
          w={180}
        />
        <MultiSelect
          size="xs"
          placeholder={value.industry?.length ? undefined : 'industry'}
          data={options(facets.data?.industry)}
          value={value.industry ?? []}
          onChange={(industry) => set('industry', industry)}
          searchable
          clearable
          w={180}
        />
        <Select
          size="xs"
          placeholder="country"
          data={options(facets.data?.country)}
          value={value.country ?? null}
          onChange={(country) => set('country', country ?? undefined)}
          searchable
          clearable
          w={120}
        />
        <Select
          size="xs"
          placeholder="city"
          data={options(facets.data?.city)}
          value={value.city ?? null}
          onChange={(city) => set('city', city ?? undefined)}
          searchable
          clearable
          w={140}
        />
        <Select
          size="xs"
          placeholder="source"
          data={options(facets.data?.source)}
          value={value.source ?? null}
          onChange={(source) => set('source', source ?? undefined)}
          searchable
          clearable
          w={140}
        />
        <MultiSelect
          size="xs"
          placeholder={value.tags?.length ? undefined : 'tags, all of'}
          data={options(facets.data?.tags)}
          value={value.tags ?? []}
          onChange={(tags) => set('tags', tags)}
          searchable
          clearable
          w={200}
        />
        <MultiSelect
          size="xs"
          placeholder={value.status?.length ? undefined : 'status'}
          data={STATUS_OPTIONS}
          value={value.status ?? []}
          onChange={(status) => set('status', status)}
          clearable
          w={200}
        />
        <NumberInput
          size="xs"
          placeholder="score from"
          value={value.minScore ?? ''}
          onChange={(score) => set('minScore', score === '' ? undefined : Number(score))}
          w={100}
        />
        <NumberInput
          size="xs"
          placeholder="score to"
          value={value.maxScore ?? ''}
          onChange={(score) => set('maxScore', score === '' ? undefined : Number(score))}
          w={100}
        />
              <Select
          size="xs"
          placeholder="would they buy"
          data={[
            { value: '67', label: 'possible or likely' },
            { value: '100', label: 'likely only' },
          ]}
          value={value.minFit === undefined ? null : String(value.minFit)}
          onChange={(fit) => set('minFit', fit ? Number(fit) : undefined)}
          clearable
          w={160}
        />
        <MultiSelect
          size="xs"
          placeholder={value.fitService?.length ? undefined : 'service'}
          data={Object.entries(FIT_SERVICES).map(([key, label]) => ({ value: key, label }))}
          value={value.fitService ?? []}
          onChange={(service) => set('fitService', service)}
          clearable
          w={180}
        />
        <MultiSelect
          size="xs"
          placeholder={value.fitStage?.length ? undefined : 'stage'}
          data={Object.entries(FIT_STAGES).map(([key, label]) => ({ value: key, label }))}
          value={value.fitStage ?? []}
          onChange={(stage) => set('fitStage', stage)}
          clearable
          w={160}
        />
      </Group>

      <Group gap={6}>
        {FLAGS.map((flag) => (
          <Chip
            key={flag.key}
            size="xs"
            checked={value[flag.key] === true}
            onChange={(checked) => set(flag.key, checked ? true : undefined)}
          >
            {flag.label}
          </Chip>
        ))}
        {/* "No site" is a lead of its own (section 5), so that one flag also has its negative. */}
        <Chip
          size="xs"
          color="yellow"
          checked={value.hasSite === false}
          onChange={(checked) => set('hasSite', checked ? false : undefined)}
        >
          no site
        </Chip>
      </Group>
    </Stack>
  );
}
