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
 * Outbox: the main working screen for sending.
 *
 * There is exactly one send button, for exactly one card. There is no bulk action on
 * purpose: section 0 of OUTREACH.md forbids autopilot, and "send all" is autopilot
 * under another name.
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
          sent today{' '}
          <Text span fw={600} className="tabular">
            {counters.sentToday} of {counters.limit}
          </Text>
        </Text>
        {counters.nextAllowedAt ? (
          <Tooltip label="a three minute pause between letters, fixed in code">
            <Badge color="yellow" variant="light" className="tabular">
              next in {timeLeft(counters.nextAllowedAt, now)}
            </Badge>
          </Tooltip>
        ) : counters.windowOpen ? (
          <Badge color="green" variant="light">
            ready to send
          </Badge>
        ) : (
          <Badge color="red" variant="light">
            sending closed
          </Badge>
        )}
      </Group>
      <Progress value={share} color={share >= 100 ? 'red' : 'blue'} size="sm" />
      {counters.bounceRate > 0 && (
        <Text size="xs" c="dimmed" mt={6}>
          bounces over recent letters: {Math.round(counters.bounceRate * 100)} percent
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

  // The card may have been regenerated or swapped: the fields must follow the data.
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
   * Picking an address brings its name along, because the name is in the letter text.
   * Typing an address by hand leaves the name alone: an address not yet in the database
   * was just found by the owner, and only the owner knows who is behind it.
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
      // A typed address becomes a company contact, so the studio card is stale too.
      void client.invalidateQueries({ queryKey: ['studios'] });
    },
    onError: (failure: Error) =>
      notifications.show({ color: 'red', title: 'not saved', message: failure.message }),
  });

  /*
   * The template is visible and can be swapped right here. Code picks by role and language,
   * but a person sees the specific company and knows things the database does not, so
   * moving the letter onto another text must take one move, not rebuilding the draft.
   * The first paragraph is kept on a swap.
   */
  const { data: templates } = useQuery({ queryKey: ['templates'], queryFn: () => api.templates() });

  const templateOptions = (templates?.templates ?? [])
    .filter((row) => !row.archived && row.kind !== 'resume')
    .map((row) => ({ value: row.slug, label: `${row.name}, ${row.language}` }));

  const retemplate = useMutation({
    mutationFn: (slug: string) => api.retemplateDraft(draft.id, slug),
    onSuccess: () => client.invalidateQueries({ queryKey: ['drafts'] }),
    onError: (failure: Error) =>
      notifications.show({ color: 'red', title: 'template not changed', message: failure.message }),
  });

  const regenerate = useMutation({
    mutationFn: () => api.regenerateIntro(draft.id),
    onSuccess: () => client.invalidateQueries({ queryKey: ['drafts'] }),
    onError: (failure: Error) =>
      notifications.show({ color: 'red', title: 'intro not regenerated', message: failure.message }),
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
            The name leads to the company card in the app, not to its site.
            The owner returns to a draft a week after writing it, and "which company
            is this" is the first question. The site answers it worse than the card,
            which holds the stack, score, contacts and history.
          */}
          <Group gap={6} align="center">
            <Text fw={600}>{draft.company}</Text>
            <Tooltip label="company card: stack, contacts, correspondence history">
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
            {draft.contactEmail ?? 'no address'}
            {draft.vacancyTitle ? ` | ${draft.vacancyTitle}` : ''}
          </Text>
        </div>
        <Group gap={6}>
          <Select
            size="xs"
            w={210}
            data={templateOptions}
            value={draft.templateUsed}
            placeholder={templateOptions.length === 0 ? 'no templates' : 'no template'}
            disabled={templateOptions.length === 0 || retemplate.isPending}
            allowDeselect={false}
            onChange={(slug) => slug && slug !== draft.templateUsed && retemplate.mutate(slug)}
          />
          <Tooltip label={draft.aiFallbackReason ?? (draft.aiUsed ? 'first paragraph by the model' : 'first paragraph from the template')}>
            <Badge variant="light" color={draft.aiUsed ? 'violet' : 'gray'}>
              {draft.aiUsed ? 'AI' : 'template'}
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
        The address is either picked from those found for this company or typed in.

        The field is exactly this rather than a plain list: half the addresses in the
        database are generic, which is why the owner keeps finding better ones by eye on
        their site. A list without free input would send them to another section to add
        it, and free input without a list would mean recalling what is already stored.
        A typed address becomes a company contact at once and shows on the studio card.
      */}
      <Autocomplete
        label="address"
        size="xs"
        placeholder="pick a found one or type your own"
        data={options.map((item) => item.email)}
        value={email}
        error={!email.trim() ? 'no letter goes out without an address' : deadEmail ? 'this address hard bounced' : undefined}
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
                  dead
                </Badge>
              )}
            </Group>
          );
        }}
        mb={4}
      />

      {/*
        Who exactly receives the letter is shown on its own line. The name is in the
        letter text, so picking an address changes the greeting too, and that has to be
        visible before sending, not after.
      */}
      <Text size="xs" c="dimmed" mb="xs">
        {name ? `the letter addresses ${name}` : 'greeting without a name'}
        {options.length > 0 ? `, addresses found: ${options.length}` : ', no other addresses in the database'}
      </Text>

      <TextInput
        label="subject"
        size="xs"
        value={subject}
        onChange={(event) => setSubject(event.currentTarget.value)}
        mb="xs"
      />
      <Textarea
        label={`body, ${words} words`}
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
            Send
          </Button>
          <Button
            size="xs"
            variant="default"
            disabled={!dirty}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            Save edits
          </Button>
          <Button
            size="xs"
            variant="subtle"
            loading={regenerate.isPending}
            onClick={() => regenerate.mutate()}
          >
            Regenerate intro
          </Button>
        </Group>
        <Button
          size="xs"
          variant="subtle"
          color="red"
          leftSection={<Trash2 size={14} />}
          onClick={() => onDiscard(draft.id)}
        >
          Skip
        </Button>
      </Group>
      {dirty && (
        <Text size="xs" c="dimmed" mt={6}>
          save the edits first, the letter goes out with exactly the text stored in the database
        </Text>
      )}
    </Card>
  );
}

