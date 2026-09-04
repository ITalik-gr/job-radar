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
import { TemplateSelect } from '../components/TemplateSelect';
import { Score } from '../components/Score';
import { LetterBlock } from '../components/LetterBlock';
import { SimilarBlock } from '../components/SimilarBlock';

/** Підписи типів компаній. Той самий перелік, що в `src/pipeline/company-kind.ts`. */
const KIND_LABELS: Record<string, string> = {
  studio: 'студія',
  design: 'дизайн-студія',
  startup: 'стартап',
  product: 'продукт',
  outstaff: 'аутстаф',
  unknown: 'тип невідомий',
};

const KIND_COLORS: Record<string, string> = {
  studio: 'brand',
  design: 'grape',
  startup: 'green',
  product: 'gray',
  outstaff: 'yellow',
  unknown: 'gray',
};

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
            {/* Оцінка видно вже у списку: інакше репутацію треба відкривати по одній картці. */}
            {card.rating !== null && (
              <Badge size="xs" color={card.rating >= 4.5 ? 'green' : card.rating >= 4 ? 'gray' : 'yellow'}>
                {card.rating.toFixed(1)}
                {card.reviewsCount ? ` · ${card.reviewsCount}` : ''}
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

/**
 * Каталоги пхають у теги все підряд, аж до часток відсотків і ставок за годину.
 * Тому за замовчуванням видно перші десять, а решта розкривається і згортається
 * назад: раніше лічильник "ще 6" був просто текстом і нічого не робив.
 */
function TagList({ tags, limit = 10 }: { tags: string[]; limit?: number }) {
  const [expanded, setExpanded] = useState(false);
  const hidden = tags.length - limit;
  const visible = expanded ? tags : tags.slice(0, limit);

  return (
    <Group gap={6}>
      {visible.map((tag) => (
        <Badge key={tag} color="gray">
          {tag}
        </Badge>
      ))}
      {hidden > 0 && (
        <Anchor component="button" type="button" size="sm" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'згорнути' : `ще ${hidden}`}
        </Anchor>
      )}
    </Group>
  );
}

function Detail({ card, onAct }: { card: StudioCard; onAct: (body: Record<string, unknown>) => void }) {
  const [template, setTemplate] = useState<string | null>(null);

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
            <Badge color={KIND_COLORS[card.kind] ?? 'gray'}>{KIND_LABELS[card.kind] ?? card.kind}</Badge>
            {card.sizeHint && <Badge color="gray">{card.sizeHint}</Badge>}
            {/*
              Оцінка і відгуки поруч із назвою навмисно: це найшвидша відповідь на
              питання "чи є там кому читати лист", і заради неї не треба розкривати картку.
            */}
            {card.rating !== null && (
              <Badge color={card.rating >= 4.5 ? 'green' : card.rating >= 4 ? 'gray' : 'yellow'}>
                {card.rating.toFixed(1)}
                {card.reviewsCount !== null && ` · ${card.reviewsCount} відгуків`}
              </Badge>
            )}
            {card.rating === null && card.reviewsCount !== null && (
              <Badge color="gray">{card.reviewsCount} відгуків</Badge>
            )}
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

          {/*
            Мертвий сайт видно одразу, ще до того як власник почне писати лист.
            Рік береться з копірайту футера, дата з найсвіжішої публікації.
          */}
          {(() => {
            const yearsBehind = card.copyrightYear ? new Date().getFullYear() - card.copyrightYear : 0;
            const silentDays = card.lastPostAt
              ? Math.round((Date.now() - card.lastPostAt) / 86_400_000)
              : 0;
            if (yearsBehind < 2 && silentDays < 540) return null;

            return (
              <Alert color="yellow" mt="md" icon={<Clock size={16} />} title="Схоже, сайт покинутий">
                {yearsBehind >= 2 && `Копірайт ${card.copyrightYear} року. `}
                {silentDays >= 540 && `Останній пост ${silentDays} днів тому. `}
                Такі студії рідко відповідають на листи.
              </Alert>
            );
          })()}

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
              {card.kind === 'startup' ? 'Сайт стартапу' : 'Сайт студії'}
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

            {(card.hourlyRate || card.minProject || card.foundedYear) && (
              <DataList.Item>
                <DataList.ItemLabel>каталог</DataList.ItemLabel>
                <DataList.ItemValue>
                  <Group gap={6}>
                    {card.hourlyRate && <Badge color="gray">ставка {card.hourlyRate}</Badge>}
                    {card.minProject && <Badge color="gray">проєкт від {card.minProject}</Badge>}
                    {card.foundedYear && <Badge color="gray">з {card.foundedYear}</Badge>}
                  </Group>
                </DataList.ItemValue>
              </DataList.Item>
            )}

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
                  <TagList tags={card.tags} />
                )}
              </DataList.ItemValue>
            </DataList.Item>

            <DataList.Item>
              <DataList.ItemLabel>джерела</DataList.ItemLabel>
              <DataList.ItemValue>{card.sources.join(', ') || <Text c="dimmed">невідомо</Text>}</DataList.ItemValue>
            </DataList.Item>

            {/*
              Блок "Інше": усе, що каталог показав понад відомі поля. Набір різний
              у кожного каталогу, тому це просто пари підпис-значення, без колонок.
            */}
            {Object.entries(card.extra ?? {}).map(([label, value]) => (
              <DataList.Item key={label}>
                <DataList.ItemLabel>{label.toLowerCase()}</DataList.ItemLabel>
                <DataList.ItemValue>{value}</DataList.ItemValue>
              </DataList.Item>
            ))}
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

          <SimilarBlock companyId={card.companyId} />

          <LetterBlock
            company={card.name}
            domain={card.domain}
            kind={card.kind}
            stack={card.techHints}
            contactName={card.contacts.find((contact) => contact.name)?.name ?? null}
            contactEmail={
              card.contacts.find((contact) => contact.name && contact.email)?.email ??
              card.contacts.find((contact) => contact.email)?.email ??
              null
            }
            templateKind="studio"
          />

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
        <Tooltip label="статус «цікава»: студія лишається в цьому списку і зʼявляється у фільтрі Компаній. Лист не надсилається">
          <Button
            color="green"
            leftSection={<Check size={15} />}
            rightSection={<Kbd size="xs">i</Kbd>}
            onClick={() => onAct({ action: 'interesting' })}
          >
            Цікаво
          </Button>
        </Tooltip>
        <Tooltip label="статус «відкинув сам»: студія зникає зі списку назовсім, але лишається в базі">
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
          <TemplateSelect kind="studio" value={template} onChange={setTemplate} width={150} />
          <Tooltip label="позначити, що лист уже надіслано. Запис іде в Контакти, фолоу-ап нагадає через 7 днів">
            <Button
              leftSection={<Send size={15} />}
              rightSection={<Kbd size="xs">e</Kbd>}
              disabled={!template}
              onClick={() =>
              onAct({
                action: 'contacted',
                templateUsed: template,
                // Знімок контакту: через рік у Контактах має бути видно, кому саме писали.
                contactName: card.contacts.find((contact) => contact.name)?.name ?? null,
                contactEmail:
                  card.contacts.find((contact) => contact.name && contact.email)?.email ??
                  card.contacts.find((contact) => contact.email)?.email ??
                  null,
              })
            }
            >
              Написав
            </Button>
          </Tooltip>
        </Group>
      </PaneFooter>
    </>
  );
}

