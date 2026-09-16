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
import { Archive, ArchiveRestore, Copy, FileText, Plus, Save, Trash2 } from 'lucide-react';
import { FactsPanel } from '../components/FactsPanel';
import { api, formatDate, type TemplateRow } from '../lib/api';
import { COMPANY_KINDS, type CompanyKind } from '../../../src/pipeline/company-kind';
import type { Language, OutreachTarget } from '../../../src/pipeline/outreach';
import type { TemplateKind } from '../../../src/pipeline/templates';
import { LETTER_PLACEHOLDERS } from '../../../src/lib/letter';
import { PaneFooter, PaneHeader, SplitView } from '../components/SplitView';
import { useSelection } from '../lib/useRoute';

/*
 * Підписи ключами від справжніх типів, а не вільними рядками. Record по юніону
 * означає, що новий тип компанії або нова роль у розсилці ламають збірку тут,
 * доки їх не додали в список. Раніше ці переліки жили самі по собі і відставали
 * від коду мовчки: у базі тип уже був, а в селекті його не було.
 *
 * Імпорти саме типів, тому файли пайплайна з базою в бандл фронта не тягнуться.
 */
const KIND_LABELS: Record<TemplateKind, string> = {
  vacancy: 'під вакансію',
  studio: 'під студію',
  resume: 'резюме',
};

const KIND_OPTIONS = Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }));

/**
 * Роль у розсилці. Саме за нею чернетка вибирає шаблон, і вибір робить код:
 * є вакансія, є іменний контакт, або тільки загальна скринька.
 */
const TARGET_LABELS: Record<OutreachTarget, string> = {
  vacancy: 'є відкрита вакансія',
  studio_named: 'без вакансії, іменний контакт',
  studio_generic: 'без вакансії, загальна пошта',
  followup: 'фолоу-ап, другий лист у треді',
};

const TARGET_OPTIONS = Object.entries(TARGET_LABELS).map(([value, label]) => ({ value, label }));

const LANGUAGE_OPTIONS: { value: Language; label: string }[] = [
  { value: 'en', label: 'англійською' },
  { value: 'uk', label: 'українською' },
];

/**
 * Порожній `forKind` означає "будь-який тип". Це окремий пункт списку, а не хрестик
 * очищення збоку: універсальний шаблон це свідомий вибір, і він мусить читатись
 * у полі так само, як решта варіантів.
 */
const ANY_KIND = '__any';

const FOR_KIND_LABELS: Record<CompanyKind, string> = {
  studio: 'студія розробки',
  design: 'дизайн-студія',
  startup: 'стартап',
  product: 'продуктова компанія',
  outstaff: 'аутстаф',
  // Такий тип реально стоїть у частини компаній, і під нього теж пишеться лист.
  unknown: 'тип не визначено',
};

const FOR_KIND_OPTIONS = [
  { value: ANY_KIND, label: 'універсальний, будь-який тип' },
  ...COMPANY_KINDS.map((value) => ({ value, label: FOR_KIND_LABELS[value] })),
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
          {KIND_LABELS[row.kind as TemplateKind] ?? row.kind}
        </Badge>
        {/* Шаблон із роллю бере участь у розсилці сам, решта тільки для копіювання. */}
        {row.targetType && (
          <Badge size="xs" color="blue" variant="light">
            розсилка, {row.language}
          </Badge>
        )}
        <Text size="xs" c="dimmed" truncate>
          {row.body ? `${row.body.length} символів` : 'текст не написаний'}
        </Text>
        {/* Скільки листів уже написано цим шаблоном: видно, що робоче, а що чернетка. */}
        {row.usageCount > 0 && (
          <Badge size="xs" color="brand" variant="light">
            {row.usageCount} лист{row.usageCount === 1 ? '' : 'ів'}
          </Badge>
        )}
      </Group>
    </UnstyledButton>
  );
}

/**
 * Поля, які редагуються в цій формі. Перелік один на два вжитки: з нього збирається
 * і те, що йде на сервер, і ознака "є незбережені зміни".
 *
 * Раніше це були два списки полів, написані руками в різних місцях, і вони розʼїхались:
 * мова, роль у розсилці і перший абзац не потрапили ні в один, ні в другий. Кнопка
 * лишалась сірою, а якщо натиснути її через зміну в іншому полі, значення селектів
 * тихо не доїжджали до бази і поверталися старими.
 */
