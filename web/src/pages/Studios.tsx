import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Checkbox,
  DataList,
  Divider,
  EmptyState,
  Group,
  Kbd,
  NumberInput,
  ScrollArea,
  Select,
  Skeleton,
  Stack,
  Text,
  TextInput,
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
  Mail,
  Palette,
  Search,
  Send,
  ThumbsDown,
} from 'lucide-react';
import { api, formatDate, type StudioCard } from '../lib/api';
import { useHotkeys } from '../lib/hotkeys';
import { PaneFooter, PaneHeader, SplitView } from '../components/SplitView';
import { Score } from '../components/Score';

const TEMPLATES = ['studio_pitch', 'agency_cold', 'project_offer', 'referral'];

/** Стек, знятий із сайту студії. WordPress і Tilda означають, що фронт там навряд чи наймають. */
const WEAK_STACK = ['wordpress', 'tilda', 'wix', 'squarespace', 'drupal'];

function Row({ card, active, onSelect }: { card: StudioCard; active: boolean; onSelect: () => void }) {
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
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <Score value={card.score} size="sm" />
        <Box style={{ minWidth: 0, flex: 1 }}>
          <Group gap={6} wrap="nowrap">
            <Text size="sm" fw={600} truncate>
              {card.name}
            </Text>
            {card.lastContactedAt && <Clock size={13} color="var(--mantine-color-yellow-7)" />}
          </Group>

          <Text size="xs" c="dimmed" truncate mt={2}>
            {[card.city, card.country].filter(Boolean).join(', ') || card.domain}
          </Text>

          <Group gap={4} mt={6} wrap="nowrap" style={{ overflow: 'hidden' }}>
            {card.openVacancies > 0 && (
              <Badge size="xs" color="green">
                вакансій {card.openVacancies}
              </Badge>
            )}
            {card.techHints.slice(0, 3).map((tech) => (
              <Badge key={tech} size="xs" color={WEAK_STACK.includes(tech) ? 'red' : 'brand'}>
                {tech}
              </Badge>
            ))}
          </Group>
        </Box>
      </Group>
    </UnstyledButton>
  );
}

