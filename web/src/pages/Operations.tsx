import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Badge,
  Button,
  Code,
  Group,
  NumberInput,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Play } from 'lucide-react';
import { api } from '../lib/api';

/**
 * Операції: те саме, що робить CLI, але кнопками.
 *
 * Раніше половина роботи жила лише в терміналі, і на проді її не було взагалі:
 * ноутбук з репозиторієм не завжди під рукою, а радар живе у воркері. Тут кожна
 * кнопка це один POST, і відповідь показується як є, без переказу своїми словами.
 *
 * Чого тут немає навмисно: міграції, імпорт файлів, вивантаження бази і
 * підключення пошти. Це або одноразові речі, або такі, що потребують файлів на
 * диску, тобто кнопка в браузері їх не виконає.
 */

type Field = { name: string; label: string; kind: 'number' | 'select'; def: number | string; options?: string[] };

interface Operation {
  id: string;
  label: string;
  hint: string;
  path: string;
  /** Довгі операції попереджають про себе: воркер має ліміт часу на запит. */
  slow?: boolean;
  fields?: Field[];
}

interface OperationGroup {
  title: string;
  note: string;
  items: Operation[];
}

const GROUPS: OperationGroup[] = [
  {
    title: 'Збір',
    note: 'звідки беруться компанії і вакансії',
    items: [
      {
        id: 'catalog-yc',
        label: 'Каталог YC',
        hint: 'стартапи, які зараз наймають. Вакансій не дає, дає входи для discovery',
        path: '/catalogs/yc/run',
        slow: true,
      },
      {
        id: 'hn-hiring',
        label: 'HN: Who is hiring',
        hint: 'щомісячна гілка Hacker News: дві сотні стартапів з прямим контактом засновника',
        path: '/sources/hn%3Ahiring/run',
        slow: true,
      },
      {
        id: 'getro',
        label: 'Дошки акселераторів',
        hint: 'Techstars, Accel, Underscore і решта мереж Getro',
        path: '/sources/getro/run',
        slow: true,
      },
      {
        id: 'catalog-dou',
        label: 'Каталог DOU',
        hint: 'компанії з jobs.dou.ua за фільтрами',
        path: '/catalogs/dou/run',
        slow: true,
        fields: [{ name: 'limit', label: 'скільки', kind: 'number', def: 40 }],
      },
      {
        id: 'catalog-awwwards',
        label: 'Каталог Awwwards',
        hint: 'дизайн-студії з каталогу нагород',
        path: '/catalogs/awwwards/run',
        slow: true,
      },
      {
        id: 'discover',
        label: 'Знайти career-сторінки',
        hint: 'обходить компанії без ATS: /careers, /jobs, футер. Знайдене більше не шукається',
        path: '/discover',
        slow: true,
        fields: [{ name: 'limit', label: 'компаній', kind: 'number', def: 40 }],
      },
      {
        id: 'enrich',
        label: 'Зібрати контакти і стек',
        hint: 'сторінки /team і /about: імена, ролі, пошта, ознаки живості сайту',
        path: '/enrich',
        slow: true,
        fields: [{ name: 'limit', label: 'компаній', kind: 'number', def: 25 }],
      },
    ],
  },
  {
    title: 'Обробка',
    note: 'що робити з тим, що вже зібрано',
    items: [
      {
        id: 'classify',
        label: 'Догнати класифікацію',
        hint: 'вакансії без думки моделі, зверху за рахунком. Витрачає денний бюджет',
        path: '/classify/pending',
        slow: true,
        fields: [{ name: 'limit', label: 'вакансій', kind: 'number', def: 50 }],
      },
      {
        id: 'recalc',
        label: 'Перерахувати рахунки',
        hint: 'після зміни правил. Модель не викликається, це чиста арифметика',
        path: '/score/recalc',
      },
      {
        id: 'top-up',
        label: 'Добрати чергу',
        hint: 'долити картки в сьогоднішній зріз до денного ліміту',
        path: '/queue/top-up',
      },
      {
        id: 'kinds',
        label: 'Проставити типи компаній',
        hint: 'студія, дизайн, стартап, продукт, аутстаф. За тегами і описом',
        path: '/maintenance/kinds',
      },
      {
        id: 'backfill',
        label: 'Розкласти поля каталогів',
        hint: 'ставка, мінімальний проєкт і рік заснування з тегів по колонках',
        path: '/maintenance/backfill-catalog',
      },
      {
        id: 'fix-detail',
        label: 'Перечитати описи вакансій',
        hint: 'для бордів на Next.js, де замість опису зберігалось меню сайту',
        path: '/maintenance/fix-detail',
        slow: true,
        fields: [
          { name: 'limit', label: 'сторінок', kind: 'number', def: 25 },
          { name: 'source', label: 'джерело', kind: 'select', def: 'getro', options: ['getro', 'djinni', 'dou:vacancies'] },
        ],
      },
      {
        id: 'embed',
        label: 'Порахувати вектори',
        hint: 'для пошуку схожих компаній, через Workers AI',
        path: '/embed',
        slow: true,
        fields: [{ name: 'limit', label: 'компаній', kind: 'number', def: 50 }],
      },
    ],
  },
  {
    title: 'Розсилка',
    note: 'листи готуються тут, відправляються на сторінці До відправки',
    items: [
      {
        id: 'outreach-seed',
        label: 'Долити шаблони розсилки',
        hint: 'додає відсутні каркаси: чотири випадки на двох мовах',
        path: '/outreach/seed',
      },
      {
        id: 'templates-seed',
        label: 'Долити стартові шаблони',
        hint: 'ті, що були в списку спочатку. Видалені самі більше не повертаються',
        path: '/templates/seed',
      },
      {
        id: 'outreach-prepare',
        label: 'Зібрати чернетки',
        hint: 'вибір шаблона, мови і контакту. Нічого не відправляє',
        path: '/outreach/prepare',
        slow: true,
        fields: [{ name: 'limit', label: 'компаній', kind: 'number', def: 20 }],
      },
      {
        id: 'outreach-followups',
        label: 'Зібрати фолоу-апи',
        hint: 'кому час писати вдруге: 7-9 днів без відповіді, той самий тред',
        path: '/outreach/followups',
      },
      {
        id: 'outreach-replies',
        label: 'Перевірити відповіді',
        hint: 'обхід тредів: відповіді, автовідповіді, баунси. Крон робить це щогодини',
        path: '/outreach/replies',
        slow: true,
      },
    ],
  },
  {
    title: 'Перевірки',
    note: 'коли щось мовчить, починати звідси',
    items: [
      {
        id: 'llm-ping',
        label: 'Перевірити модель',
        hint: 'живий виклик: ключ, провайдер, AI Gateway. Коштує кілька токенів',
        path: '/llm/ping',
      },
      {
        id: 'gmail-test',
        label: 'Тестовий лист собі',
        hint: 'кирилиця в темі навмисно, на ній ламається кодування',
        path: '/gmail/test',
      },
      {
        id: 'notify-digest',
        label: 'Телеграм: дайджест',
        hint: 'те саме, що приходить о 10:00',
        path: '/notify/digest',
      },
      {
        id: 'notify-outreach',
        label: 'Телеграм: розсилка',
        hint: 'скільки чернеток готово і скільки фолоу-апів настало',
        path: '/notify/outreach',
      },
      {
        id: 'notify-broken',
        label: 'Телеграм: поламані джерела',
        hint: 'адаптери, що повернули нуль або помилку',
        path: '/notify/broken',
      },
    ],
  },
];

