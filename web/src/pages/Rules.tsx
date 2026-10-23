import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Card,
  Group,
  NumberInput,
  Paper,
  ScrollArea,
  Skeleton,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Plus, RotateCcw, Save, Search, Trash2 } from 'lucide-react';
import { api, type Rules } from '../lib/api';

const SOURCE_LABELS: Record<string, string> = {
  db: 'edits from the interface',
  file: 'config/scoring.json on disk',
  bundled: 'default values',
};

function SectionTitle({ title, hint }: { title: string; hint: string }) {
  return (
    <Box mb="md">
      <Title order={4}>{title}</Title>
      <Text size="sm" c="dimmed">
        {hint}
      </Text>
    </Box>
  );
}

/** A weight table: key plus number, with rows that can be added and removed. */
function TermWeights({
  terms,
  onChange,
  placeholder = 'e.g. dental',
}: {
  terms: Record<string, number>;
  onChange: (next: Record<string, number>) => void;
  placeholder?: string;
}) {
  const [term, setTerm] = useState('');
  const [weight, setWeight] = useState<number | string>(1);
  const [filter, setFilter] = useState('');

  const rows = useMemo(
    () =>
      Object.entries(terms)
        .filter(([key]) => !filter || key.includes(filter.toLowerCase()))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    [terms, filter],
  );

  const add = () => {
    const key = term.trim().toLowerCase();
    if (!key) return;
    onChange({ ...terms, [key]: Number(weight) || 0 });
    setTerm('');
  };

  return (
    <Stack gap="sm">
      <Group gap="sm" align="flex-end">
        <TextInput
          label="Key"
          placeholder={placeholder}
          value={term}
          onChange={(event) => setTerm(event.currentTarget.value)}
          onKeyDown={(event) => event.key === 'Enter' && add()}
          style={{ flex: 1 }}
        />
        <NumberInput label="Weight" value={weight} onChange={setWeight} w={100} allowDecimal step={1} />
        <Button variant="default" leftSection={<Plus size={15} />} onClick={add}>
          Add
        </Button>
      </Group>

      <TextInput
        placeholder="filter"
        leftSection={<Search size={14} />}
        value={filter}
        onChange={(event) => setFilter(event.currentTarget.value)}
      />

      <Paper style={{ overflow: 'hidden' }}>
        <ScrollArea.Autosize mah={360}>
          <Table stickyHeader layout="fixed">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>key</Table.Th>
                <Table.Th w={110} ta="right">
                  weight
                </Table.Th>
                <Table.Th w={60} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map(([key, value]) => (
                <Table.Tr key={key}>
                  <Table.Td>
                    <Text size="sm" truncate>
                      {key}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <NumberInput
                      size="xs"
                      value={value}
                      onChange={(next) => onChange({ ...terms, [key]: Number(next) || 0 })}
                      allowDecimal
                      step={1}
                    />
                  </Table.Td>
                  <Table.Td>
                    <Group justify="flex-end">
                      <ActionIcon
                        color="red"
                        aria-label={`remove ${key}`}
                        onClick={() => {
                          const next = { ...terms };
                          delete next[key];
                          onChange(next);
                        }}
                      >
                        <Trash2 size={15} />
                      </ActionIcon>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </ScrollArea.Autosize>
      </Paper>

      <Text size="xs" c="dimmed">
        {Object.keys(terms).length} total
      </Text>
    </Stack>
  );
}

export function RulesPage() {
  const client = useQueryClient();
  const { data, error, isLoading } = useQuery({ queryKey: ['rules'], queryFn: () => api.rules() });

  // A local copy: edits go to the server on Save, not on every keystroke.
  const [draft, setDraft] = useState<Rules | null>(null);
  useEffect(() => {
    if (data) setDraft(data.rules);
  }, [data]);

  const save = useMutation({
    mutationFn: (next: Rules) => api.saveRules(next),
    onSuccess: () => {
      notifications.show({
        color: 'green',
        title: 'Rules saved',
        message: 'Scores are computed on the fly, the lists already use the new weights',
      });
      void client.invalidateQueries({ queryKey: ['rules'] });
    },
    onError: (mutationError) =>
      notifications.show({
        color: 'red',
        title: 'Not saved',
        message: mutationError instanceof Error ? mutationError.message : String(mutationError),
      }),
  });

  const reset = useMutation({
    mutationFn: () => api.resetRules(),
    onSuccess: () => {
      notifications.show({ color: 'green', title: 'Reset', message: 'Default values are back' });
      void client.invalidateQueries({ queryKey: ['rules'] });
    },
  });

  if (error) {
    return (
      <Box p="lg">
        <Alert color="red" title="Could not read the rules">
          {error instanceof Error ? error.message : String(error)}
        </Alert>
      </Box>
    );
  }

  if (isLoading || !draft || !data) {
    return (
      <Stack gap="md" p="lg">
        <Skeleton h={120} />
        <Skeleton h={320} />
      </Stack>
    );
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(data.rules);
  /*
   * The reputation section appeared after the config, so a config already saved from the
   * interface may lack it. The defaults here match the Zod schema on the server.
   */
  const reputation = draft.companies.reputation ?? {
    goodRating: 4.5,
    goodRatingBonus: 2,
    weakRating: 4,
    weakRatingPenalty: -1,
    reviewsFrom: 5,
    reviewsBonus: 1,
    noReviewsPenalty: -1,
  };
  // Same reason and same defaults as the Zod schema: the site section came after the config.
  const site = draft.companies.site ?? {
    buyerKinds: ['smb', 'ecommerce', 'public'],
    perIssue: 2,
    maxIssues: 3,
    noSite: 4,
    modernPlatforms: ['next.js', 'astro', 'nuxt', 'gatsby'],
    fastScore: 80,
    modernFastSite: -4,
  };
  const patchCompanies = (part: Partial<Rules['companies']>) =>
    setDraft({ ...draft, companies: { ...draft.companies, ...part } });

  return (
    <Stack gap="md" p="lg">
      <Paper p="md">
        <Group gap="md">
          <Box>
            <Text size="xs" tt="uppercase" fw={500} c="dimmed" style={{ letterSpacing: '0.04em' }}>
              rules source
            </Text>
            <Text fw={600}>{SOURCE_LABELS[data.source] ?? data.source}</Text>
          </Box>

          <Text size="sm" c="dimmed" maw={420}>
            What is saved here overrides both the file and the bundled values. In production this is
            the only way to change the rules without a deploy: the worker has no filesystem.
          </Text>

          <Group gap="sm" ml="auto">
            {data.source === 'db' && (
              <Tooltip label="drop the interface edits and go back to config/scoring.json">
                <Button
                  variant="default"
                  leftSection={<RotateCcw size={15} />}
                  loading={reset.isPending}
                  onClick={() => reset.mutate()}
                >
                  Reset
                </Button>
              </Tooltip>
            )}
            <Button
              leftSection={<Save size={15} />}
              disabled={!dirty}
              loading={save.isPending}
              onClick={() => save.mutate(draft)}
            >
              {dirty ? 'Save changes' : 'No changes'}
            </Button>
          </Group>
        </Group>
      </Paper>

      <Card>
        <SectionTitle title="Threshold and signals" hint="below the threshold a company stays in the database but is not shown as a lead" />
        <Group gap="xl" align="flex-end">
          <NumberInput
            label="Lead threshold"
            description="sum of the weights below"
            value={draft.companies.threshold}
            onChange={(value) => patchCompanies({ threshold: Number(value) || 0 })}
            w={200}
            allowDecimal
          />
          <NumberInput
            label="Hiring developers"
            description="seen on a board in the last 45 days"
            value={draft.companies.hiring}
            onChange={(value) => patchCompanies({ hiring: Number(value) || 0 })}
            w={200}
            allowDecimal
            allowNegative
          />
          <NumberInput
            label="Has a careers page"
            value={draft.companies.hasCareersPage}
            onChange={(value) => patchCompanies({ hasCareersPage: Number(value) || 0 })}
            w={200}
            allowDecimal
            allowNegative
          />
          <NumberInput
            label="Open tender"
            description="deadline still ahead"
            value={draft.companies.openLead ?? 6}
            onChange={(value) => patchCompanies({ openLead: Number(value) || 0 })}
            w={200}
            allowDecimal
            allowNegative
          />
          <NumberInput
            label="Named contact"
            description="a person with an email"
            value={draft.companies.namedContact ?? 2}
            onChange={(value) => patchCompanies({ namedContact: Number(value) || 0 })}
            w={200}
            allowDecimal
            allowNegative
          />
        </Group>
      </Card>

      <Card>
        <SectionTitle
          title="Site audit"
          hint={`for ${site.buyerKinds.join(', ')}: a weak site is the reason to write, stack weights and the old footer penalty do not apply`}
        />
        <Group gap="lg" align="flex-end" wrap="wrap">
          {(
            [
              ['perIssue', 'Per audit issue', ''],
              ['maxIssues', 'Issues counted', 'at most'],
              ['noSite', 'No site', 'with a phone or email'],
              ['fastScore', 'Fast from', 'PageSpeed score'],
              ['modernFastSite', 'Fresh fast site', site.modernPlatforms.join(', ')],
            ] as const
          ).map(([key, label, description]) => (
            <NumberInput
              key={key}
              label={label}
              description={description || undefined}
              value={site[key]}
              onChange={(value) => patchCompanies({ site: { ...site, [key]: Number(value) || 0 } })}
              w={168}
              allowDecimal
              allowNegative
            />
          ))}
        </Group>
      </Card>

      {/*
        Catalog reputation. These weights used to be editable only in config/scoring.json,
        and Workers has no filesystem, so in production they could not be changed at all.
      */}
      <Card>
        <SectionTitle
          title="Catalog reputation"
          hint="catalog rating and reviews. An empty profile with no reviews often means an abandoned studio"
        />
        <Group gap="lg" align="flex-end" wrap="wrap">
          {(
            [
              ['goodRating', 'High rating from', 'where the bonus starts'],
              ['goodRatingBonus', 'Rating bonus', ''],
              ['weakRating', 'Low rating below', 'under this a penalty applies'],
              ['weakRatingPenalty', 'Rating penalty', ''],
              ['reviewsFrom', 'Reviews from', 'how many reviews count as many'],
              ['reviewsBonus', 'Reviews bonus', ''],
              ['noReviewsPenalty', 'No reviews penalty', ''],
            ] as const
          ).map(([key, label, description]) => (
            <NumberInput
              key={key}
              label={label}
              description={description || undefined}
              value={reputation[key]}
              onChange={(value) => patchCompanies({ reputation: { ...reputation, [key]: Number(value) || 0 } })}
              w={168}
              allowDecimal
              allowNegative
            />
          ))}
        </Group>
      </Card>

      <Card>
        <SectionTitle title="Segment" hint="studio, design, startup, smb, ecommerce, public, product, outstaff, unknown" />
        <TermWeights
          terms={draft.companies.kindWeights}
          onChange={(next) => patchCompanies({ kindWeights: next })}
          placeholder="e.g. smb"
        />
      </Card>

      <Card>
        <SectionTitle title="Industry" hint="lower case, as stored on the company. Niches you sell to go up, excluded ones strongly down" />
        <TermWeights
          terms={draft.companies.industryWeights}
          onChange={(next) => patchCompanies({ industryWeights: next })}
          placeholder="e.g. dental"
        />
      </Card>

      <Card>
        <SectionTitle title="Catalog tags" hint="what the catalogs say a company does: web development, saas, branding" />
        <TermWeights
          terms={draft.companies.tagWeights}
          onChange={(next) => patchCompanies({ tagWeights: next })}
          placeholder="e.g. saas"
        />
      </Card>

      <Card>
        <SectionTitle title="Site stack" hint="what enrichment found on their site. A dated stack is a reason to write" />
        <TermWeights
          terms={draft.companies.techWeights}
          onChange={(next) => patchCompanies({ techWeights: next })}
          placeholder="e.g. wordpress"
        />
      </Card>

      <Card>
        <SectionTitle title="Country" hint="as stored on the company: UA, PL, DE" />
        <TermWeights
          terms={draft.companies.countryWeights}
          onChange={(next) => patchCompanies({ countryWeights: next })}
          placeholder="e.g. UA"
        />
      </Card>

      <Card>
        <SectionTitle title="Size" hint="catalog size buckets" />
        <TermWeights
          terms={draft.companies.sizeWeights}
          onChange={(next) => patchCompanies({ sizeWeights: next })}
          placeholder="e.g. 10 - 49"
        />
      </Card>
    </Stack>
  );
}