const EDITABLE = [
  'name',
  'slug',
  'kind',
  'forKind',
  'subject',
  'intro',
  'body',
  'note',
  'language',
  'targetType',
] as const satisfies readonly (keyof TemplateRow)[];

function patchFrom(draft: TemplateRow): Record<string, unknown> {
  return Object.fromEntries(EDITABLE.map((field) => [field, draft[field]]));
}

function Editor({
  row,
  all,
  onSelect,
}: {
  row: TemplateRow;
  /** Решта шаблонів: потрібна, щоб побачити зіткнення ролей у розсилці. */
  all: TemplateRow[];
  onSelect: (id: number | null) => void;
}) {
  const client = useQueryClient();
  const [draft, setDraft] = useState(row);
  const [confirming, setConfirming] = useState(false);

  /*
   * Скидання чернетки прив'язане до `updatedAt`, а не до самого об'єкта. Список
   * шаблонів перечитується після будь-якої мутації, і кожен перечит давав новий
   * об'єкт: недописаний текст в редакторі затирався тим, що вже лежить у базі.
   */
  useEffect(() => {
    setDraft(row);
    setConfirming(false);
  }, [row.id, row.updatedAt]);

  const save = useMutation({
    mutationFn: () => api.updateTemplate(row.id, patchFrom(draft)),
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

  const fail = (error: unknown) =>
    notifications.show({
      color: 'red',
      title: 'Не вийшло',
      message: error instanceof Error ? error.message : String(error),
    });

  const archive = useMutation({
    mutationFn: () => (row.archived ? api.restoreTemplate(row.id) : api.archiveTemplate(row.id)),
    onSuccess: () => {
      notifications.show({
        color: 'green',
        title: draft.name,
        message: row.archived ? 'повернуто з архіву' : 'в архіві',
      });
      void client.invalidateQueries({ queryKey: ['templates'] });
    },
    onError: fail,
  });

  const duplicate = useMutation({
    mutationFn: () => api.duplicateTemplate(row.id),
    onSuccess: (copy) => {
      notifications.show({ color: 'green', title: copy.name, message: 'копію створено' });
      void client.invalidateQueries({ queryKey: ['templates'] });
      onSelect(copy.id);
    },
    onError: fail,
  });

  const remove = useMutation({
    mutationFn: () => api.deleteTemplate(row.id),
    onSuccess: (result) => {
      notifications.show({
        color: 'green',
        title: draft.name,
        message:
          result.keptInHistory > 0
            ? `видалено. У Контактах лишилось ${result.keptInHistory} записів з ключем ${result.slug}`
            : 'видалено',
      });
      setConfirming(false);
      void client.invalidateQueries({ queryKey: ['templates'] });
      void client.invalidateQueries({ queryKey: ['outreach'] });
      onSelect(null);
    },
    onError: fail,
  });

  const dirty = EDITABLE.some((field) => (draft[field] ?? '') !== (row[field] ?? ''));

  /*
   * Розсилка бере перший шаблон із потрібною парою роль плюс мова. Два таких шаблони
   * не помилка на рівні бази, але вибір між ними стає випадковим, і власник не зрозуміє,
   * чому лист пішов не тим текстом. Тому це показується прямо в редакторі.
   */
  const clash = draft.targetType
    ? all.find(
        (other) =>
          other.id !== row.id &&
          !other.archived &&
          other.targetType === draft.targetType &&
          other.language === draft.language,
      )
    : undefined;

  return (
    <>
      <ScrollArea style={{ flex: 1, minHeight: 0 }}>
        <Box p="lg" maw={860}>
          <Group gap="sm" mb="xs">
            {row.archived && (
              <Badge size="sm" color="gray">
                в архіві
              </Badge>
            )}
            <Badge size="sm" color={row.usageCount > 0 ? 'brand' : 'gray'} variant="light">
              {row.usageCount > 0 ? `написано ${row.usageCount}` : 'ще не використовувався'}
            </Badge>
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
                value={draft.forKind ?? ANY_KIND}
                onChange={(value) =>
                  value && setDraft({ ...draft, forKind: value === ANY_KIND ? null : value })
                }
                allowDeselect={false}
              />
            </Group>

            {/*
              Роль і мова це не оформлення, а те, за чим чернетка вибирає шаблон.
              Порожня роль означає, що шаблон у розсилці не бере участі і лежить
              для ручного копіювання, і це нормальний стан для половини списку.
            */}
            <Group grow align="start">
              <Select
                label="Роль у розсилці"
                description="коли цей шаблон підставляється автоматично"
                data={TARGET_OPTIONS}
                value={draft.targetType}
                onChange={(targetType) => setDraft({ ...draft, targetType })}
                placeholder="не бере участі, тільки копіювання руками"
                clearable
              />
              <Select
                label="Мова"
                description="uk для компаній з України, en для решти"
                data={LANGUAGE_OPTIONS}
                value={draft.language}
                onChange={(language) => language && setDraft({ ...draft, language })}
                allowDeselect={false}
              />
            </Group>

            {clash && (
              <Alert color="yellow">
                Та сама роль і мова вже стоять у шаблоні <b>{clash.name}</b>. Розсилка візьме
                один із двох, і який саме, передбачити не можна. Прибери роль в одного або
                відправ його в архів.
              </Alert>
            )}

            {/*
              Ключ редагується, і при зміні радар переписує його в записах листування.
              Тому підпис каже саме це: інакше правка виглядала б як розрив історії.
            */}
            <TextInput
              label="Ключ для історії"
              description={
                row.usageCount > 0
                  ? `лягає в Контакти. Якщо змінити, ${row.usageCount} записів історії перепишуться на новий ключ`
                  : 'лягає в Контакти. Пробіли і регістр приводяться до нижнього підкреслення'
              }
              value={draft.slug}
              onChange={(event) => setDraft({ ...draft, slug: event.currentTarget.value })}
              styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
            />

            <TextInput
              label="Тема листа"
              description="для резюме можна лишити порожнім"
              value={draft.subject ?? ''}
              onChange={(event) => setDraft({ ...draft, subject: event.currentTarget.value })}
            />

            <Textarea
              label="Перший абзац, статичний"
              description="підставляється замість {{intro}}. Мітки тут працюють так само, як у тексті. Його ж бере відкат, коли абзац від моделі не пройшов перевірку"
              autosize
              minRows={2}
              maxRows={6}
              value={draft.intro ?? ''}
              onChange={(event) => setDraft({ ...draft, intro: event.currentTarget.value })}
              styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 13 } }}
            />

            {/*
              Абзац без мітки в тілі нікуди не потрапляє. Мовчати про це не можна:
              на вигляд поле заповнене, а в листі його немає.
            */}
            {draft.intro?.trim() && !/\{\{\s*intro\s*\}\}/i.test(draft.body) && (
              <Alert color="yellow">
                Перший абзац написаний, але в тексті немає мітки {'{{intro}}'}, тому в лист він не
                потрапить. Додай мітку туди, де має стояти цей абзац.
              </Alert>
            )}

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

        {/* Факти живуть поруч із текстом листа, бо саме на нього вони і впливають. */}
        <FactsPanel />

        <Tooltip label="зробити варіант цього тексту з власним ключем">
          <Button
            variant="default"
            leftSection={<Copy size={15} />}
            loading={duplicate.isPending}
            onClick={() => duplicate.mutate()}
          >
            Дублювати
          </Button>
        </Tooltip>

        <Group gap="sm" ml="auto" wrap="nowrap">
          <Tooltip
            label={
              row.archived
                ? 'повернути в списки вибору'
                : 'прибрати зі списків вибору. Шаблон лишається і його можна повернути'
            }
          >
            <Button
              variant="default"
              leftSection={row.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
              loading={archive.isPending}
              onClick={() => archive.mutate()}
            >
              {row.archived ? 'З архіву' : 'В архів'}
            </Button>
          </Tooltip>

          <Tooltip label="стерти назовсім. Записи в Контактах лишаться, там ключ це знімок">
            <Button
              variant="subtle"
              color="red"
              leftSection={<Trash2 size={15} />}
              onClick={() => setConfirming(true)}
            >
              Видалити
            </Button>
          </Tooltip>
        </Group>
      </PaneFooter>

      {/*
        Підтвердження показує, скільки листів написано цим ключем. Без цього числа
        видалення сліпе: чернетку і робочий шаблон на вигляд не відрізнити.
      */}
      <Modal opened={confirming} onClose={() => setConfirming(false)} title={`Видалити ${row.name}?`}>
        <Stack gap="md">
          <Text size="sm">
            Шаблон зникне назовсім. Текст не відновити, тому якщо він ще може знадобитись, краще
            відправити його в архів.
          </Text>
          {row.usageCount > 0 && (
            <Alert color="yellow">
              Цим шаблоном написано {row.usageCount} листів. Записи в Контактах лишаться на місці:
              там зберігається ключ <b>{row.slug}</b> на момент листа, а не посилання на шаблон.
            </Alert>
          )}
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={() => setConfirming(false)}>
              Скасувати
            </Button>
            <Button color="red" loading={remove.isPending} onClick={() => remove.mutate()}>
              Видалити назовсім
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

/**
 * Підпис живе окремо від тексту шаблонів.
 *
 * Він однаковий у всіх листах, і правити його в десяти шаблонах по черзі означає
 * рано чи пізно розійтись у них між собою. У тілі шаблона його місце позначається
 * міткою {{signature}}, а шаблон без мітки отримує підпис у кінець сам: старі
 * шаблони писались до її появи, і лишати їх без підпису не можна.
 */
function SignatureModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const { data } = useQuery({ queryKey: ['signature'], queryFn: () => api.signature() });
  const [value, setValue] = useState('');

  useEffect(() => {
    if (data) setValue(data.signature);
  }, [data]);

  const save = useMutation({
    mutationFn: () => api.saveSignature(value),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['signature'] });
      notifications.show({ color: 'green', title: 'Підпис', message: 'збережено' });
      onClose();
    },
    onError: (error: Error) =>
      notifications.show({ color: 'red', title: 'не збереглось', message: error.message }),
  });

  return (
    <Modal opened={opened} onClose={onClose} title="Підпис у листах">
      <Stack gap="md">
        <Textarea
          autosize
          minRows={3}
          maxRows={8}
          label="текст підпису"
          description="ставиться на місце {{signature}}, а якщо мітки в шаблоні немає, дописується в кінець"
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
          styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 13 } }}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Скасувати
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            Зберегти
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function TemplatesPage() {
  const client = useQueryClient();
  const [selected, setSelected] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);

  /*
   * В адресі стоїть ключ шаблона, а не номер: `#/templates/send_studio_named_en`
   * читається, а `#/templates/7` не каже нічого. Всередині вибір лишається
   * номером, і саме тому перейменування ключа не скидає вибір: номер не змінився,
   * а адреса підтягнеться слідом.
   */
  const [slug, selectSlug] = useSelection('templates');
  const [signing, setSigning] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('vacancy');

  const { data, error, isLoading } = useQuery({ queryKey: ['templates'], queryFn: () => api.templates() });

  const list = data?.templates ?? [];
  const opened = list.find((row) => row.id === selected) ?? list.find((row) => !row.archived) ?? list[0];

  // Адреса задає вибір, коли прийшли за посиланням або натиснули "назад".
  useEffect(() => {
    if (!slug) return;
    const found = list.find((row) => row.slug === slug);
    if (found && found.id !== selected) setSelected(found.id);
  }, [slug, list, selected]);

  // І навпаки: вибір задає адресу, у тому числі після перейменування ключа.
  useEffect(() => {
    if (opened && opened.slug !== slug) selectSlug(opened.slug);
  }, [opened, slug, selectSlug]);

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
      <SignatureModal opened={signing} onClose={() => setSigning(false)} />

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
            Ключ для історії листування зробиться з назви автоматично, змінити його можна потім
            у самому шаблоні.
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
              <Button variant="default" onClick={() => setSigning(true)}>
                Підпис
              </Button>
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
            <Editor key={current.id} row={current} all={rows} onSelect={setSelected} />
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