export function SendingPage() {
  const client = useQueryClient();
  /*
   * The tab lives in the address too: `#/sending/attention` links to what needs
   * attention, and it can be kept for tomorrow or dropped into a reminder.
   */
  const [chosen, setChosen] = useSelection('sending');
  const tab = chosen ?? 'ready';
  const setTab = (value: string | null) => setChosen(value === 'ready' ? null : value);
  const [blockersById, setBlockersById] = useState<Record<number, Blocker[]>>({});
  const [now, setNow] = useState(() => Date.now());

  // The pause timer must tick on its own, otherwise the button stays grey until a reload.
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
        title: 'drafts prepared',
        message: `new ${result.created}, need attention ${result.needsAttention}`,
      });
      void client.invalidateQueries({ queryKey: ['drafts'] });
    },
  });

  const send = useMutation({
    mutationFn: (id: number) => api.sendDraft(id),
    onSuccess: (result, id) => {
      if (result.sent) {
        setBlockersById((current) => ({ ...current, [id]: [] }));
        notifications.show({ color: 'green', title: 'sent', message: 'the letter went out' });
      } else {
        setBlockersById((current) => ({ ...current, [id]: result.blockers }));
        notifications.show({
          color: 'red',
          title: 'letter not sent',
          message: result.blockers[0]?.message ?? 'unknown reason',
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
          Prepare drafts
        </Button>
      </Group>

      <Tabs value={tab} onChange={setTab}>
        <Tabs.List>
          <Tabs.Tab value="ready">Ready {ready.length}</Tabs.Tab>
          <Tabs.Tab value="attention">Need attention {attention.length}</Tabs.Tab>
        </Tabs.List>
      </Tabs>

      {list.length === 0 ? (
        <Text size="sm" c="dimmed">
          {tab === 'attention'
            ? 'nothing is stuck'
            : 'no drafts, prepare them with the button above'}
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
