import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Code,
  DataList,
  Divider,
  EmptyState,
  Group,
  Kbd,
  Progress,
  ScrollArea,
  Select,
  Skeleton,
  Stack,
  Text,
  Title,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  Ban,
  Check,
  Clock,
  ExternalLink,
  Filter,
  Inbox,
  MessageSquareQuote,
  MailPlus,
  Send,
  ThumbsDown,
  TriangleAlert,
} from 'lucide-react';
import { api, formatSalary, waitingDays, type QueueCard } from '../lib/api';
import { useHotkeys } from '../lib/hotkeys';
import { PaneFooter, PaneHeader, SplitView } from '../components/SplitView';
import { TemplateSelect } from '../components/TemplateSelect';
import { TagMenu } from '../components/TagMenu';
import { LetterBlock } from '../components/LetterBlock';
import { Score } from '../components/Score';

const DONE: Record<string, string> = {
  interesting: 'у цікавих',
  not_interesting: 'відкинуто',
  contacted: 'позначено як написано',
  blacklist: 'у блокліст',
  snooze: 'відкладено на 30 днів',
};

/** Рядок списку. Тільки те, за чим власник обирає, що читати далі: рахунок, компанія, роль. */
function Row({
  card,
  active,
  onSelect,
}: {
  card: QueueCard;
  active: boolean;
  onSelect: () => void;
}) {
  const node = useRef<HTMLButtonElement>(null);
  const waiting = waitingDays(card.firstShownAt);
  const [rawOpen, setRawOpen] = useState(false);

  useEffect(() => {
    if (active) node.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <UnstyledButton
      ref={node}
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
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <Score value={card.score} size="sm" />
        <Box style={{ minWidth: 0, flex: 1 }}>
          <Group gap={6} wrap="nowrap">
            <Text size="sm" fw={600} truncate>
              {card.company}
            </Text>
            {card.needsReview && <TriangleAlert size={13} color="var(--mantine-color-yellow-7)" />}
            {card.contactedNote && <Clock size={13} color="var(--mantine-color-yellow-7)" />}
            {waiting > 0 && (
              <Badge size="xs" color="gray" ml="auto">
                {waiting} дн
              </Badge>
            )}
          </Group>

          <Text size="sm" lineClamp={2} mt={2}>
            {card.title ?? 'без назви'}
          </Text>

          {/* У вузькому списку теги стеку не влазять і обрізаються в кашу.
              Тут потрібне лише те, за чим обирають, що читати далі. */}
          <Group gap={6} mt={6} wrap="nowrap" style={{ overflow: 'hidden' }}>
            {card.remote && (
              <Badge size="xs" color="green">
                remote
              </Badge>
            )}
            <Text size="xs" c="dimmed" truncate>
              {[card.seniority, card.location, formatSalary(card)].filter(Boolean).join(' · ') || 'без деталей'}
            </Text>
          </Group>
        </Box>
      </Group>
    </UnstyledButton>
  );
}

/** Відкрита картка. Одна на екран, тому тут можна дозволити собі повітря і повний текст. */
function Detail({ card, onAct }: { card: QueueCard; onAct: (body: Record<string, unknown>) => void }) {
  const [template, setTemplate] = useState<string | null>(null);
  const salary = formatSalary(card);
  const waiting = waitingDays(card.firstShownAt);
  const [rawOpen, setRawOpen] = useState(false);

  const toDrafts = useMutation({
    mutationFn: () => api.draftForCompany(card.companyId, card.vacancyId),
    onSuccess: (result) =>
      notifications.show({
        color: result.id && !result.reason ? 'green' : 'yellow',
        title: card.company,
        message: result.reason ?? 'чернетка на сторінці До відправки',
      }),
    onError: (error: Error) =>
      notifications.show({ color: 'red', title: 'не вийшло', message: error.message }),
  });

  useHotkeys(
    useMemo(
      () => ({
        i: () => onAct({ action: 'interesting' }),
        n: () => onAct({ action: 'not_interesting' }),
        e: () => onAct({ action: 'contacted', channel: 'email', templateUsed: template }),
        b: () => onAct({ action: 'blacklist' }),
        s: () => onAct({ action: 'snooze', days: 30 }),
        enter: () => window.open(card.url, '_blank', 'noreferrer'),
      }),
      [onAct, template, card.url],
    ),
  );

  return (
    <>
      <ScrollArea style={{ flex: 1, minHeight: 0 }}>
        <Box p="lg" maw={860}>
          <Group gap="sm" mb="xs">
            <Anchor href={`https://${card.domain}`} target="_blank" rel="noreferrer" fw={600}>
              {card.company}
            </Anchor>
            <Text size="sm" c="dimmed">
              {card.domain}
            </Text>
            {card.needsReview && (
              <Badge color="yellow" leftSection={<TriangleAlert size={11} />}>
                перевірити вручну
              </Badge>
            )}
          </Group>

          <Title order={2}>{card.title ?? 'без назви'}</Title>

          {card.contactedNote && (
            <Alert color="yellow" mt="md" icon={<Clock size={16} />} title="Цій компанії вже писали">
              {card.contactedNote}. Повторний контакт через квартал нормальний, через тиждень ні.
            </Alert>
          )}

          {waiting > 0 && (
            <Alert color="gray" mt="md" icon={<Clock size={16} />}>
              Картка чекає рішення {waiting} {waiting === 1 ? 'день' : 'дн'}: її перенесли з
              попередніх зрізів, бо ти її не розібрав. Вона займає місце в денному ліміті,
              поки не отримає рішення.
            </Alert>
          )}

          <Group mt="md" gap="sm">
            <Button
              component="a"
              href={card.url}
              target="_blank"
              rel="noreferrer"
              variant="light"
              leftSection={<ExternalLink size={14} />}
              rightSection={<Kbd size="xs">↵</Kbd>}
            >
              Відкрити вакансію
            </Button>
            {card.careersUrl && (
              <Button component="a" href={card.careersUrl} target="_blank" rel="noreferrer" variant="subtle">
                Усі вакансії компанії
              </Button>
            )}
          </Group>

          <Divider my="lg" />

          <DataList labelWidth={132} gap="sm">
            <DataList.Item>
              <DataList.ItemLabel>рахунок</DataList.ItemLabel>
              <DataList.ItemValue>
                <Score value={card.score} />
              </DataList.ItemValue>
            </DataList.Item>

            <DataList.Item>
              <DataList.ItemLabel>грейд</DataList.ItemLabel>
              <DataList.ItemValue>{card.seniority ?? <Text c="dimmed">не вказано</Text>}</DataList.ItemValue>
            </DataList.Item>

            <DataList.Item>
              <DataList.ItemLabel>формат</DataList.ItemLabel>
              <DataList.ItemValue>
                <Group gap="xs">
                  {card.remote ? <Badge color="green">remote</Badge> : <Text c="dimmed">не вказано</Text>}
                  {card.location && <Text>{card.location}</Text>}
                </Group>
              </DataList.ItemValue>
            </DataList.Item>

            <DataList.Item>
              <DataList.ItemLabel>вилка</DataList.ItemLabel>
              <DataList.ItemValue>
                {salary ? (
                  <Text fw={600} className="tabular">
                    {salary}
                  </Text>
                ) : (
                  <Text c="dimmed">не вказана</Text>
                )}
              </DataList.ItemValue>
            </DataList.Item>

            <DataList.Item>
              <DataList.ItemLabel>стек</DataList.ItemLabel>
              <DataList.ItemValue>
                {card.stack.length === 0 ? (
                  <Text c="dimmed">не розпізнано</Text>
                ) : (
                  <Stack gap={6}>
                    <Group gap={6}>
                      {card.stack.map((tech) => (
                        <TagMenu key={tech} term={tech} />
                      ))}
                    </Group>
                    <Text size="xs" c="dimmed">
                      натисни тег, щоб змінити його вагу або відправити у стоп-слова
                    </Text>
                  </Stack>
                )}
              </DataList.ItemValue>
            </DataList.Item>
          </DataList>

          {card.why && (
            <Alert mt="lg" variant="light" icon={<MessageSquareQuote size={16} />} title="Думка моделі">
              {card.why}
            </Alert>
          )}

          <LetterBlock
            company={card.company}
            domain={card.domain}
            stack={card.stack}
            vacancyTitle={card.title}
            templateKind="vacancy"
          />

          <Group gap="sm" mt="lg" mb="xs">
            <Text size="xs" tt="uppercase" fw={500} c="dimmed" style={{ letterSpacing: '0.04em' }}>
              сирий текст вакансії
            </Text>
            {card.rawText && (
              <Text size="xs" c="dimmed">
                {card.rawText.length} символів
              </Text>
            )}
            <Anchor component="button" type="button" size="xs" onClick={() => setRawOpen((value) => !value)}>
              {rawOpen ? 'згорнути' : 'розкрити повністю'}
            </Anchor>
          </Group>

          {/*
            Згорнутий стан це вікно з власним скролом, а не обрізаний текст:
            прочитати перший абзац можна не розкриваючи блок. Розкритий стан знімає
            обмеження висоти зовсім, і текст скролиться разом зі сторінкою.
          */}
          <Code
            block
            className="raw-text"
            style={
              rawOpen
                ? undefined
                : { maxHeight: 260, overflowY: 'auto', overscrollBehavior: 'contain' }
            }
          >
            {card.rawText || 'сирого тексту немає'}
          </Code>
        </Box>
      </ScrollArea>

      {/* Смуга рішень. Завжди на одному місці, тому руку не треба шукати кнопку заново. */}
      {/*
        Рішення злива і рішення відмови стоять ліворуч, надсилання листа праворуч.
        Так шість кнопок вкладаються в один рядок і не переносяться на другий,
        а рука щоразу тягнеться в те саме місце.
      */}
      <PaneFooter>
        <Tooltip label="компанія в статус «цікава», картка зникає з черги. Лист не надсилається">
          <Button
            color="green"
            leftSection={<Check size={15} />}
            rightSection={<Kbd size="xs">i</Kbd>}
            onClick={() => onAct({ action: 'interesting' })}
          >
            Цікаво
          </Button>
        </Tooltip>
        <Tooltip label="статус «відкинув сам», більше не показуємо. Вакансія лишається в базі для статистики">
          <Button
            variant="default"
            leftSection={<ThumbsDown size={15} />}
            rightSection={<Kbd size="xs">n</Kbd>}
            onClick={() => onAct({ action: 'not_interesting' })}
          >
            Не цікаво
          </Button>
        </Tooltip>
        <Tooltip label="більше ніколи не показувати цю компанію">
          <Button
            color="red"
            variant="light"
            leftSection={<Ban size={15} />}
            rightSection={<Kbd size="xs">b</Kbd>}
            onClick={() => onAct({ action: 'blacklist' })}
          >
            Блок
          </Button>
        </Tooltip>
        <Tooltip label="прибрати з черги на 30 днів">
          <Button
            variant="default"
            leftSection={<Clock size={15} />}
            rightSection={<Kbd size="xs">s</Kbd>}
            onClick={() => onAct({ action: 'snooze', days: 30 })}
          >
            Відкласти
          </Button>
        </Tooltip>

        <Group gap="xs" ml="auto" wrap="nowrap">
          {/*
            Міст між Чергою і розсилкою: та сама компанія, ті самі шаблони і той
            самий вибір мови, що й у нічній підготовці. Без цієї кнопки лишалось
            би два паралельні способи написати листа, які з часом розійшлись би.
          */}
          <Tooltip label="зібрати чернетку листа. Якщо адреси немає, спершу обійде сайт компанії">
            <Button
              variant="light"
              leftSection={<MailPlus size={15} />}
              loading={toDrafts.isPending}
              onClick={() => toDrafts.mutate()}
            >
              У чергу листів
            </Button>
          </Tooltip>
          <TemplateSelect kind="vacancy" value={template} onChange={setTemplate} width={150} />
          <Tooltip label="позначити, що лист уже надіслано. Запис іде в Контакти, фолоу-ап нагадає через 7 днів">
            <Button
              leftSection={<Send size={15} />}
              rightSection={<Kbd size="xs">e</Kbd>}
              disabled={!template}
              onClick={() => onAct({ action: 'contacted', channel: 'email', templateUsed: template })}
            >
              Написав
            </Button>
          </Tooltip>
        </Group>
      </PaneFooter>
    </>
  );
}

/**
 * Порожня черга буває з трьох різних причин, і дії власника в кожному випадку різні.
 * Тому текст не один на всі випадки: раніше тут завжди писало "новий зріз завтра",
 * що при нулі вакансій вище порогу просто вводило в оману.
 */
function EmptyReason({ decided, total }: { decided: number; total: number }) {
  const { data: stats } = useQuery({ queryKey: ['stats'], queryFn: () => api.stats() });

  if (decided > 0 && decided === total) {
    return (
      <EmptyState
        icon={<Inbox size={28} />}
        withIndicatorBackground
        title="Сьогоднішній зріз розібрано"
        description={`Усі ${total} карток пройдені. Новий зріз збереться завтра, або запусти джерела кнопкою у шапці.`}
      />
    );
  }

  if (stats && stats.vacancies.aboveThreshold === 0) {
    return (
      <EmptyState
        icon={<Filter size={28} />}
        withIndicatorBackground
        title="Нічого не проходить поріг"
        description={`У базі ${stats.vacancies.open} відкритих вакансій, але жодна не набрала ${stats.threshold} балів. Знизь поріг або поправ ваги в config/scoring.json, далі Запустити, Перерахувати рахунки.`}
      />
    );
  }

  return (
    <EmptyState
      icon={<Inbox size={28} />}
      withIndicatorBackground
      title="Нових вакансій для черги немає"
      description={
        stats
          ? `Поріг проходять ${stats.vacancies.aboveThreshold} вакансій, і всі вони вже розібрані. Потрібні нові знахідки: Запустити, Оновити вакансії.`
          : 'Потрібні нові знахідки: Запустити, Оновити вакансії.'
      }
    />
  );
}

export function QueuePage() {
  const client = useQueryClient();
  const [cursor, setCursor] = useState(0);
  const { data, error, isLoading } = useQuery({ queryKey: ['queue'], queryFn: () => api.queue() });

  const act = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown>; company: string }) => api.act(id, body),
    onSuccess: (_result, { body, company }) => {
      notifications.show({ color: 'green', title: company, message: DONE[String(body.action)] ?? 'збережено' });
      void client.invalidateQueries({ queryKey: ['queue'] });
      void client.invalidateQueries({ queryKey: ['stats'] });
      void client.invalidateQueries({ queryKey: ['outreach'] });
    },
    onError: (mutationError) =>
      notifications.show({ color: 'red', title: 'не збереглось', message: String(mutationError) }),
  });

  const pending = data?.cards.filter((card) => !card.decision) ?? [];
  const index = Math.min(cursor, Math.max(0, pending.length - 1));
  const current = pending[index];

  useHotkeys(
    useMemo(
      () => ({
        j: () => setCursor((value) => Math.min(value + 1, pending.length - 1)),
        arrowdown: () => setCursor((value) => Math.min(value + 1, pending.length - 1)),
        k: () => setCursor((value) => Math.max(value - 1, 0)),
        arrowup: () => setCursor((value) => Math.max(value - 1, 0)),
      }),
      [pending.length],
    ),
    pending.length > 0,
  );

  if (error) {
    return (
      <Box p="lg">
        <Alert color="red" title="Не вдалось прочитати чергу">
          {error instanceof Error ? error.message : String(error)}
        </Alert>
      </Box>
    );
  }

  if (isLoading || !data) {
    return (
      <Box p="lg">
        <Stack gap="sm">
          {Array.from({ length: 5 }, (_, position) => (
            <Skeleton key={position} h={64} />
          ))}
        </Stack>
      </Box>
    );
  }

  const decided = data.cards.length - pending.length;

  return (
    <SplitView
      listWidth={368}
      list={
        <>
          <PaneHeader stacked>
            <Group gap="xs" justify="space-between" wrap="nowrap">
              <Text fw={600}>{pending.length} чекають рішення</Text>
              <Text size="xs" c="dimmed">
                зріз за {data.day}
              </Text>
            </Group>
            {/* Прогрес показує, що черга конечна: десять карток закінчуються, і це видно. */}
            <Progress value={(decided / Math.max(1, data.cards.length)) * 100} size="xs" mt={10} />
            <Group gap={6} mt={10}>
              <Text size="xs" c="dimmed">
                розібрано {decided} з {data.cards.length}
              </Text>
              <Text size="xs" c="dimmed">
                ·
              </Text>
              <Kbd size="xs">j</Kbd>
              <Kbd size="xs">k</Kbd>
              <Text size="xs" c="dimmed">
                перехід
              </Text>
            </Group>
          </PaneHeader>

          <ScrollArea style={{ flex: 1, minHeight: 0 }}>
            {pending.map((card, position) => (
              <Row
                key={card.queueItemId}
                card={card}
                active={position === index}
                onSelect={() => setCursor(position)}
              />
            ))}
          </ScrollArea>
        </>
      }
      detail={
        current ? (
          <Detail
            key={current.queueItemId}
            card={current}
            onAct={(body) => act.mutate({ id: current.vacancyId, body, company: current.company })}
          />
        ) : (
          <Box p="xl" style={{ flex: 1, display: 'grid', placeItems: 'center' }}>
            <EmptyReason decided={decided} total={data.cards.length} />
          </Box>
        )
      }
    />
  );
}
