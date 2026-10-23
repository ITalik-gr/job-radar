import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ActionIcon,
  Alert,
  Anchor,
  Button,
  Group,
  NumberInput,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  Briefcase,
  Building2,
  Code,
  Gauge,
  Globe,
  Landmark,
  ListChecks,
  Plus,
  RotateCcw,
  Save,
  Search,
  SlidersHorizontal,
  Sparkles,
  Star,
  Store,
  Tag,
  Trash2,
  TrendingUp,
  UserRound,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { api, type Rules } from '../lib/api';
import { PageHeader, SectionHeader } from '../components/ui';

const SOURCE_LABELS: Record<string, string> = {
  db: 'edits from the interface',
  file: 'config/scoring.json on disk',
  bundled: 'default values',
};

/** A rules section: an icon header, one line on what it does, then the fields. */
function Section({
  icon,
  title,
  hint,
  color,
  children,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
  color?: string;
  children: ReactNode;
}) {
  return (
    <Paper p="md">
      <SectionHeader icon={icon} title={title} color={color} />
      <Text size="sm" c="gray.7" mt={-4} mb="md">
        {hint}
      </Text>
      {children}
    </Paper>
  );
}

/** How many rows a weight table shows before "show all": no scroll box inside the page scroll. */
const TABLE_ROWS = 10;

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
  const [all, setAll] = useState(false);

  const rows = useMemo(
    () =>
      Object.entries(terms)
        .filter(([key]) => !filter || key.includes(filter.toLowerCase()))
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    [terms, filter],
  );
  const shown = all || filter ? rows : rows.slice(0, TABLE_ROWS);

  const add = () => {
    const key = term.trim().toLowerCase();
    if (!key) return;
    onChange({ ...terms, [key]: Number(weight) || 0 });
    setTerm('');
  };

  return (
    <Stack gap="sm">
      <Group gap="sm" align="flex-end" wrap="nowrap">
        <TextInput
          label="Key"
          placeholder={placeholder}
          value={term}
          onChange={(event) => setTerm(event.currentTarget.value)}
          onKeyDown={(event) => event.key === 'Enter' && add()}
          style={{ flex: 1 }}
        />
        <NumberInput label="Weight" value={weight} onChange={setWeight} w={90} allowDecimal step={1} />
        <Button variant="default" leftSection={<Plus size={15} />} onClick={add}>
          Add
        </Button>
      </Group>

      {Object.keys(terms).length > TABLE_ROWS && (
        <TextInput
          placeholder="filter"
          leftSection={<Search size={14} />}
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value)}
        />
      )}

      <Paper style={{ overflow: 'hidden' }}>
        <Table layout="fixed">
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
            {shown.map(([key, value]) => (
              <Table.Tr key={key}>
                <Table.Td>
                  <Text size="sm" className="mono" truncate>
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
                      variant="subtle"
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
      </Paper>

      <Group gap="sm">
        <Text size="xs" c="dimmed" className="mono">
          {Object.keys(terms).length} total
        </Text>
        {!filter && rows.length > TABLE_ROWS && (
          <Anchor component="button" size="xs" onClick={() => setAll((value) => !value)}>
            {all ? 'show the top ten' : `show all ${rows.length}`}
          </Anchor>
        )}
      </Group>
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

  if (error || isLoading || !draft || !data) {
    return (
      <>
        <PageHeader icon={SlidersHorizontal} title="Rules" />
        {error ? (
          <Alert color="red" m="lg" title="Could not read the rules">
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

  const modelFit = draft.companies.modelFit ?? { likely: 4, possible: 0, unlikely: -3, no: -8 };
  const queue = draft.queue ?? { size: 10 };

  return (
    <>
      <PageHeader
        icon={SlidersHorizontal}
        title="Rules"
        description={
          <>
            Lead scoring weights. Source:{' '}
            <Tooltip
              label="What is saved here overrides both the file and the bundled values. In production this is the only way to change the rules without a deploy: the worker has no filesystem."
              multiline
              maw={320}
            >
              <Text span fw={600} c="ink">
                {SOURCE_LABELS[data.source] ?? data.source}
              </Text>
            </Tooltip>
          </>
        }
      >
        {data.source === 'db' && (
          <Tooltip label="drop the interface edits and go back to config/scoring.json">
            <Button leftSection={<RotateCcw size={15} />} loading={reset.isPending} onClick={() => reset.mutate()}>
              Reset
            </Button>
          </Tooltip>
        )}
        <Button
          variant="filled"
          leftSection={<Save size={15} />}
          disabled={!dirty}
          loading={save.isPending}
          onClick={() => save.mutate(draft)}
        >
          {dirty ? 'Save changes' : 'No changes'}
        </Button>
      </PageHeader>

      <Stack gap="md" p="lg" maw={1200}>
        <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
          <Section
            icon={ListChecks}
            title="Threshold and queue"
            color="ink"
            hint="Below the threshold a company stays in the database but is not shown as a lead."
          >
            <Group gap="md" align="flex-end">
              <NumberInput
                label="Lead threshold"
                description="sum of the weights"
                value={draft.companies.threshold}
                onChange={(value) => patchCompanies({ threshold: Number(value) || 0 })}
                w={168}
                allowDecimal
              />
              <NumberInput
                label="Today, companies"
                description="the daily slice size"
                value={queue.size}
                onChange={(value) => setDraft({ ...draft, queue: { ...queue, size: Number(value) || 1 } })}
                w={168}
                min={1}
                max={50}
              />
            </Group>
          </Section>

          <Section
            icon={Sparkles}
            title="Model fit"
            color="violet"
            hint="How much the model's read counts: would this company pay an outside developer. 0 turns a level off."
          >
            <Group gap="md" align="flex-end">
              {(['likely', 'possible', 'unlikely', 'no'] as const).map((level) => (
                <NumberInput
                  key={level}
                  label={level}
                  value={modelFit[level]}
                  onChange={(value) => patchCompanies({ modelFit: { ...modelFit, [level]: Number(value) || 0 } })}
                  w={92}
                  allowDecimal
                  allowNegative
                />
              ))}
            </Group>
          </Section>
        </SimpleGrid>

        <Section icon={TrendingUp} title="Signals" color="green" hint="Things that say a company needs work done right now.">
          <Group gap="md" align="flex-end">
            <NumberInput
              label="Hiring developers"
              description="seen on a board, 45 days"
              value={draft.companies.hiring}
              onChange={(value) => patchCompanies({ hiring: Number(value) || 0 })}
              w={168}
              leftSection={<Briefcase size={14} />}
              allowDecimal
              allowNegative
            />
            <NumberInput
              label="Has a careers page"
              description="on their own site"
              value={draft.companies.hasCareersPage}
              onChange={(value) => patchCompanies({ hasCareersPage: Number(value) || 0 })}
              w={168}
              allowDecimal
              allowNegative
            />
            <NumberInput
              label="Open tender"
              description="deadline still ahead"
              value={draft.companies.openLead ?? 6}
              onChange={(value) => patchCompanies({ openLead: Number(value) || 0 })}
              w={168}
              leftSection={<Landmark size={14} />}
              allowDecimal
              allowNegative
            />
            <NumberInput
              label="Tender fit from"
              description="model rating, 0 to 100"
              value={draft.companies.minLeadFit ?? 50}
              onChange={(value) => patchCompanies({ minLeadFit: Number(value) || 0 })}
              w={168}
              min={0}
              max={100}
            />
            <NumberInput
              label="Named contact"
              description="a person with an email"
              value={draft.companies.namedContact ?? 2}
              onChange={(value) => patchCompanies({ namedContact: Number(value) || 0 })}
              w={168}
              leftSection={<UserRound size={14} />}
              allowDecimal
              allowNegative
            />
          </Group>
        </Section>

        <Section
          icon={Gauge}
          title="Site audit"
          color="red"
          hint={`For ${site.buyerKinds.join(', ')}: a weak site is the reason to write, stack weights and the old footer penalty do not apply.`}
        >
          <Group gap="md" align="flex-end" wrap="wrap">
            {(
              [
                ['perIssue', 'Per audit issue', 'each one found'],
                ['maxIssues', 'Issues counted', 'at most'],
                ['noSite', 'No site', 'with a phone or email'],
                ['fastScore', 'Fast from', 'PageSpeed score'],
                ['modernFastSite', 'Fresh fast site', site.modernPlatforms.join(', ')],
              ] as const
            ).map(([key, label, description]) => (
              <NumberInput
                key={key}
                label={label}
                description={description}
                value={site[key]}
                onChange={(value) => patchCompanies({ site: { ...site, [key]: Number(value) || 0 } })}
                w={168}
                allowDecimal
                allowNegative
              />
            ))}
          </Group>
        </Section>

        {/*
          Catalog reputation. These weights used to be editable only in config/scoring.json,
          and Workers has no filesystem, so in production they could not be changed at all.
        */}
        <Section
          icon={Star}
          title="Catalog reputation"
          color="yellow"
          hint="Catalog rating and reviews. An empty profile with no reviews often means an abandoned studio."
        >
          <Group gap="md" align="flex-end" wrap="wrap">
            {(
              [
                ['goodRating', 'High rating from', 'where the bonus starts'],
                ['goodRatingBonus', 'Rating bonus', 'added'],
                ['weakRating', 'Low rating below', 'a penalty applies'],
                ['weakRatingPenalty', 'Rating penalty', 'added'],
                ['reviewsFrom', 'Reviews from', 'counts as many'],
                ['reviewsBonus', 'Reviews bonus', 'added'],
                ['noReviewsPenalty', 'No reviews penalty', 'added'],
              ] as const
            ).map(([key, label, description]) => (
              <NumberInput
                key={key}
                label={label}
                description={description}
                value={reputation[key]}
                onChange={(value) => patchCompanies({ reputation: { ...reputation, [key]: Number(value) || 0 } })}
                w={168}
                allowDecimal
                allowNegative
              />
            ))}
          </Group>
        </Section>

        <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
          {(
            [
              ['kindWeights', Building2, 'Segment', 'studio, design, startup, smb, ecommerce, public, product, outstaff, unknown.', 'e.g. smb'],
              ['industryWeights', Store, 'Industry', 'As stored on the company. Niches you sell to go up, excluded ones strongly down.', 'e.g. dental'],
              ['tagWeights', Tag, 'Catalog tags', 'What the catalogs say a company does: web development, saas, branding.', 'e.g. saas'],
              ['techWeights', Code, 'Site stack', 'What enrichment found on their site. A dated stack is a reason to write.', 'e.g. wordpress'],
              ['countryWeights', Globe, 'Country', 'ISO codes as stored on the company: UA, PL, DE.', 'e.g. UA'],
              ['sizeWeights', Users, 'Size', 'Catalog size buckets.', 'e.g. 10 - 49'],
            ] as const
          ).map(([key, icon, title, hint, placeholder]) => (
            <Section key={key} icon={icon} title={title} hint={hint}>
              <TermWeights
                terms={draft.companies[key]}
                onChange={(next) => patchCompanies({ [key]: next })}
                placeholder={placeholder}
              />
            </Section>
          ))}
        </SimpleGrid>
      </Stack>
    </>
  );
}
