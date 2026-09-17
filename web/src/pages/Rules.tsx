import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Group,
  NumberInput,
  Paper,
  ScrollArea,
  Skeleton,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Ban, Plus, RotateCcw, Save, Search, Trash2 } from 'lucide-react';
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

/**
 * A word list edited in place. Shared by stop words and allowed role names: the
 * behaviour is the same, only the content differs.
 */
function WordList({
  words,
  onChange,
  placeholder,
  tone = 'gray',
}: {
  words: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  tone?: string;
}) {
  const [draft, setDraft] = useState('');
  const [filter, setFilter] = useState('');

  const add = () => {
    const value = draft.trim().toLowerCase();
    if (!value || words.includes(value)) return setDraft('');
    onChange([...words, value].sort());
    setDraft('');
  };

  const shown = filter ? words.filter((word) => word.includes(filter.toLowerCase())) : words;

  return (
    <Stack gap="sm">
      <Group gap="sm">
        <TextInput
          placeholder={placeholder}
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => event.key === 'Enter' && add()}
          style={{ flex: 1 }}
        />
        <Button variant="default" leftSection={<Plus size={15} />} onClick={add}>
          Add
        </Button>
      </Group>

      {words.length > 12 && (
        <TextInput
          placeholder="filter the list"
          leftSection={<Search size={14} />}
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value)}
        />
      )}

      <ScrollArea.Autosize mah={260}>
        <Group gap={6}>
          {shown.length === 0 && (
            <Text size="sm" c="dimmed">
              {words.length === 0 ? 'the list is empty' : 'nothing matches the filter'}
            </Text>
          )}
          {shown.map((word) => (
            <Badge
              key={word}
              color={tone}
              rightSection={
                <ActionIcon
                  size={14}
                  variant="transparent"
                  color={tone}
                  aria-label={`remove ${word}`}
                  onClick={() => onChange(words.filter((item) => item !== word))}
                >
                  <Trash2 size={11} />
                </ActionIcon>
              }
            >
              {word}
            </Badge>
          ))}
        </Group>
      </ScrollArea.Autosize>

      <Text size="xs" c="dimmed">
        {words.length} total
      </Text>
    </Stack>
  );
}

/** Term weights: a table of term plus number, with rows that can be added and removed. */
function TermWeights({
  terms,
  onChange,
}: {
  terms: Record<string, number>;
  onChange: (next: Record<string, number>) => void;
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
          label="Term"
          placeholder="e.g. hono"
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
        placeholder="filter terms"
        leftSection={<Search size={14} />}
        value={filter}
        onChange={(event) => setFilter(event.currentTarget.value)}
      />

      <Paper style={{ overflow: 'hidden' }}>
        <ScrollArea.Autosize mah={360}>
          <Table stickyHeader layout="fixed">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>term</Table.Th>
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
        {Object.keys(terms).length} terms total
      </Text>
    </Stack>
  );
}

export function RulesPage() {
  const client = useQueryClient();
  const { data, error, isLoading } = useQuery({ queryKey: ['rules'], queryFn: () => api.rules() });

  // A local copy: edits are not sent to the server on every keystroke, otherwise every
  // character in the threshold field would trigger a rescore.
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
        message: 'To rescore existing vacancies, use Run, Rescore',
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
  const patch = (part: Partial<Rules>) => setDraft({ ...draft, ...part });

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
        <SectionTitle title="Thresholds" hint="below the threshold a record is kept in the database but not shown in the queue" />
        <Group gap="xl" align="flex-end">
          <NumberInput
            label="Vacancy threshold"
            description="sum of the weights plus the model opinion divided by 20"
            value={draft.threshold}
            onChange={(value) => patch({ threshold: Number(value) || 0 })}
            w={200}
            allowDecimal
          />
          <NumberInput
            label="Company threshold"
            description="for the Studios page"
            value={draft.companies.threshold}
            onChange={(value) =>
              patch({ companies: { ...draft.companies, threshold: Number(value) || 0 } })
            }
            w={200}
            allowDecimal
          />
        </Group>
      </Card>

      {/*
        Studio reputation. These weights used to be editable only in config/scoring.json,
        and Workers has no filesystem, so in production they could not be changed at all.
      */}
      <Card>
        <SectionTitle
          title="Studio reputation"
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
              onChange={(value) =>
                patch({
                  companies: {
                    ...draft.companies,
                    reputation: { ...reputation, [key]: Number(value) || 0 },
                  },
                })
              }
              w={168}
              allowDecimal
              allowNegative
            />
          ))}
        </Group>
      </Card>

      <Card>
        <SectionTitle
          title="Stop words"
          hint="a vacancy with such a word is not classified at all and is stored with score -100"
        />
        <WordList
          words={draft.stopWords}
          onChange={(stopWords) => patch({ stopWords })}
          placeholder="e.g. kotlin"
          tone="red"
        />
      </Card>

      <Card>
        <SectionTitle
          title="Term weights"
          hint="a plus lifts a vacancy, a minus lowers it. In the title the weight is multiplied by the factor below"
        />
        <Group gap="xl" mb="md" align="flex-end">
          <NumberInput
            label="Title multiplier"
            value={draft.weights.titleMultiplier}
            onChange={(value) =>
              patch({ weights: { ...draft.weights, titleMultiplier: Number(value) || 0 } })
            }
            w={180}
            allowDecimal
          />
          <NumberInput
            label="Body score cap"
            value={draft.weights.bodyCap}
            onChange={(value) => patch({ weights: { ...draft.weights, bodyCap: Number(value) || 0 } })}
            w={180}
            allowDecimal
          />
        </Group>
        <TermWeights
          terms={draft.weights.terms}
          onChange={(terms) => patch({ weights: { ...draft.weights, terms } })}
        />
      </Card>

      <Card>
        <SectionTitle
          title="Role title check"
          hint="without it an accountant role at a company whose description mentions React and Next.js scores points and gets into the queue"
        />
        <Switch
          mb="md"
          checked={draft.roleGate.enabled}
          onChange={(event) =>
            patch({ roleGate: { ...draft.roleGate, enabled: event.currentTarget.checked } })
          }
          label="check the vacancy title"
        />

        <Text size="sm" fw={500} mb="xs">
          The title must contain one of these
        </Text>
        <WordList
          words={draft.roleGate.mustMatch}
          onChange={(mustMatch) => patch({ roleGate: { ...draft.roleGate, mustMatch } })}
          placeholder="e.g. platform engineer"
          tone="brand"
        />

        <Text size="sm" fw={500} mt="lg" mb="xs">
          The title must contain none of these
        </Text>
        <WordList
          words={draft.roleGate.neverMatch}
          onChange={(neverMatch) => patch({ roleGate: { ...draft.roleGate, neverMatch } })}
          placeholder="e.g. sales manager"
          tone="red"
        />
      </Card>

      <Alert color="gray" icon={<Ban size={16} />}>
        The rest of the config (geo, experience, company size, studio weights) is not editable
        here and is passed through unchanged. For now it is edited in `config/scoring.json`.
      </Alert>
    </Stack>
  );
}
