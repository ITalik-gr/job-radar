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
  Building2,
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
import { companyHref } from '../lib/route';
import { useHotkeys } from '../lib/hotkeys';
import { PaneFooter, PaneHeader, SplitView } from '../components/SplitView';
import { TemplateSelect } from '../components/TemplateSelect';
import { TagMenu } from '../components/TagMenu';
import { LetterBlock } from '../components/LetterBlock';
import { Score } from '../components/Score';

const DONE: Record<string, string> = {
  interesting: 'marked interesting',
  not_interesting: 'rejected',
  contacted: 'marked as contacted',
  blacklist: 'blacklisted',
  snooze: 'snoozed for 30 days',
};

/** A list row. Only what the owner picks the next read by: score, company, role. */
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
                {waiting}d
              </Badge>
            )}
          </Group>

          <Text size="sm" lineClamp={2} mt={2}>
            {card.title ?? 'untitled'}
          </Text>

          {/* In a narrow list stack tags do not fit and get cut into a mess.
              Only what decides the next read is needed here. */}
          <Group gap={6} mt={6} wrap="nowrap" style={{ overflow: 'hidden' }}>
            {card.remote && (
              <Badge size="xs" color="green">
                remote
              </Badge>
            )}
            <Text size="xs" c="dimmed" truncate>
              {[card.seniority, card.location, formatSalary(card)].filter(Boolean).join(' · ') || 'no details'}
            </Text>
          </Group>
        </Box>
      </Group>
    </UnstyledButton>
  );
}

