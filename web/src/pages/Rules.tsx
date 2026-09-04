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
  db: 'правки з інтерфейсу',
  file: 'config/scoring.json з диска',
  bundled: 'значення за замовчуванням',
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
 * Список слів, який правиться на місці. Спільний для стоп-слів і для дозволених
 * назв ролей: поведінка однакова, різниться лише зміст.
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
          Додати
        </Button>
      </Group>

      {words.length > 12 && (
        <TextInput
          placeholder="фільтр по списку"
          leftSection={<Search size={14} />}
          value={filter}
          onChange={(event) => setFilter(event.currentTarget.value)}
        />
      )}

      <ScrollArea.Autosize mah={260}>
        <Group gap={6}>
          {shown.length === 0 && (
            <Text size="sm" c="dimmed">
              {words.length === 0 ? 'список порожній' : 'під фільтр нічого не підпало'}
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
                  aria-label={`прибрати ${word}`}
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
        усього {words.length}
      </Text>
    </Stack>
  );
}

/** Ваги термінів: таблиця термін плюс число, з можливістю додати і прибрати рядок. */
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
          label="Термін"
          placeholder="напр. hono"
          value={term}
          onChange={(event) => setTerm(event.currentTarget.value)}
          onKeyDown={(event) => event.key === 'Enter' && add()}
          style={{ flex: 1 }}
        />
        <NumberInput label="Вага" value={weight} onChange={setWeight} w={100} allowDecimal step={1} />
        <Button variant="default" leftSection={<Plus size={15} />} onClick={add}>
          Додати
        </Button>
      </Group>

      <TextInput
        placeholder="фільтр по термінах"
        leftSection={<Search size={14} />}
        value={filter}
        onChange={(event) => setFilter(event.currentTarget.value)}
      />

      <Paper style={{ overflow: 'hidden' }}>
        <ScrollArea.Autosize mah={360}>
          <Table stickyHeader layout="fixed">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>термін</Table.Th>
                <Table.Th w={110} ta="right">
                  вага
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
                        aria-label={`прибрати ${key}`}
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
        усього термінів {Object.keys(terms).length}
      </Text>
    </Stack>
  );
}

