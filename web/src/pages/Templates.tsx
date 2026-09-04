import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Badge,
  Box,
  Button,
  EmptyState,
  Group,
  Modal,
  Paper,
  ScrollArea,
  Select,
  Skeleton,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Archive, FileText, Plus, Save } from 'lucide-react';
import { api, formatDate, type TemplateRow } from '../lib/api';
import { LETTER_PLACEHOLDERS } from '../../../src/lib/letter';
import { PaneFooter, PaneHeader, SplitView } from '../components/SplitView';

const KIND_LABELS: Record<string, string> = {
  vacancy: 'під вакансію',
  studio: 'під студію',
  resume: 'резюме',
};

const KIND_OPTIONS = Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }));

/** Типи компаній із `src/pipeline/company-kind.ts`. Порожнє означає універсальний шаблон. */
const FOR_KIND_OPTIONS = [
  { value: 'design', label: 'дизайн-студія' },
  { value: 'studio', label: 'студія розробки' },
  { value: 'startup', label: 'стартап' },
  { value: 'outstaff', label: 'аутстаф' },
  { value: 'product', label: 'продуктова компанія' },
];

function Row({
  row,
  active,
  onSelect,
}: {
  row: TemplateRow;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <UnstyledButton
      onClick={onSelect}
      px="md"
      py="sm"
      w="100%"
      style={{
        display: 'block',
        textAlign: 'left',
        borderBottom: '1px solid var(--mantine-color-gray-2)',
        borderLeft: `3px solid ${active ? 'var(--mantine-color-brand-6)' : 'transparent'}`,
        background: active ? 'var(--mantine-color-brand-0)' : undefined,
      }}
    >
      <Group gap="xs" wrap="nowrap">
        <Text size="sm" fw={600} truncate style={{ flex: 1, minWidth: 0 }}>
          {row.name}
        </Text>
        {row.archived && (
          <Badge size="xs" color="gray">
            в архіві
          </Badge>
        )}
      </Group>
      <Group gap={6} mt={4} wrap="nowrap">
        <Badge size="xs" color={row.kind === 'resume' ? 'brand' : 'gray'}>
          {KIND_LABELS[row.kind] ?? row.kind}
        </Badge>
        <Text size="xs" c="dimmed" truncate>
          {row.body ? `${row.body.length} символів` : 'текст не написаний'}
        </Text>
      </Group>
    </UnstyledButton>
  );
}

function Editor({ row }: { row: TemplateRow }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState(row);

  useEffect(() => setDraft(row), [row]);

  const save = useMutation({
    mutationFn: () =>
      api.updateTemplate(row.id, {
        name: draft.name,
        kind: draft.kind,
        forKind: draft.forKind,
        subject: draft.subject,
        body: draft.body,
        note: draft.note,
      }),
    onSuccess: () => {
      notifications.show({ color: 'green', title: draft.name, message: 'шаблон збережено' });
      void client.invalidateQueries({ queryKey: ['templates'] });
    },
    onError: (error) =>
      notifications.show({
        color: 'red',
        title: 'Не збереглось',
        message: error instanceof Error ? error.message : String(error),
      }),
  });

  const archive = useMutation({
    mutationFn: () => api.archiveTemplate(row.id),
    onSuccess: () => {
      notifications.show({ color: 'green', title: draft.name, message: 'в архіві' });
      void client.invalidateQueries({ queryKey: ['templates'] });
    },
  });

  const dirty =
    draft.name !== row.name ||
    draft.kind !== row.kind ||
    draft.forKind !== row.forKind ||
    (draft.subject ?? '') !== (row.subject ?? '') ||
    draft.body !== row.body ||
    (draft.note ?? '') !== (row.note ?? '');

  return (
    <>
      <ScrollArea style={{ flex: 1, minHeight: 0 }}>
        <Box p="lg" maw={860}>
          <Group gap="sm" mb="xs">
            <Text size="sm" c="dimmed" ff="monospace">
              {row.slug}
            </Text>
            <Tooltip label="цей ключ лягає в історію листування, тому не змінюється разом із назвою">
              <Badge size="sm" color="gray">
                незмінний ключ
              </Badge>
            </Tooltip>
            <Text size="xs" c="dimmed" ml="auto">
              оновлено {formatDate(row.updatedAt)}
            </Text>
          </Group>

          <Stack gap="md">
            <Group gap="md" grow>
              <TextInput
                label="Назва"
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
              />
              <Select
                label="Тип"
                data={KIND_OPTIONS}
                value={draft.kind}
                onChange={(kind) => kind && setDraft({ ...draft, kind })}
                allowDeselect={false}
              />
              <Select
                label="Під який тип компанії"
                description="цей шаблон пропонуватиметься першим"
                data={FOR_KIND_OPTIONS}
                value={draft.forKind}
                onChange={(forKind) => setDraft({ ...draft, forKind })}
                placeholder="універсальний"
                clearable
              />
            </Group>

            <TextInput
              label="Тема листа"
              description="для резюме можна лишити порожнім"
              value={draft.subject ?? ''}
              onChange={(event) => setDraft({ ...draft, subject: event.currentTarget.value })}
            />

            <Textarea
              label="Текст"
              description="твій текст, інструмент його не генерує і не переписує"
              autosize
              minRows={12}
              maxRows={28}
              value={draft.body}
              onChange={(event) => setDraft({ ...draft, body: event.currentTarget.value })}
              styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 13 } }}
            />

            {/*
              Плейсхолдери мусять бути перед очима під час написання: інакше власник
              або не знає, що вони є, або друкує з помилкою і бачить порожнє місце.
            */}
            <Box>
              <Text size="sm" fw={500} mb={6}>
                Що можна вставити в текст і в тему
              </Text>
              <Group gap={6}>
                {LETTER_PLACEHOLDERS.map((item) => (
                  <Tooltip key={item.token} label={item.hint}>
                    <Badge
                      color="gray"
                      style={{ cursor: 'pointer', fontFamily: 'var(--mantine-font-family-monospace)' }}
                      onClick={() => setDraft({ ...draft, body: `${draft.body}{{${item.token}}}` })}
                    >
                      {`{{${item.token}}}`}
                    </Badge>
                  </Tooltip>
                ))}
              </Group>
              <Text size="xs" c="dimmed" mt={6}>
                Натисни, щоб додати в кінець тексту. Порожні значення підставляться як
                порожнє місце, і перед відправкою радар про це попередить.
              </Text>
            </Box>

            <Textarea
              label="Примітка для себе"
              description="коли цей шаблон доречний, що в ньому не працює"
              autosize
              minRows={2}
              value={draft.note ?? ''}
              onChange={(event) => setDraft({ ...draft, note: event.currentTarget.value })}
            />
          </Stack>
        </Box>
      </ScrollArea>

      <PaneFooter>
        <Button
          leftSection={<Save size={15} />}
          disabled={!dirty}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          {dirty ? 'Зберегти' : 'Змін немає'}
        </Button>

        {!row.archived && (
          <Tooltip label="прибрати зі списків вибору. Запис не стирається: мітка лишається в історії листування">
            <Button
              variant="default"
              ml="auto"
              leftSection={<Archive size={15} />}
              loading={archive.isPending}
              onClick={() => archive.mutate()}
            >
              В архів
            </Button>
          </Tooltip>
        )}
      </PaneFooter>
    </>
  );
}

