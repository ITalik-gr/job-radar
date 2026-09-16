import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Anchor,
  Autocomplete,
  Badge,
  Button,
  Card,
  Group,
  Progress,
  ScrollArea,
  Select,
  Skeleton,
  Stack,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Building2, CircleAlert, RefreshCw, Send, Trash2 } from 'lucide-react';
import { api, type Blocker, type DraftRow, type SendCounters } from '../lib/api';
import { companyHref } from '../lib/route';
import { useSelection } from '../lib/useRoute';

/**
 * "До відправки": головний робочий екран розсилки.
 *
 * Кнопка надсилання рівно одна і рівно на одну картку. Масової дії тут немає
 * навмисно: розділ 0 OUTREACH.md забороняє автопілот, а "надіслати всі" це
 * автопілот з іншою назвою.
 */

function timeLeft(until: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((until - now) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function Counters({ counters, now }: { counters: SendCounters; now: number }) {
  const share = counters.limit === 0 ? 0 : (counters.sentToday / counters.limit) * 100;

  return (
    <Card withBorder p="sm">
      <Group justify="space-between" mb={6}>
        <Text size="sm">
          надіслано сьогодні{' '}
          <Text span fw={600} className="tabular">
            {counters.sentToday} з {counters.limit}
          </Text>
        </Text>
        {counters.nextAllowedAt ? (
          <Tooltip label="пауза між листами три хвилини, зашита в код">
            <Badge color="yellow" variant="light" className="tabular">
              наступний через {timeLeft(counters.nextAllowedAt, now)}
            </Badge>
          </Tooltip>
        ) : counters.windowOpen ? (
          <Badge color="green" variant="light">
            можна слати
          </Badge>
        ) : (
          <Badge color="red" variant="light">
            відправка закрита
          </Badge>
        )}
      </Group>
      <Progress value={share} color={share >= 100 ? 'red' : 'blue'} size="sm" />
      {counters.bounceRate > 0 && (
        <Text size="xs" c="dimmed" mt={6}>
          баунси за останні листи: {Math.round(counters.bounceRate * 100)} відсотків
        </Text>
      )}
    </Card>
  );
}

function DraftCard({
  draft,
  onSend,
  onDiscard,
  sending,
  blockers,
}: {
  draft: DraftRow;
  onSend: (id: number) => void;
  onDiscard: (id: number) => void;
  sending: boolean;
  blockers: Blocker[];
}) {
  const client = useQueryClient();
  const [subject, setSubject] = useState(draft.subject ?? '');
  const [body, setBody] = useState(draft.body ?? '');
  const [email, setEmail] = useState(draft.contactEmail ?? '');
  const [name, setName] = useState(draft.contactName);

  // Картку могли перегенерувати або відкрити іншу: поля мусять іти за даними.
  useEffect(() => {
    setSubject(draft.subject ?? '');
    setBody(draft.body ?? '');
    setEmail(draft.contactEmail ?? '');
    setName(draft.contactName);
  }, [draft.id, draft.subject, draft.body, draft.contactEmail, draft.contactName]);

  const options = draft.companyContacts;
  const chosen = options.find((item) => item.email === email.trim().toLowerCase());
  const deadEmail = chosen ? !chosen.emailValid : false;

  /*
   * Вибір адреси тягне за собою імʼя, бо воно стоїть у самому тексті листа.
   * Ручний ввід імені не чіпає: адресу, якої в базі ще немає, власник щойно
   * знайшов очима, і хто за нею стоїть, знає тільки він.
   */
  const onEmail = (value: string) => {
    setEmail(value);
    const match = options.find((item) => item.email === value.trim().toLowerCase());
    if (match) setName(match.name);
  };

  const save = useMutation({
    mutationFn: () =>
      api.updateDraft(draft.id, {
        subject,
        body,
        contactEmail: email.trim() || null,
        contactName: name,
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['drafts'] });
      // Вписана адреса заводиться контактом компанії, тому картка студії теж застаріла.
      void client.invalidateQueries({ queryKey: ['studios'] });
    },
    onError: (failure: Error) =>
      notifications.show({ color: 'red', title: 'не збереглось', message: failure.message }),
  });

  /*
   * Шаблон видно і його можна замінити прямо тут. Вибір за роллю і мовою робить код,
   * але людина бачить конкретну компанію і знає про неї те, чого немає в базі, тому
   * перекласти лист на інший текст мусить бути одним рухом, а не збиранням чернетки
   * заново. Перший абзац при заміні зберігається.
   */
  const { data: templates } = useQuery({ queryKey: ['templates'], queryFn: () => api.templates() });

  const templateOptions = (templates?.templates ?? [])
    .filter((row) => !row.archived && row.kind !== 'resume')
    .map((row) => ({ value: row.slug, label: `${row.name}, ${row.language}` }));

  const retemplate = useMutation({
    mutationFn: (slug: string) => api.retemplateDraft(draft.id, slug),
    onSuccess: () => client.invalidateQueries({ queryKey: ['drafts'] }),
    onError: (failure: Error) =>
      notifications.show({ color: 'red', title: 'шаблон не змінився', message: failure.message }),
  });

  const regenerate = useMutation({
    mutationFn: () => api.regenerateIntro(draft.id),
    onSuccess: () => client.invalidateQueries({ queryKey: ['drafts'] }),
    onError: (failure: Error) =>
      notifications.show({ color: 'red', title: 'абзац не перегенерувався', message: failure.message }),
  });

  const dirty =
    subject !== (draft.subject ?? '') ||
    body !== (draft.body ?? '') ||
    email.trim() !== (draft.contactEmail ?? '') ||
    name !== draft.contactName;
  const words = body.trim().split(/\s+/).filter(Boolean).length;

  return (
    <Card withBorder p="md">
      <Group justify="space-between" align="start" mb="xs">
        <div>
          {/*
            Назва веде на картку компанії в застосунку, а не на її сайт.
            До чернетки власник повертається через тиждень після того, як склав її,
            і "що це за контора" це перше питання. Сайт відповідає на нього гірше
            за власну картку: у ній лежать стек, рахунок, контакти і історія.
          */}
          <Group gap={6} align="center">
            <Text fw={600}>{draft.company}</Text>
            <Tooltip label="картка компанії: стек, контакти, історія листування">
              <Anchor href={companyHref(draft.domain)} c="dimmed" style={{ display: 'flex' }}>
                <Building2 size={14} />
              </Anchor>
            </Tooltip>
            <Anchor href={`https://${draft.domain}`} target="_blank" rel="noreferrer" size="xs" c="dimmed">
              {draft.domain}
            </Anchor>
          </Group>
          <Text size="xs" c="dimmed">
            {draft.contactName ? `${draft.contactName}, ` : ''}
            {draft.contactEmail ?? 'адреси немає'}
            {draft.vacancyTitle ? ` | ${draft.vacancyTitle}` : ''}
          </Text>
        </div>
        <Group gap={6}>
          <Select
            size="xs"
            w={210}
            data={templateOptions}
            value={draft.templateUsed}
            placeholder={templateOptions.length === 0 ? 'шаблонів немає' : 'без шаблона'}
            disabled={templateOptions.length === 0 || retemplate.isPending}
            allowDeselect={false}
            onChange={(slug) => slug && slug !== draft.templateUsed && retemplate.mutate(slug)}
          />
          <Tooltip label={draft.aiFallbackReason ?? (draft.aiUsed ? 'перший абзац від моделі' : 'перший абзац із шаблона')}>
            <Badge variant="light" color={draft.aiUsed ? 'violet' : 'gray'}>
              {draft.aiUsed ? 'AI' : 'шаблон'}
            </Badge>
          </Tooltip>
          <Badge variant="light" color="gray">
            {draft.language ?? ''}
          </Badge>
        </Group>
      </Group>

      {draft.error && (
        <Alert color="yellow" icon={<CircleAlert size={16} />} mb="xs" p="xs">
          {draft.error}
        </Alert>
      )}

      {blockers.length > 0 && (
        <Alert color="red" icon={<CircleAlert size={16} />} mb="xs" p="xs">
          <Stack gap={2}>
            {blockers.map((blocker) => (
              <Text key={blocker.code} size="sm">
                {blocker.message}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}

      {/*
        Адреса або обирається зі знайдених у цієї компанії, або вписується руками.

        Поле саме таке, а не список: половина адрес у базі загальні, і рівно тому
        власник регулярно знаходить кращу очима на їхньому сайті. Список без
        ручного вводу змусив би його йти вписувати її в іншому розділі, а ручний
        ввід без списку змусив би згадувати напамʼять те, що вже лежить у базі.
        Вписана адреса одразу стає контактом компанії і видно її на картці студії.
      */}
      <Autocomplete
        label="адреса"
        size="xs"
        placeholder="обери знайдену або впиши свою"
        data={options.map((item) => item.email)}
        value={email}
        error={!email.trim() ? 'без адреси лист не піде' : deadEmail ? 'ця адреса дала hard bounce' : undefined}
        onChange={onEmail}
        renderOption={({ option }) => {
          const found = options.find((item) => item.email === option.value);
          return (
            <Group gap={6} wrap="nowrap">
              <Text size="xs">{option.value}</Text>
              {found?.name && (
                <Text size="xs" c="dimmed">
                  {found.name}
                  {found.role ? `, ${found.role}` : ''}
                </Text>
              )}
              {found && !found.emailValid && (
                <Badge size="xs" color="red" variant="light">
                  мертва
                </Badge>
              )}
            </Group>
          );
        }}
        mb={4}
      />

      {/*
        Кому саме йде лист, показується окремим рядком. Імʼя стоїть у тексті
        листа, тому вибір адреси змінює і звертання, і це має бути видно до
        відправки, а не після.
      */}
      <Text size="xs" c="dimmed" mb="xs">
        {name ? `лист звертається до ${name}` : 'звертання без імені'}
        {options.length > 0 ? `, знайдено адрес: ${options.length}` : ', інших адрес у базі немає'}
      </Text>

      <TextInput
        label="тема"
        size="xs"
        value={subject}
        onChange={(event) => setSubject(event.currentTarget.value)}
        mb="xs"
      />
      <Textarea
        label={`текст, ${words} слів`}
        size="xs"
        autosize
        minRows={8}
        maxRows={24}
        value={body}
        onChange={(event) => setBody(event.currentTarget.value)}
      />

      <Group justify="space-between" mt="sm">
        <Group gap="xs">
          <Button
            size="xs"
            leftSection={<Send size={14} />}
            loading={sending}
            disabled={dirty}
            onClick={() => onSend(draft.id)}
          >
            Надіслати
          </Button>
          <Button
            size="xs"
            variant="default"
            disabled={!dirty}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            Зберегти правки
          </Button>
          <Button
            size="xs"
            variant="subtle"
            loading={regenerate.isPending}
            onClick={() => regenerate.mutate()}
          >
            Перегенерувати абзац
          </Button>
        </Group>
        <Button
          size="xs"
          variant="subtle"
          color="red"
          leftSection={<Trash2 size={14} />}
          onClick={() => onDiscard(draft.id)}
        >
          Пропустити
        </Button>
      </Group>
      {dirty && (
        <Text size="xs" c="dimmed" mt={6}>
          спершу збережіть правки, лист іде рівно тим текстом, який лежить у базі
        </Text>
      )}
    </Card>
  );
}

export function SendingPage() {
  const client = useQueryClient();
  /*
   * Вкладка теж в адресі: `#/sending/attention` це посилання на те, що
   * потребує уваги, і його можна лишити собі на завтра або кинути в нагадування.
   */
  const [chosen, setChosen] = useSelection('sending');
  const tab = chosen ?? 'ready';
  const setTab = (value: string | null) => setChosen(value === 'ready' ? null : value);
  const [blockersById, setBlockersById] = useState<Record<number, Blocker[]>>({});
  const [now, setNow] = useState(() => Date.now());

  // Таймер паузи має цокати сам, інакше кнопка лишається сірою до перезавантаження.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const { data, isLoading, error } = useQuery({
    queryKey: ['drafts'],
    queryFn: () => api.drafts(),
    refetchInterval: 60_000,
  });

  const prepare = useMutation({
    mutationFn: () => api.prepareDrafts(),
    onSuccess: (result) => {
      notifications.show({
        color: 'blue',
        title: 'чернетки зібрано',
        message: `нових ${result.created}, потребують уваги ${result.needsAttention}`,
      });
      void client.invalidateQueries({ queryKey: ['drafts'] });
    },
  });

  const send = useMutation({
    mutationFn: (id: number) => api.sendDraft(id),
    onSuccess: (result, id) => {
      if (result.sent) {
        setBlockersById((current) => ({ ...current, [id]: [] }));
        notifications.show({ color: 'green', title: 'надіслано', message: 'лист пішов' });
      } else {
        setBlockersById((current) => ({ ...current, [id]: result.blockers }));
        notifications.show({
          color: 'red',
          title: 'лист не пішов',
          message: result.blockers[0]?.message ?? 'причина невідома',
        });
      }
      void client.invalidateQueries({ queryKey: ['drafts'] });
      void client.invalidateQueries({ queryKey: ['outreach'] });
    },
  });

  const discard = useMutation({
    mutationFn: (id: number) => api.discardDraft(id),
    onSuccess: () => client.invalidateQueries({ queryKey: ['drafts'] }),
  });

  const { ready, attention } = useMemo(() => {
    const rows = data?.drafts ?? [];
    return {
      ready: rows.filter((row) => !row.error),
      attention: rows.filter((row) => row.error),
    };
  }, [data]);

  if (error) return <Alert color="red" m="lg">{(error as Error).message}</Alert>;
  if (isLoading || !data) return <Skeleton h={320} m="lg" />;

  const list = tab === 'attention' ? attention : ready;

  return (
    <Stack gap="sm" p="lg">
      <Group justify="space-between">
        <Counters counters={data.counters} now={now} />
        <Button
          size="xs"
          variant="default"
          leftSection={<RefreshCw size={14} />}
          loading={prepare.isPending}
          onClick={() => prepare.mutate()}
        >
          Зібрати чернетки
        </Button>
      </Group>

      <Tabs value={tab} onChange={setTab}>
        <Tabs.List>
          <Tabs.Tab value="ready">Готові {ready.length}</Tabs.Tab>
          <Tabs.Tab value="attention">Потребують уваги {attention.length}</Tabs.Tab>
        </Tabs.List>
      </Tabs>

      {list.length === 0 ? (
        <Text size="sm" c="dimmed">
          {tab === 'attention'
            ? 'нічого не застрягло'
            : 'чернеток немає, зберіть їх кнопкою вище'}
        </Text>
      ) : (
        <ScrollArea.Autosize mah="calc(100vh - 260px)">
          <Stack gap="sm">
            {list.map((draft) => (
              <DraftCard
                key={draft.id}
                draft={draft}
                sending={send.isPending && send.variables === draft.id}
                blockers={blockersById[draft.id] ?? []}
                onSend={(id) => send.mutate(id)}
                onDiscard={(id) => discard.mutate(id)}
              />
            ))}
          </Stack>
        </ScrollArea.Autosize>
      )}
    </Stack>
  );
}
