import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Anchor,
  Autocomplete,
  Badge,
  Button,
  Group,
  Paper,
  Progress,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  CircleCheck,
  FileText,
  Globe,
  Inbox,
  Landmark,
  Mail,
  RefreshCw,
  Save,
  Send,
  SkipForward,
  Timer,
  TriangleAlert,
  UserRound,
} from 'lucide-react';
import { api, type Blocker, type DraftRow, type SendCounters } from '../lib/api';
import { companyHref } from '../lib/route';
import { useSelection } from '../lib/useRoute';
import { MonoLabel, PageHeader } from '../components/ui';

/**
 * Outbox: the main working screen for sending.
 *
 * There is exactly one send button, for exactly one card. There is no bulk action on
 * purpose: rule 10 in CLAUDE.md forbids autopilot, and "send all" is autopilot
 * under another name.
 */

export function timeLeft(until: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((until - now) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export function Counters({ counters, now }: { counters: SendCounters; now: number }) {
  const share = counters.limit === 0 ? 0 : (counters.sentToday / counters.limit) * 100;

  return (
    <Paper px="md" py="sm">
      <Group justify="space-between" align="flex-end" mb={8} wrap="nowrap">
        <div>
          <MonoLabel>sent today</MonoLabel>
          <Text className="display tabular" fz={24} lh={1.15} mt={2}>
            {counters.sentToday}
            <Text span c="gray.5" fz={16}>
              {' '}
              / {counters.limit}
            </Text>
          </Text>
        </div>
        <SendState counters={counters} now={now} />
      </Group>
      <Progress value={share} color={share >= 100 ? 'red' : 'ink'} size={4} />
      {counters.bounceRate > 0 && (
        <Text size="xs" c="dimmed" mt={6}>
          bounces over recent letters: {Math.round(counters.bounceRate * 100)} percent
        </Text>
      )}
    </Paper>
  );
}

/** Whether a letter can go out right now: the pause timer, an open window, or closed. */
function SendState({ counters, now }: { counters: SendCounters; now: number }) {
  if (counters.nextAllowedAt) {
    return (
      <Tooltip label="a three minute pause between letters, fixed in code">
        <Badge color="yellow" size="lg" leftSection={<Timer size={13} />} className="tabular">
          next in {timeLeft(counters.nextAllowedAt, now)}
        </Badge>
      </Tooltip>
    );
  }
  return counters.windowOpen ? (
    <Badge color="green" size="lg" variant="dot">
      ready to send
    </Badge>
  ) : (
    <Tooltip label="letters go out 08:00 to 22:00 on weekdays, or the daily limit is reached">
      <Badge color="red" size="lg" variant="dot">
        sending closed
      </Badge>
    </Tooltip>
  );
}

export function DraftCard({
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

  // The template may have been swapped: the fields must follow the data.
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

  const dirty =
    subject !== (draft.subject ?? '') ||
    body !== (draft.body ?? '') ||
    email.trim() !== (draft.contactEmail ?? '') ||
    name !== draft.contactName;
  const words = body.trim().split(/\s+/).filter(Boolean).length;

  return (
    <Paper p="md">
      <Group justify="space-between" align="start" mb="sm" wrap="nowrap">
        <div style={{ minWidth: 0 }}>
          {/*
            The name leads to the company card in the app, not to its site.
            The owner returns to a draft a week after writing it, and "which company
            is this" is the first question. The site answers it worse than the card,
            which holds the stack, score, contacts and history.
          */}
          <Group gap={8} align="center" wrap="nowrap">
            <Tooltip label="company card: stack, contacts, correspondence history">
              <Anchor href={companyHref(draft.domain)} c="ink" className="display" fz={17} truncate>
                {draft.company}
              </Anchor>
            </Tooltip>
            {draft.domain && (
              <Anchor
                href={`https://${draft.domain}`}
                target="_blank"
                rel="noreferrer"
                size="xs"
                c="dimmed"
                className="mono"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}
              >
                <Globe size={12} />
                {draft.domain}
              </Anchor>
            )}
          </Group>
          <Group gap={12} mt={4} wrap="nowrap">
            <Group gap={4} wrap="nowrap">
              <UserRound size={13} color="var(--mantine-color-gray-6)" />
              <Text size="xs" c="gray.7" truncate>
                {draft.contactName ? `${draft.contactName}, ` : ''}
                {draft.contactEmail ?? 'no address'}
              </Text>
            </Group>
            {draft.leadTitle && (
              <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
                <Landmark size={13} color="var(--mantine-color-brand-6)" />
                <Text size="xs" c="gray.7" truncate>
                  {draft.leadTitle}
                </Text>
              </Group>
            )}
          </Group>
        </div>
        <Group gap={6} wrap="nowrap">
          <Select
            size="xs"
            w={210}
            leftSection={<FileText size={13} />}
            data={templateOptions}
            value={draft.templateUsed}
            placeholder={templateOptions.length === 0 ? 'no templates' : 'no template'}
            disabled={templateOptions.length === 0 || retemplate.isPending}
            allowDeselect={false}
            onChange={(slug) => slug && slug !== draft.templateUsed && retemplate.mutate(slug)}
          />
          {draft.language && (
            <Badge color="gray" className="mono">
              {draft.language}
            </Badge>
          )}
        </Group>
      </Group>

      {draft.error && (
        <Alert color="yellow" icon={<TriangleAlert size={16} />} mb="xs" p="xs">
          {draft.error}
        </Alert>
      )}

      {blockers.length > 0 && (
        <Alert color="red" icon={<TriangleAlert size={16} />} mb="xs" p="xs" title="Send checks failed">
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
        label="Address"
        size="xs"
        leftSection={<Mail size={13} />}
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
        label="Subject"
        size="xs"
        value={subject}
        onChange={(event) => setSubject(event.currentTarget.value)}
        mb="xs"
      />
      <Textarea
        label={
          <>
            Body{' '}
            <Text span size="xs" c={words > 160 ? 'red' : 'dimmed'} className="mono">
              {words} / 160 words
            </Text>
          </>
        }
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
            variant="filled"
            leftSection={<Send size={15} />}
            loading={sending}
            disabled={dirty}
            onClick={() => onSend(draft.id)}
          >
            Send
          </Button>
          <Button
            variant="default"
            leftSection={<Save size={15} />}
            disabled={!dirty}
            loading={save.isPending}
            onClick={() => save.mutate()}
          >
            Save edits
          </Button>
        </Group>
        <Button
          variant="subtle"
          color="red"
          leftSection={<SkipForward size={15} />}
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
    </Paper>
  );
}

/**
 * One click sends one draft. The server runs every guard again; a refusal comes back as blockers
 * that the draft card shows. Shared by this page and the letter drawer on the company page.
 */
export function useSendDraft(
  setBlockersById: React.Dispatch<React.SetStateAction<Record<number, Blocker[]>>>,
) {
  const client = useQueryClient();
  return useMutation({
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
      void client.invalidateQueries({ queryKey: ['company'] });
    },
  });
}

/** The pause timer must tick on its own, otherwise the button stays grey until a reload. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function SendingPage() {
  const client = useQueryClient();
  /*
   * The tab lives in the address too: `#/sending/attention` links to what needs
   * attention, and it can be kept for tomorrow or dropped into a reminder.
   */
  const [chosen, setChosen] = useSelection('sending');
  const tab = chosen ?? 'ready';
  const setTab = (value: string) => setChosen(value === 'ready' ? null : value);
  const [blockersById, setBlockersById] = useState<Record<number, Blocker[]>>({});
  const now = useNow();

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

  const send = useSendDraft(setBlockersById);

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

  const list = tab === 'attention' ? attention : ready;

  return (
    <>
      <PageHeader
        icon={Send}
        title="Outbox"
        description="Ready letter drafts. One click sends one letter; every send check runs again on the server."
      >
        <Button
          variant="filled"
          leftSection={<RefreshCw size={15} />}
          loading={prepare.isPending}
          onClick={() => prepare.mutate()}
        >
          Prepare drafts
        </Button>
      </PageHeader>

      {error ? (
        <Alert color="red" m="lg" title="Could not read the drafts">
          {(error as Error).message}
        </Alert>
      ) : isLoading || !data ? (
        <Text size="sm" c="dimmed" p="lg">
          loading
        </Text>
      ) : (
        <Stack gap="md" p="lg" maw={980}>
          <Counters counters={data.counters} now={now} />

          <SegmentedControl
            size="sm"
            w="fit-content"
            value={tab}
            onChange={setTab}
            data={[
              { value: 'ready', label: `Ready ${ready.length}` },
              { value: 'attention', label: `Need attention ${attention.length}` },
            ]}
          />

          {list.length === 0 ? (
            <Paper p="lg">
              <Group gap="sm">
                {tab === 'attention' ? (
                  <CircleCheck size={18} color="var(--mantine-color-green-7)" />
                ) : (
                  <Inbox size={18} color="var(--mantine-color-gray-6)" />
                )}
                <Text size="sm" c="gray.7">
                  {tab === 'attention'
                    ? 'Nothing is stuck.'
                    : 'No drafts. Prepare them with the button above, or build one from a company page.'}
                </Text>
              </Group>
            </Paper>
          ) : (
            list.map((draft) => (
              <DraftCard
                key={draft.id}
                draft={draft}
                sending={send.isPending && send.variables === draft.id}
                blockers={blockersById[draft.id] ?? []}
                onSend={(id) => send.mutate(id)}
                onDiscard={(id) => discard.mutate(id)}
              />
            ))
          )}
        </Stack>
      )}
    </>
  );
}