export function RulesPage() {
  const client = useQueryClient();
  const { data, error, isLoading } = useQuery({ queryKey: ['rules'], queryFn: () => api.rules() });

  // Локальна копія: правки не летять на сервер по кожному натисканню клавіші,
  // інакше кожен символ у полі порогу перераховував би скоринг.
  const [draft, setDraft] = useState<Rules | null>(null);
  useEffect(() => {
    if (data) setDraft(data.rules);
  }, [data]);

  const save = useMutation({
    mutationFn: (next: Rules) => api.saveRules(next),
    onSuccess: () => {
      notifications.show({
        color: 'green',
        title: 'Правила збережено',
        message: 'Щоб перерахувати наявні вакансії, натисни Запустити, Перерахувати рахунки',
      });
      void client.invalidateQueries({ queryKey: ['rules'] });
    },
    onError: (mutationError) =>
      notifications.show({
        color: 'red',
        title: 'Не збереглось',
        message: mutationError instanceof Error ? mutationError.message : String(mutationError),
      }),
  });

  const reset = useMutation({
    mutationFn: () => api.resetRules(),
    onSuccess: () => {
      notifications.show({ color: 'green', title: 'Скинуто', message: 'Вернулись значення за замовчуванням' });
      void client.invalidateQueries({ queryKey: ['rules'] });
    },
  });

  if (error) {
    return (
      <Box p="lg">
        <Alert color="red" title="Не вдалось прочитати правила">
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
  const patch = (part: Partial<Rules>) => setDraft({ ...draft, ...part });

  return (
    <Stack gap="md" p="lg">
      <Paper p="md">
        <Group gap="md">
          <Box>
            <Text size="xs" tt="uppercase" fw={500} c="dimmed" style={{ letterSpacing: '0.04em' }}>
              джерело правил
            </Text>
            <Text fw={600}>{SOURCE_LABELS[data.source] ?? data.source}</Text>
          </Box>

          <Text size="sm" c="dimmed" maw={420}>
            Збережене тут перекриває і файл, і вшиті значення. На проді це єдиний спосіб змінити
            правила без деплою: файлової системи у воркера немає.
          </Text>

          <Group gap="sm" ml="auto">
            {data.source === 'db' && (
              <Tooltip label="прибрати правки з інтерфейсу і вернутись до config/scoring.json">
                <Button
                  variant="default"
                  leftSection={<RotateCcw size={15} />}
                  loading={reset.isPending}
                  onClick={() => reset.mutate()}
                >
                  Скинути
                </Button>
              </Tooltip>
            )}
            <Button
              leftSection={<Save size={15} />}
              disabled={!dirty}
              loading={save.isPending}
              onClick={() => save.mutate(draft)}
            >
              {dirty ? 'Зберегти зміни' : 'Змін немає'}
            </Button>
          </Group>
        </Group>
      </Paper>

      <Card>
        <SectionTitle title="Пороги" hint="нижче порога запис зберігається в базі, але в черзі не показується" />
        <Group gap="xl" align="flex-end">
          <NumberInput
            label="Поріг вакансії"
            description="сума ваг плюс думка моделі, поділена на 20"
            value={draft.threshold}
            onChange={(value) => patch({ threshold: Number(value) || 0 })}
            w={200}
            allowDecimal
          />
          <NumberInput
            label="Поріг компанії"
            description="для сторінки Студії"
            value={draft.companies.threshold}
            onChange={(value) =>
              patch({ companies: { ...draft.companies, threshold: Number(value) || 0 } })
            }
            w={200}
            allowDecimal
          />
        </Group>
      </Card>

      <Card>
        <SectionTitle
          title="Стоп-слова"
          hint="вакансія з таким словом не класифікується взагалі і зберігається з рахунком -100"
        />
        <WordList
          words={draft.stopWords}
          onChange={(stopWords) => patch({ stopWords })}
          placeholder="напр. kotlin"
          tone="red"
        />
      </Card>

      <Card>
        <SectionTitle
          title="Ваги термінів"
          hint="плюс піднімає вакансію, мінус опускає. У назві вага множиться на коефіцієнт нижче"
        />
        <Group gap="xl" mb="md" align="flex-end">
          <NumberInput
            label="Множник для назви"
            value={draft.weights.titleMultiplier}
            onChange={(value) =>
              patch({ weights: { ...draft.weights, titleMultiplier: Number(value) || 0 } })
            }
            w={180}
            allowDecimal
          />
          <NumberInput
            label="Стеля балів з тексту"
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
          title="Перевірка назви ролі"
          hint="без цього бухгалтер з описом компанії, де згадані React і Next.js, набирає балів і лізе в чергу"
        />
        <Switch
          mb="md"
          checked={draft.roleGate.enabled}
          onChange={(event) =>
            patch({ roleGate: { ...draft.roleGate, enabled: event.currentTarget.checked } })
          }
          label="перевіряти назву вакансії"
        />

        <Text size="sm" fw={500} mb="xs">
          Назва мусить містити щось із цього
        </Text>
        <WordList
          words={draft.roleGate.mustMatch}
          onChange={(mustMatch) => patch({ roleGate: { ...draft.roleGate, mustMatch } })}
          placeholder="напр. platform engineer"
          tone="brand"
        />

        <Text size="sm" fw={500} mt="lg" mb="xs">
          Назва не мусить містити нічого з цього
        </Text>
        <WordList
          words={draft.roleGate.neverMatch}
          onChange={(neverMatch) => patch({ roleGate: { ...draft.roleGate, neverMatch } })}
          placeholder="напр. sales manager"
          tone="red"
        />
      </Card>

      <Alert color="gray" icon={<Ban size={16} />}>
        Решта конфіга (гео, досвід, розмір компанії, ваги для студій) тут не редагується і
        передається без змін. Правити її поки що в `config/scoring.json`.
      </Alert>
    </Stack>
  );
}