/** The open card. One per screen, so it can afford room and the full text. */
function Detail({ card, onAct }: { card: QueueCard; onAct: (body: Record<string, unknown>) => void }) {
  const [template, setTemplate] = useState<string | null>(null);
  const salary = formatSalary(card);
  const waiting = waitingDays(card.firstShownAt);
  const [rawOpen, setRawOpen] = useState(false);

  const toDrafts = useMutation({
    mutationFn: () => api.draftForCompany(card.companyId, card.vacancyId, template),
    onSuccess: (result) =>
      notifications.show({
        color: result.id && !result.reason ? 'green' : 'yellow',
        title: card.company,
        message: result.reason ?? 'draft is on the Outbox page',
      }),
    onError: (error: Error) =>
      notifications.show({ color: 'red', title: 'failed', message: error.message }),
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
            {/* The company card in the app: stack, contacts, correspondence history. */}
            <Tooltip label="company card in the radar">
              <Anchor href={companyHref(card.domain)} size="sm" c="dimmed" style={{ display: 'flex' }}>
                <Building2 size={14} />
              </Anchor>
            </Tooltip>
            <Text size="sm" c="dimmed">
              {card.domain}
            </Text>
            {card.needsReview && (
              <Badge color="yellow" leftSection={<TriangleAlert size={11} />}>
                review by hand
              </Badge>
            )}
          </Group>

          <Title order={2}>{card.title ?? 'untitled'}</Title>

          {card.contactedNote && (
            <Alert color="yellow" mt="md" icon={<Clock size={16} />} title="This company was contacted before">
              {card.contactedNote}. Reaching out again after a quarter is fine, after a week it is not.
            </Alert>
          )}

          {waiting > 0 && (
            <Alert color="gray" mt="md" icon={<Clock size={16} />}>
              This card has waited {waiting} {waiting === 1 ? 'day' : 'days'} for a decision: it
              was carried over from earlier slices because you did not decide on it. It takes a
              place in the daily limit until it gets a decision.
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
              Open vacancy
            </Button>
            {card.careersUrl && (
              <Button component="a" href={card.careersUrl} target="_blank" rel="noreferrer" variant="subtle">
                All company vacancies
              </Button>
            )}
          </Group>

          <Divider my="lg" />

          <DataList labelWidth={132} gap="sm">
            <DataList.Item>
              <DataList.ItemLabel>score</DataList.ItemLabel>
              <DataList.ItemValue>
                <Score value={card.score} />
              </DataList.ItemValue>
            </DataList.Item>

            <DataList.Item>
              <DataList.ItemLabel>seniority</DataList.ItemLabel>
              <DataList.ItemValue>{card.seniority ?? <Text c="dimmed">not stated</Text>}</DataList.ItemValue>
            </DataList.Item>

            <DataList.Item>
              <DataList.ItemLabel>format</DataList.ItemLabel>
              <DataList.ItemValue>
                <Group gap="xs">
                  {card.remote ? <Badge color="green">remote</Badge> : <Text c="dimmed">not stated</Text>}
                  {card.location && <Text>{card.location}</Text>}
                </Group>
              </DataList.ItemValue>
            </DataList.Item>

            <DataList.Item>
              <DataList.ItemLabel>salary</DataList.ItemLabel>
              <DataList.ItemValue>
                {salary ? (
                  <Text fw={600} className="tabular">
                    {salary}
                  </Text>
                ) : (
                  <Text c="dimmed">not stated</Text>
                )}
              </DataList.ItemValue>
            </DataList.Item>

            <DataList.Item>
              <DataList.ItemLabel>stack</DataList.ItemLabel>
              <DataList.ItemValue>
                {card.stack.length === 0 ? (
                  <Text c="dimmed">not recognised</Text>
                ) : (
                  <Stack gap={6}>
                    <Group gap={6}>
                      {card.stack.map((tech) => (
                        <TagMenu key={tech} term={tech} />
                      ))}
                    </Group>
                    <Text size="xs" c="dimmed">
                      click a tag to change its weight or make it a stop word
                    </Text>
                  </Stack>
                )}
              </DataList.ItemValue>
            </DataList.Item>
          </DataList>

          {card.why && (
            <Alert mt="lg" variant="light" icon={<MessageSquareQuote size={16} />} title="Model opinion">
              {card.why}
            </Alert>
          )}

          <LetterBlock
            company={card.company}
            domain={card.domain}
            stack={card.stack}
            vacancyTitle={card.title}
            templateKind="vacancy"
            slug={template}
            onSlug={setTemplate}
          />

          <Group gap="sm" mt="lg" mb="xs">
            <Text size="xs" tt="uppercase" fw={500} c="dimmed" style={{ letterSpacing: '0.04em' }}>
              raw vacancy text
            </Text>
            {card.rawText && (
              <Text size="xs" c="dimmed">
                {card.rawText.length} characters
              </Text>
            )}
            <Anchor component="button" type="button" size="xs" onClick={() => setRawOpen((value) => !value)}>
              {rawOpen ? 'collapse' : 'expand fully'}
            </Anchor>
          </Group>

          {/*
            Collapsed is a window with its own scroll, not truncated text: the first
            paragraph can be read without expanding. Expanded removes the height limit
            entirely, and the text scrolls with the page.
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
            {card.rawText || 'no raw text'}
          </Code>
        </Box>
      </ScrollArea>

      {/* The decision bar. Always in the same place, so the hand never hunts for a button. */}
      {/*
        Keep and reject decisions sit on the left, sending a letter on the right.
        That way six buttons fit on one row without wrapping, and the hand
        reaches for the same spot every time.
      */}
      <PaneFooter>
        <Tooltip label="company becomes interesting, the card leaves the queue. No letter is sent">
          <Button
            color="green"
            leftSection={<Check size={15} />}
            rightSection={<Kbd size="xs">i</Kbd>}
            onClick={() => onAct({ action: 'interesting' })}
          >
            Interesting
          </Button>
        </Tooltip>
        <Tooltip label="status rejected by me, never shown again. The vacancy stays in the database for statistics">
          <Button
            variant="default"
            leftSection={<ThumbsDown size={15} />}
            rightSection={<Kbd size="xs">n</Kbd>}
            onClick={() => onAct({ action: 'not_interesting' })}
          >
            Not interesting
          </Button>
        </Tooltip>
        <Tooltip label="never show this company again">
          <Button
            color="red"
            variant="light"
            leftSection={<Ban size={15} />}
            rightSection={<Kbd size="xs">b</Kbd>}
            onClick={() => onAct({ action: 'blacklist' })}
          >
            Block
          </Button>
        </Tooltip>
        <Tooltip label="remove from the queue for 30 days">
          <Button
            variant="default"
            leftSection={<Clock size={15} />}
            rightSection={<Kbd size="xs">s</Kbd>}
            onClick={() => onAct({ action: 'snooze', days: 30 })}
          >
            Snooze
          </Button>
        </Tooltip>

        <Group gap="xs" ml="auto" wrap="nowrap">
          {/*
            The bridge between the Queue and sending: the same company, the same
            templates and the same language choice as the nightly preparation. Without
            this button there would be two parallel ways to write a letter, and they
            would drift apart over time.
          */}
          <Tooltip label="build a letter draft. If there is no address, crawls the company site first">
            <Button
              variant="light"
              leftSection={<MailPlus size={15} />}
              loading={toDrafts.isPending}
              onClick={() => toDrafts.mutate()}
            >
              To outbox
            </Button>
          </Tooltip>
          <TemplateSelect kind="vacancy" value={template} onChange={setTemplate} width={240} />
          <Tooltip label="mark the letter as already sent. The record goes to Contacts, a follow-up reminder comes in 7 days">
            <Button
              leftSection={<Send size={15} />}
              rightSection={<Kbd size="xs">e</Kbd>}
              disabled={!template}
              onClick={() => onAct({ action: 'contacted', channel: 'email', templateUsed: template })}
            >
              Contacted
            </Button>
          </Tooltip>
        </Group>
      </PaneFooter>
    </>
  );
}

/**
 * An empty queue has three different causes, and the owner's next step differs for each.
 * So there is no single text: this used to always say "new slice tomorrow", which was
 * simply misleading when zero vacancies cleared the threshold.
 */
function EmptyReason({ decided, total }: { decided: number; total: number }) {
  const { data: stats } = useQuery({ queryKey: ['stats'], queryFn: () => api.stats() });

  if (decided > 0 && decided === total) {
    return (
      <EmptyState
        icon={<Inbox size={28} />}
        withIndicatorBackground
        title="The slice for today is done"
        description={`All ${total} cards are done. A new slice is built tomorrow, or run the sources from the header button.`}
      />
    );
  }

  if (stats && stats.vacancies.aboveThreshold === 0) {
    return (
      <EmptyState
        icon={<Filter size={28} />}
        withIndicatorBackground
        title="Nothing clears the threshold"
        description={`The database has ${stats.vacancies.open} open vacancies, but none scored ${stats.threshold}. Lower the threshold or adjust the weights on the Rules page, then Run, Rescore.`}
      />
    );
  }

  return (
    <EmptyState
      icon={<Inbox size={28} />}
      withIndicatorBackground
      title="No new vacancies for the queue"
      description={
        stats
          ? `${stats.vacancies.aboveThreshold} vacancies clear the threshold, and all of them are decided. New finds are needed: Run, Refresh vacancies.`
          : 'New finds are needed: Run, Refresh vacancies.'
      }
    />
  );
}

export function QueuePage() {
  const client = useQueryClient();

  /*
   * The queue cursor deliberately stays in state rather than the address, unlike the
   * other lists. The queue is a daily stream: ten cards, one decision each, and a card
   * disappears as soon as it is decided. A link to "the fourth queue card" goes stale
   * in a minute and means something else tomorrow, so there is nothing to address.
   */
  const [cursor, setCursor] = useState(0);
  const { data, error, isLoading } = useQuery({ queryKey: ['queue'], queryFn: () => api.queue() });

  const act = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown>; company: string }) => api.act(id, body),
    onSuccess: (_result, { body, company }) => {
      notifications.show({ color: 'green', title: company, message: DONE[String(body.action)] ?? 'saved' });
      void client.invalidateQueries({ queryKey: ['queue'] });
      void client.invalidateQueries({ queryKey: ['stats'] });
      void client.invalidateQueries({ queryKey: ['outreach'] });
    },
    onError: (mutationError) =>
      notifications.show({ color: 'red', title: 'not saved', message: String(mutationError) }),
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
        <Alert color="red" title="Could not read the queue">
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
              <Text fw={600}>{pending.length} awaiting a decision</Text>
              <Text size="xs" c="dimmed">
                slice for {data.day}
              </Text>
            </Group>
            {/* The progress bar shows the queue is finite: ten cards run out, and you can see it. */}
            <Progress value={(decided / Math.max(1, data.cards.length)) * 100} size="xs" mt={10} />
            <Group gap={6} mt={10}>
              <Text size="xs" c="dimmed">
                decided {decided} of {data.cards.length}
              </Text>
              <Text size="xs" c="dimmed">
                ·
              </Text>
              <Kbd size="xs">j</Kbd>
              <Kbd size="xs">k</Kbd>
              <Text size="xs" c="dimmed">
                navigate
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