function Detail({ card, onAct }: { card: StudioCard; onAct: (body: Record<string, unknown>) => void }) {
  const [template, setTemplate] = useState(TEMPLATES[0]!);

  useHotkeys(
    useMemo(
      () => ({
        i: () => onAct({ action: 'interesting' }),
        n: () => onAct({ action: 'not_interesting' }),
        e: () => onAct({ action: 'contacted', templateUsed: template }),
        b: () => onAct({ action: 'blacklist' }),
        s: () => onAct({ action: 'snooze', days: 60 }),
      }),
      [onAct, template],
    ),
  );

  const weak = card.techHints.filter((tech) => WEAK_STACK.includes(tech));

  return (
    <>
      <ScrollArea style={{ flex: 1, minHeight: 0 }}>
        <Box p="lg" maw={860}>
          <Group gap="sm" mb="xs">
            <Text size="sm" c="dimmed">
              {card.domain}
            </Text>
            {card.sizeHint && <Badge color="gray">{card.sizeHint}</Badge>}
            {card.lastContactedAt && (
              <Badge color="yellow" leftSection={<Clock size={11} />}>
                писали {formatDate(card.lastContactedAt)}
              </Badge>
            )}
          </Group>

          <Title order={2}>{card.name}</Title>

          {card.description && (
            <Text mt="sm" c="dimmed">
              {card.description}
            </Text>
          )}

          {weak.length > 0 && (
            <Alert color="yellow" mt="md" title="Стек сайту слабкий">
              На сайті видно {weak.join(', ')}. Така студія рідко наймає React-розробника, лист майже напевно
              піде в нікуди.
            </Alert>
          )}

          <Group mt="md" gap="sm">
            <Button
              component="a"
              href={`https://${card.domain}`}
              target="_blank"
              rel="noreferrer"
              variant="light"
              leftSection={<ExternalLink size={14} />}
            >
              Сайт студії
            </Button>
            {card.careersUrl && (
              <Button component="a" href={card.careersUrl} target="_blank" rel="noreferrer" variant="subtle">
                Сторінка вакансій
              </Button>
            )}
            {card.sourceUrl && (
              <Button component="a" href={card.sourceUrl} target="_blank" rel="noreferrer" variant="subtle">
                Профіль у каталозі
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
              <DataList.ItemLabel>де</DataList.ItemLabel>
              <DataList.ItemValue>
                {[card.city, card.country].filter(Boolean).join(', ') || <Text c="dimmed">не вказано</Text>}
              </DataList.ItemValue>
            </DataList.Item>

            <DataList.Item>
              <DataList.ItemLabel>стек із сайту</DataList.ItemLabel>
              <DataList.ItemValue>
                {card.techHints.length === 0 ? (
                  <Text c="dimmed">не визначено</Text>
                ) : (
                  <Group gap={6}>
                    {card.techHints.map((tech) => (
                      <Badge key={tech} color={WEAK_STACK.includes(tech) ? 'red' : 'brand'}>
                        {tech}
                      </Badge>
                    ))}
                  </Group>
                )}
              </DataList.ItemValue>
            </DataList.Item>

            <DataList.Item>
              <DataList.ItemLabel>теги каталогу</DataList.ItemLabel>
              <DataList.ItemValue>
                {card.tags.length === 0 ? (
                  <Text c="dimmed">немає</Text>
                ) : (
                  <Group gap={6}>
                    {/* Каталоги пхають у теги все підряд, аж до часток відсотків.
                        Показуємо перші десять, решта в лічильнику. */}
                    {card.tags.slice(0, 10).map((tag) => (
                      <Badge key={tag} color="gray">
                        {tag}
                      </Badge>
                    ))}
                    {card.tags.length > 10 && (
                      <Text size="sm" c="dimmed">
                        ще {card.tags.length - 10}
                      </Text>
                    )}
                  </Group>
                )}
              </DataList.ItemValue>
            </DataList.Item>

            <DataList.Item>
              <DataList.ItemLabel>джерела</DataList.ItemLabel>
              <DataList.ItemValue>{card.sources.join(', ') || <Text c="dimmed">невідомо</Text>}</DataList.ItemValue>
            </DataList.Item>
          </DataList>

          {/* Іменні контакти цінніші за hello@, тому вони окремим блоком і вище за розбір рахунку. */}
          <Text size="xs" tt="uppercase" fw={500} c="dimmed" mt="lg" mb="xs" style={{ letterSpacing: '0.04em' }}>
            контакти
          </Text>
          {card.contacts.length === 0 ? (
            <Text c="dimmed" size="sm">
              іменних контактів немає. Пошта на сайті майже завжди hello@ або info@, її читає менеджер.
            </Text>
          ) : (
            <Stack gap={6}>
              {card.contacts.map((contact, position) => (
                <Group key={position} gap="xs">
                  <Mail size={14} color="var(--mantine-color-dimmed)" />
                  <Text fw={500}>{contact.name ?? contact.email}</Text>
                  {contact.role && (
                    <Badge color="gray" size="sm">
                      {contact.role}
                    </Badge>
                  )}
                  {contact.name && contact.email && (
                    <Anchor href={`mailto:${contact.email}`} size="sm">
                      {contact.email}
                    </Anchor>
                  )}
                </Group>
              ))}
            </Stack>
          )}

          <Text size="xs" tt="uppercase" fw={500} c="dimmed" mt="lg" mb="xs" style={{ letterSpacing: '0.04em' }}>
            звідки такий рахунок
          </Text>
          <Stack gap={4}>
            {card.why.map((item) => (
              <Group key={item.reason} gap="sm" wrap="nowrap">
                <Text
                  w={38}
                  ta="right"
                  fw={600}
                  className="tabular"
                  c={item.weight > 0 ? 'green.8' : 'red.8'}
                >
                  {item.weight > 0 ? '+' : ''}
                  {item.weight}
                </Text>
                <Text c="dimmed">{item.reason}</Text>
              </Group>
            ))}
          </Stack>
        </Box>
      </ScrollArea>

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
        <Tooltip label="прибрати зі списку на 60 днів">
          <Button
            variant="default"
            leftSection={<Clock size={15} />}
            rightSection={<Kbd size="xs">s</Kbd>}
            onClick={() => onAct({ action: 'snooze', days: 60 })}
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
            onClick={() => onAct({ action: 'contacted', templateUsed: template })}
          >
            Написав
          </Button>
        </Group>
      </PaneFooter>
    </>
  );
}

export function StudiosPage() {
  const client = useQueryClient();
  const [filters, setFilters] = useState({ q: '', country: '', min: '', all: '' });
  const [cursor, setCursor] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const { data, error, isLoading } = useQuery({
    queryKey: ['studios', filters],
    queryFn: () => api.studios(filters),
  });

  const act = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown>; name: string }) =>
      api.companyAction(id, body),
    onSuccess: (_result, { name }) => {
      notifications.show({ color: 'green', title: name, message: 'збережено' });
      void client.invalidateQueries({ queryKey: ['studios'] });
      void client.invalidateQueries({ queryKey: ['stats'] });
    },
    onError: (mutationError) =>
      notifications.show({ color: 'red', title: 'не збереглось', message: String(mutationError) }),
  });

  const cards = data?.cards ?? [];
  const index = Math.min(cursor, Math.max(0, cards.length - 1));
  const current = cards[index];

  useHotkeys(
    useMemo(
      () => ({
        j: () => setCursor((value) => Math.min(value + 1, cards.length - 1)),
        arrowdown: () => setCursor((value) => Math.min(value + 1, cards.length - 1)),
        k: () => setCursor((value) => Math.max(value - 1, 0)),
        arrowup: () => setCursor((value) => Math.max(value - 1, 0)),
      }),
      [cards.length],
    ),
    cards.length > 0,
  );

  if (error) {
    return (
      <Box p="lg">
        <Alert color="red" title="Не вдалось прочитати список студій">
          {error instanceof Error ? error.message : String(error)}
        </Alert>
      </Box>
    );
  }

  return (
    <SplitView
      listWidth={368}
      list={
        <>
          <PaneHeader>
            <TextInput
              placeholder="назва, домен або тег"
              leftSection={<Search size={14} />}
              value={filters.q}
              onChange={(event) => setFilters({ ...filters, q: event.currentTarget.value })}
              style={{ flex: 1 }}
            />
            <Button
              variant={filtersOpen ? 'light' : 'subtle'}
              onClick={() => setFiltersOpen((value) => !value)}
              px="sm"
            >
              Фільтри
            </Button>
          </PaneHeader>

          {filtersOpen && (
            <Stack gap="sm" p="md" style={{ borderBottom: '1px solid var(--mantine-color-gray-2)' }}>
              <Group gap="sm" grow>
                <TextInput
                  label="Країна"
                  placeholder="UA"
                  value={filters.country}
                  onChange={(event) => setFilters({ ...filters, country: event.currentTarget.value })}
                />
                <NumberInput
                  label="Мін. рахунок"
                  placeholder={String(data?.threshold ?? 5)}
                  value={filters.min}
                  onChange={(value) => setFilters({ ...filters, min: value === '' ? '' : String(value) })}
                />
              </Group>
              <Checkbox
                label="показати тих, кому вже писали"
                checked={filters.all === '1'}
                onChange={(event) => setFilters({ ...filters, all: event.currentTarget.checked ? '1' : '' })}
              />
            </Stack>
          )}

          <Group px="md" py={6} gap="xs" style={{ borderBottom: '1px solid var(--mantine-color-gray-2)' }}>
            <Text size="xs" c="dimmed">
              знайдено {cards.length}, поріг {data?.threshold ?? '-'}
            </Text>
            <Text size="xs" c="dimmed" ml="auto">
              <Kbd size="xs">j</Kbd> <Kbd size="xs">k</Kbd> перехід
            </Text>
          </Group>

          <ScrollArea style={{ flex: 1, minHeight: 0 }}>
            {isLoading &&
              Array.from({ length: 8 }, (_, position) => <Skeleton key={position} h={72} m="md" />)}
            {cards.map((card, position) => (
              <Row
                key={card.companyId}
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
            key={current.companyId}
            card={current}
            onAct={(body) => act.mutate({ id: current.companyId, body, name: current.name })}
          />
        ) : (
          <Box p="xl" style={{ flex: 1, display: 'grid', placeItems: 'center' }}>
            <EmptyState
              icon={<Palette size={28} />}
              withIndicatorBackground
              title={isLoading ? 'Читаю каталог' : 'Під ці фільтри нічого не підпало'}
              description="Знизь мінімальний рахунок або збери ще сторінок каталогу розширенням у браузері."
            />
          </Box>
        )
      }
    />
  );
}