/** Ключі, які майже завжди є у відповіді. Показуємо їх людськими словами. */
const LABELS: Record<string, string> = {
  itemsFound: 'знайдено',
  itemsNew: 'нових',
  created: 'створено',
  updated: 'оновлено',
  seen: 'переглянуто',
  classified: 'класифіковано',
  skipped: 'пропущено',
  stopped: 'відсіяно стоп-словами',
  needsReview: 'на ручний перегляд',
  detailed: 'довантажено описів',
  emptyDetail: 'сторінок без опису',
  checked: 'перевірено',
  fixed: 'виправлено',
  unchanged: 'без змін',
  stillEmpty: 'без опису',
  candidates: 'кандидатів',
  drafts: 'чернеток',
  due: 'настало',
  replies: 'відповідей',
  bounces: 'баунсів',
  added: 'додано',
  total: 'усього',
  taken: 'узято',
  sent: 'надіслано',
  ok: 'працює',
};

function Result({ value }: { value: Record<string, unknown> }) {
  const rows = Object.entries(value).filter(
    ([, item]) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean',
  );

  if (rows.length === 0) return <Code block>{JSON.stringify(value, null, 2).slice(0, 600)}</Code>;

  return (
    <Group gap={6} mt={6}>
      {rows.map(([key, item]) => (
        <Badge key={key} variant="light" color={key === 'error' ? 'red' : 'gray'}>
          {(LABELS[key] ?? key) + ': ' + String(item).slice(0, 80)}
        </Badge>
      ))}
    </Group>
  );
}

