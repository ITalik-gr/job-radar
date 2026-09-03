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
  Spoiler,
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
  Inbox,
  MessageSquareQuote,
  Send,
  ThumbsDown,
  TriangleAlert,
} from 'lucide-react';
import { api, formatSalary, type QueueCard } from '../lib/api';
import { useHotkeys } from '../lib/hotkeys';
import { PaneFooter, PaneHeader, SplitView } from '../components/SplitView';
import { Score } from '../components/Score';

const TEMPLATES = ['fullstack_ai', 'frontend_react', 'agency_cold', 'referral'];

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
  const [template, setTemplate] = useState(TEMPLATES[0]!);
  const salary = formatSalary(card);

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
                  <Group gap={6}>
                    {card.stack.map((tech) => (
                      <Badge key={tech} color="gray">
                        {tech}
                      </Badge>
                    ))}
                  </Group>
                )}
              </DataList.ItemValue>
            </DataList.Item>
          </DataList>

          {card.why && (
            <Alert mt="lg" variant="light" icon={<MessageSquareQuote size={16} />} title="Думка моделі">
              {card.why}
            </Alert>
          )}

          <Text size="xs" tt="uppercase" fw={500} c="dimmed" mt="lg" mb="xs" style={{ letterSpacing: '0.04em' }}>
            сирий текст вакансії
          </Text>
          <Spoiler maxHeight={160} showLabel="показати весь текст" hideLabel="згорнути">
            <Code block className="raw-text">
              {(card.rawText ?? '').slice(0, 8000) || 'сирого тексту немає'}
            </Code>
          </Spoiler>
        </Box>
      </ScrollArea>

      {/* Смуга рішень. Завжди на одному місці, тому руку не треба шукати кнопку заново. */}
      {/*
        Рішення злива і рішення відмови стоять ліворуч, надсилання листа праворуч.
        Так шість кнопок вкладаються в один рядок і не переносяться на другий,
        а рука щоразу тягнеться в те саме місце.
      */}
      <PaneFooter>
        <Button
          color="green"
          leftSection={<Check size={15} />}
          rightSection={<Kbd size="xs">i</Kbd>}
          onClick={() => onAct({ action: 'interesting' })}
        >
          Цікаво
        </Button>
        <Button
          variant="default"
          leftSection={<ThumbsDown size={15} />}
          rightSection={<Kbd size="xs">n</Kbd>}
          onClick={() => onAct({ action: 'not_interesting' })}
        >
          Не цікаво
        </Button>
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
          <Select
            data={TEMPLATES}
            value={template}
            onChange={(value) => value && setTemplate(value)}
            allowDeselect={false}
            w={150}
            aria-label="шаблон листа"
          />
          <Button
            leftSection={<Send size={15} />}
            rightSection={<Kbd size="xs">e</Kbd>}
            onClick={() => onAct({ action: 'contacted', channel: 'email', templateUsed: template })}
          >
            Написав
          </Button>
        </Group>
      </PaneFooter>
    </>
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
          <PaneHeader>
            <Box style={{ flex: 1, minWidth: 0 }}>
              <Group gap="xs" justify="space-between">
                <Text fw={600}>{pending.length} чекають рішення</Text>
                <Text size="xs" c="dimmed">
                  зріз за {data.day}
                </Text>
              </Group>
              {/* Прогрес показує, що черга конечна: десять карток закінчуються, і це видно. */}
              <Progress value={(decided / Math.max(1, data.cards.length)) * 100} size="xs" mt={6} />
              <Text size="xs" c="dimmed" mt={4}>
                розібрано {decided} з {data.cards.length}
                <Text span mx={6}>
                  ·
                </Text>
                <Kbd size="xs">j</Kbd> <Kbd size="xs">k</Kbd> перехід
              </Text>
            </Box>
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
            <EmptyState
              icon={<Inbox size={28} />}
              withIndicatorBackground
              title="На сьогодні все розібрано"
              description="Новий зріз зʼявиться завтра. Щоб не чекати, запусти джерела кнопкою у шапці."
            />
          </Box>
        )
      }
    />
  );
}