export interface CompanyListProps {
  /** Порожнє означає всі, крім продуктових. */
  kind?: string;
  emptyTitle?: string;
  emptyHint?: string;
}

/**
 * Студії і Стартапи це той самий екран з різним зрізом бази, тому сторінка
 * параметризована типом, а не скопійована вдруге на триста рядків.
 */
export function StudiosPage({ kind, emptyTitle, emptyHint }: CompanyListProps = {}) {
  const client = useQueryClient();
  const [filters, setFilters] = useState({ q: '', country: '', min: '', all: '', named: '', rating: '' });
  const [cursor, setCursor] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const query = useMemo(() => ({ ...filters, ...(kind ? { kind } : {}) }), [filters, kind]);

  const { data, error, isLoading } = useQuery({
    queryKey: ['studios', query],
    queryFn: () => api.studios(query),
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
              <NumberInput
                label="Мін. оцінка в каталозі"
                description="компанії без оцінки не показуються"
                placeholder="4.5"
                step={0.1}
                min={0}
                max={5}
                value={filters.rating}
                onChange={(value) => setFilters({ ...filters, rating: value === '' ? '' : String(value) })}
              />
              <Checkbox
                label="показати тих, кому вже писали"
                checked={filters.all === '1'}
                onChange={(event) => setFilters({ ...filters, all: event.currentTarget.checked ? '1' : '' })}
              />
              {/* Головний робочий фільтр: лист на hello@ читає менеджер, не техлід. */}
              <Checkbox
                label="тільки з іменним контактом"
                checked={filters.named === '1'}
                onChange={(event) =>
                  setFilters({ ...filters, named: event.currentTarget.checked ? '1' : '' })
                }
              />
            </Stack>
          )}

          <Group px="md" py={8} gap="xs" style={{ borderBottom: '1px solid var(--mantine-color-gray-2)' }}>
            {/* Різниця між total і aboveThreshold це головне число тут: без нього
                короткий список читається як зламаний збір, хоча база повна. */}
            <Text size="xs" c="dimmed">
              {data ? `${cards.length} з ${data.total} компаній` : 'читаю'}
              {data && data.total > data.aboveThreshold && (
                <Tooltip label="поріг можна змінити на сторінці Правила">
                  <Text span c="dimmed">
                    {' '}
                    · поріг {data.threshold} приховав {data.total - data.aboveThreshold}
                  </Text>
                </Tooltip>
              )}
            </Text>
            {/*
              Вивантаження звичайним посиланням, а не через fetch: браузер сам
              збереже файл за заголовком content-disposition, і не треба возитись з blob.
            */}
            <Anchor
              href={`/api/export/studios${filters.named === '1' ? '?named=1' : ''}`}
              size="xs"
              ml="auto"
              download
            >
              CSV
            </Anchor>
            <Text size="xs" c="dimmed">
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
              title={isLoading ? 'Читаю каталог' : (emptyTitle ?? 'Під ці фільтри нічого не підпало')}
              description={
                emptyHint ??
                'Знизь мінімальний рахунок або збери ще сторінок каталогу розширенням у браузері.'
              }
            />
          </Box>
        )
      }
    />
  );
}