function OperationCard({ operation }: { operation: Operation }) {
  const client = useQueryClient();
  const [values, setValues] = useState<Record<string, number | string>>(
    Object.fromEntries((operation.fields ?? []).map((field) => [field.name, field.def])),
  );
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  const run = useMutation({
    mutationFn: () => api.run(operation.path, values),
    onSuccess: (data) => {
      setResult(data);
      notifications.show({ color: 'green', title: operation.label, message: 'готово' });
      // Після будь-якої операції цифри в інтерфейсі застарілі, тому перечитуємо все.
      void client.invalidateQueries();
    },
    onError: (error: Error) => {
      setResult({ error: error.message });
      notifications.show({ color: 'red', title: operation.label, message: error.message });
    },
  });

  return (
    <Paper withBorder p="sm">
      <Group justify="space-between" align="start" wrap="nowrap" gap="sm">
        <div style={{ minWidth: 0 }}>
          <Group gap={6}>
            <Text size="sm" fw={500}>
              {operation.label}
            </Text>
            {operation.slow && (
              <Tooltip label="довга операція, воркер має ліміт часу на запит">
                <Badge size="xs" color="yellow" variant="light">
                  довга
                </Badge>
              </Tooltip>
            )}
          </Group>
          <Text size="xs" c="dimmed">
            {operation.hint}
          </Text>
        </div>

        <Group gap="xs" wrap="nowrap">
          {(operation.fields ?? []).map((field) =>
            field.kind === 'number' ? (
              <NumberInput
                key={field.name}
                size="xs"
                w={92}
                min={1}
                label={field.label}
                value={values[field.name] as number}
                onChange={(next) => setValues({ ...values, [field.name]: Number(next) || 1 })}
              />
            ) : (
              <Select
                key={field.name}
                size="xs"
                w={130}
                label={field.label}
                data={field.options ?? []}
                value={String(values[field.name])}
                onChange={(next) => next && setValues({ ...values, [field.name]: next })}
                allowDeselect={false}
              />
            ),
          )}
          <Button
            size="xs"
            mt={operation.fields?.length ? 22 : 0}
            leftSection={<Play size={14} />}
            loading={run.isPending}
            onClick={() => run.mutate()}
          >
            Запустити
          </Button>
        </Group>
      </Group>

      {result && <Result value={result} />}
    </Paper>
  );
}

export function OperationsPage() {
  const { data: gmail } = useQuery({ queryKey: ['gmail-status'], queryFn: () => api.gmailStatus() });

  return (
    <ScrollArea.Autosize mah="calc(100dvh - 60px)">
      <Stack gap="lg" p="lg">
        {gmail && !gmail.connected && (
          <Alert color="yellow" title="Пошта не підключена">
            Операції розсилки працюватимуть, але надіслати лист буде нічим.
          </Alert>
        )}

        {GROUPS.map((group) => (
          <Stack gap="xs" key={group.title}>
            <div>
              <Text fw={600}>{group.title}</Text>
              <Text size="xs" c="dimmed">
                {group.note}
              </Text>
            </div>
            {group.items.map((operation) => (
              <OperationCard key={operation.id} operation={operation} />
            ))}
          </Stack>
        ))}

        <Text size="xs" c="dimmed">
          Лишились у терміналі тільки ті команди, яким потрібні файли на диску або
          одноразове налаштування: міграції, імпорт CSV і збережених сторінок,
          вивантаження бази в D1, підключення Gmail.
        </Text>
      </Stack>
    </ScrollArea.Autosize>
  );
}