export function TemplatesPage() {
  const client = useQueryClient();
  const [selected, setSelected] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('vacancy');

  const { data, error, isLoading } = useQuery({ queryKey: ['templates'], queryFn: () => api.templates() });

  const create = useMutation({
    mutationFn: () => api.createTemplate({ name, kind }),
    onSuccess: (row) => {
      notifications.show({ color: 'green', title: row.name, message: 'шаблон створено' });
      setCreating(false);
      setName('');
      setSelected(row.id);
      void client.invalidateQueries({ queryKey: ['templates'] });
    },
    onError: (mutationError) =>
      notifications.show({
        color: 'red',
        title: 'Не створився',
        message: mutationError instanceof Error ? mutationError.message : String(mutationError),
      }),
  });

  if (error) {
    return (
      <Box p="lg">
        <Alert color="red" title="Не вдалось прочитати шаблони">
          {error instanceof Error ? error.message : String(error)}
        </Alert>
      </Box>
    );
  }

  const rows = data?.templates ?? [];
  const current = rows.find((row) => row.id === selected) ?? rows.find((row) => !row.archived) ?? rows[0];

  return (
    <>
      <Modal opened={creating} onClose={() => setCreating(false)} title="Новий шаблон">
        <Stack gap="md">
          <TextInput
            data-autofocus
            label="Назва"
            placeholder="напр. Пітч під AI-інтеграції"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            onKeyDown={(event) => event.key === 'Enter' && name.trim() && create.mutate()}
          />
          <Select
            label="Тип"
            data={KIND_OPTIONS}
            value={kind}
            onChange={(value) => value && setKind(value)}
            allowDeselect={false}
          />
          <Text size="xs" c="dimmed">
            Ключ для історії листування зробиться з назви автоматично і далі не змінюватиметься.
          </Text>
          <Button disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>
            Створити
          </Button>
        </Stack>
      </Modal>

      <SplitView
        listWidth={340}
        list={
          <>
            <PaneHeader>
              <Title order={5} style={{ flex: 1 }}>
                Шаблони
              </Title>
              <Button variant="default" leftSection={<Plus size={15} />} onClick={() => setCreating(true)}>
                Новий
              </Button>
            </PaneHeader>

            <ScrollArea style={{ flex: 1, minHeight: 0 }}>
              {isLoading && Array.from({ length: 6 }, (_, i) => <Skeleton key={i} h={64} m="md" />)}
              {rows.map((row) => (
                <Row key={row.id} row={row} active={current?.id === row.id} onSelect={() => setSelected(row.id)} />
              ))}
            </ScrollArea>
          </>
        }
        detail={
          current ? (
            <Editor key={current.id} row={current} />
          ) : (
            <Box p="xl" style={{ flex: 1, display: 'grid', placeItems: 'center' }}>
              <EmptyState
                icon={<FileText size={28} />}
                withIndicatorBackground
                title={isLoading ? 'Читаю шаблони' : 'Шаблонів немає'}
                description="Створи перший: текст пишеш ти, інструмент його лише зберігає і підставляє в історію контактів."
              />
            </Box>
          )
        }
      />
    </>
  );
}
