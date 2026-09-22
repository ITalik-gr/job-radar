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
 * Labels keyed by the real types, not free strings. A Record over the union means a new
 * company kind or a new sending role breaks the build here until it is added to the list.
 * These lists used to live on their own and fall behind the code silently: the database
 * already had a kind the select did not.
 *
 * Only types are imported, so pipeline files with the database stay out of the front end bundle.
 */
const KIND_LABELS: Record<TemplateKind, string> = {
  vacancy: 'for a vacancy',
  studio: 'for a studio',
  resume: 'resume',
};

const KIND_OPTIONS = Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label }));

/**
 * The sending role. This is what a draft picks its template by, and code makes the choice:
 * there is a vacancy, there is a named contact, or there is only a generic mailbox.
 */
const TARGET_LABELS: Record<OutreachTarget, string> = {
  vacancy: 'has an open vacancy',
  studio_named: 'no vacancy, named contact',
  studio_generic: 'no vacancy, generic mailbox',
  followup: 'follow-up, second letter in the thread',
};

const TARGET_OPTIONS = Object.entries(TARGET_LABELS).map(([value, label]) => ({ value, label }));

const LANGUAGE_OPTIONS: { value: Language; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'uk', label: 'Ukrainian' },
];

/**
 * An empty `forKind` means "any kind". It is a list item of its own rather than a clear
 * button on the side: a universal template is a deliberate choice, and the field has to
 * read like any other option.
 */
const ANY_KIND = '__any';

const FOR_KIND_LABELS: Record<CompanyKind, string> = {
  studio: 'development studio',
  design: 'design studio',
  startup: 'startup',
  product: 'product company',
  outstaff: 'outstaffing',
  // Some companies really have this kind, and letters get written for them too.
  unknown: 'kind not determined',
};

const FOR_KIND_OPTIONS = [
  { value: ANY_KIND, label: 'universal, any kind' },
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
            archived
          </Badge>
        )}
      </Group>
      <Group gap={6} mt={4} wrap="nowrap">
        <Badge size="xs" color={row.kind === 'resume' ? 'brand' : 'gray'}>
          {KIND_LABELS[row.kind as TemplateKind] ?? row.kind}
        </Badge>
        {/* A template with a role takes part in sending on its own, the rest are for copying. */}
        {row.targetType && (
          <Badge size="xs" color="blue" variant="light">
            sending, {row.language}
          </Badge>
        )}
        <Text size="xs" c="dimmed" truncate>
          {row.body ? `${row.body.length} characters` : 'no text yet'}
        </Text>
        {/* How many letters this template has produced: shows what is in use and what is a draft. */}
        {row.usageCount > 0 && (
          <Badge size="xs" color="brand" variant="light">
            {row.usageCount} letter{row.usageCount === 1 ? '' : 's'}
          </Badge>
        )}
      </Group>
    </UnstyledButton>
  );
}

/**
 * The fields this form edits. One list serves two uses: it builds both what goes to the
 * server and the "unsaved changes" flag.
 *
 * These used to be two hand-written field lists in different places, and they drifted:
 * language, sending role and first paragraph made it into neither. The button stayed
 * grey, and when a change elsewhere enabled it, the select values silently never reached
 * the database and came back unchanged.
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
  /** The other templates: needed to spot sending role clashes. */
  all: TemplateRow[];
  onSelect: (id: number | null) => void;
}) {
  const client = useQueryClient();
  const [draft, setDraft] = useState(row);
  const [confirming, setConfirming] = useState(false);

  /*
   * Resetting the draft is tied to `updatedAt`, not to the object itself. The template list
   * is refetched after any mutation, and each refetch produced a new object: half-written
   * text in the editor got overwritten with what was already in the database.
   */
  useEffect(() => {
    setDraft(row);
    setConfirming(false);
  }, [row.id, row.updatedAt]);

  const save = useMutation({
    mutationFn: () => api.updateTemplate(row.id, patchFrom(draft)),
    onSuccess: () => {
      notifications.show({ color: 'green', title: draft.name, message: 'template saved' });
      void client.invalidateQueries({ queryKey: ['templates'] });
    },
    onError: (error) =>
      notifications.show({
        color: 'red',
        title: 'Not saved',
        message: error instanceof Error ? error.message : String(error),
      }),
  });

  const fail = (error: unknown) =>
    notifications.show({
      color: 'red',
      title: 'Failed',
      message: error instanceof Error ? error.message : String(error),
    });

  const archive = useMutation({
    mutationFn: () => (row.archived ? api.restoreTemplate(row.id) : api.archiveTemplate(row.id)),
    onSuccess: () => {
      notifications.show({
        color: 'green',
        title: draft.name,
        message: row.archived ? 'restored from archive' : 'archived',
      });
      void client.invalidateQueries({ queryKey: ['templates'] });
    },
    onError: fail,
  });

  const duplicate = useMutation({
    mutationFn: () => api.duplicateTemplate(row.id),
    onSuccess: (copy) => {
      notifications.show({ color: 'green', title: copy.name, message: 'copy created' });
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
            ? `deleted. Contacts still hold ${result.keptInHistory} records with key ${result.slug}`
            : 'deleted',
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
   * Sending takes the first template with the needed role and language pair. Two such
   * templates are not a database error, but the choice between them becomes arbitrary, and
   * the owner will not understand why a letter went out with the wrong text. So the
   * editor says it outright.
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
                archived
              </Badge>
            )}
            <Badge size="sm" color={row.usageCount > 0 ? 'brand' : 'gray'} variant="light">
              {row.usageCount > 0 ? `used ${row.usageCount}` : 'not used yet'}
            </Badge>
            <Text size="xs" c="dimmed" ml="auto">
              updated {formatDate(row.updatedAt)}
            </Text>
          </Group>

          <Stack gap="md">
            <Group gap="md" grow>
              <TextInput
                label="Name"
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
              />
              <Select
                label="Kind"
                data={KIND_OPTIONS}
                value={draft.kind}
                onChange={(kind) => kind && setDraft({ ...draft, kind })}
                allowDeselect={false}
              />
              <Select
                label="For company kind"
                description="this template will be suggested first"
                data={FOR_KIND_OPTIONS}
                value={draft.forKind ?? ANY_KIND}
                onChange={(value) =>
                  value && setDraft({ ...draft, forKind: value === ANY_KIND ? null : value })
                }
                allowDeselect={false}
              />
            </Group>

            {/*
              Role and language are not decoration: they are what a draft picks the
              template by. An empty role means the template takes no part in sending and
              is kept for manual copying, which is normal for half the list.
            */}
            <Group grow align="start">
              <Select
                label="Sending role"
                description="when this template is used automatically"
                data={TARGET_OPTIONS}
                value={draft.targetType}
                onChange={(targetType) => setDraft({ ...draft, targetType })}
                placeholder="not used for sending, manual copying only"
                clearable
              />
              <Select
                label="Language"
                description="uk for companies in Ukraine, en for everyone else"
                data={LANGUAGE_OPTIONS}
                value={draft.language}
                onChange={(language) => language && setDraft({ ...draft, language })}
                allowDeselect={false}
              />
            </Group>

            {clash && (
              <Alert color="yellow">
                The same role and language are already set on <b>{clash.name}</b>. Sending will
                take one of the two, and which one cannot be predicted. Clear the role on one of
                them or archive it.
              </Alert>
            )}

            {/*
              The key is editable, and on change the radar rewrites it in the correspondence
              records. The label says exactly that: otherwise an edit would look like a break
              in the history.
            */}
            <TextInput
              label="History key"
              description={
                row.usageCount > 0
                  ? `stored in Contacts. If changed, ${row.usageCount} history records are rewritten to the new key`
                  : 'stored in Contacts. Spaces and case are normalised to lowercase underscores'
              }
              value={draft.slug}
              onChange={(event) => setDraft({ ...draft, slug: event.currentTarget.value })}
              styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
            />

            <TextInput
              label="Subject"
              description="may stay empty for a resume"
              value={draft.subject ?? ''}
              onChange={(event) => setDraft({ ...draft, subject: event.currentTarget.value })}
            />

            <Textarea
              label="First paragraph, static"
              description="replaces {{intro}}. Placeholders work here the same as in the body. The fallback uses it too when the model paragraph fails validation"
              autosize
              minRows={2}
              maxRows={6}
              value={draft.intro ?? ''}
              onChange={(event) => setDraft({ ...draft, intro: event.currentTarget.value })}
              styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 13 } }}
            />

            {/*
              A paragraph without its placeholder in the body goes nowhere. This must not be
              silent: the field looks filled in, yet the letter lacks it.
            */}
            {draft.intro?.trim() && !/\{\{\s*intro\s*\}\}/i.test(draft.body) && (
              <Alert color="yellow">
                The first paragraph is written, but the body has no {'{{intro}}'} placeholder, so it
                will not reach the letter. Put the placeholder where the paragraph belongs.
              </Alert>
            )}

            <Textarea
              label="Body"
              description="your text, the tool neither generates nor rewrites it"
              autosize
              minRows={12}
              maxRows={28}
              value={draft.body}
              onChange={(event) => setDraft({ ...draft, body: event.currentTarget.value })}
              styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 13 } }}
            />

            {/*
              Placeholders must be in view while writing: otherwise the owner either does not
              know they exist, or mistypes one and gets a blank.
            */}
            <Box>
              <Text size="sm" fw={500} mb={6}>
                What can go into the body and subject
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
                Click to append to the body. Empty values come out blank, and the radar warns
                about it before sending.
              </Text>
            </Box>

            <Textarea
              label="Note to self"
              description="when this template fits, what does not work in it"
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
          {dirty ? 'Save' : 'No changes'}
        </Button>

        {/* Facts sit next to the letter text, because that is what they affect. */}
        <FactsPanel />

        <Tooltip label="make a variant of this text with its own key">
          <Button
            variant="default"
            leftSection={<Copy size={15} />}
            loading={duplicate.isPending}
            onClick={() => duplicate.mutate()}
          >
            Duplicate
          </Button>
        </Tooltip>

        <Group gap="sm" ml="auto" wrap="nowrap">
          <Tooltip
            label={
              row.archived
                ? 'return to the selection lists'
                : 'remove from the selection lists. The template stays and can be restored'
            }
          >
            <Button
              variant="default"
              leftSection={row.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
              loading={archive.isPending}
              onClick={() => archive.mutate()}
            >
              {row.archived ? 'Unarchive' : 'Archive'}
            </Button>
          </Tooltip>

          <Tooltip label="delete for good. Records in Contacts stay, the key there is a snapshot">
            <Button
              variant="subtle"
              color="red"
              leftSection={<Trash2 size={15} />}
              onClick={() => setConfirming(true)}
            >
              Delete
            </Button>
          </Tooltip>
        </Group>
      </PaneFooter>

      {/*
        The confirmation shows how many letters use this key. Without that number deletion
        is blind: a draft and a template in use look the same.
      */}
      <Modal opened={confirming} onClose={() => setConfirming(false)} title={`Delete ${row.name}?`}>
        <Stack gap="md">
          <Text size="sm">
            The template will be gone for good. The text cannot be recovered, so if it may still be
            useful, archive it instead.
          </Text>
          {row.usageCount > 0 && (
            <Alert color="yellow">
              {row.usageCount} letters were written with this template. Records in Contacts stay put:
              they store the key <b>{row.slug}</b> as it was at send time, not a link to the template.
            </Alert>
          )}
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button color="red" loading={remove.isPending} onClick={() => remove.mutate()}>
              Delete for good
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

/**
 * The signature lives apart from the template texts.
 *
 * It is the same in every letter, and editing it in ten templates one by one means they
 * drift apart sooner or later. In a template body its place is marked with {{signature}},
 * and a template without the placeholder gets the signature appended: older templates
 * were written before the placeholder existed and must not go out unsigned.
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
      notifications.show({ color: 'green', title: 'Signature', message: 'saved' });
      onClose();
    },
    onError: (error: Error) =>
      notifications.show({ color: 'red', title: 'not saved', message: error.message }),
  });

  return (
    <Modal opened={opened} onClose={onClose} title="Letter signature">
      <Stack gap="md">
        <Textarea
          autosize
          minRows={3}
          maxRows={8}
          label="signature text"
          description="replaces {{signature}}, or is appended when the template has no placeholder"
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
          styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 13 } }}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            Save
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
   * The address carries the template key, not its id: `#/templates/send_studio_named_en`
   * reads well, `#/templates/7` says nothing. Internally the selection stays an id, which
   * is why renaming the key does not reset it: the id is unchanged and the address follows.
   */
  const [slug, selectSlug] = useSelection('templates');
  const [signing, setSigning] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('vacancy');

  const { data, error, isLoading } = useQuery({ queryKey: ['templates'], queryFn: () => api.templates() });

  const list = data?.templates ?? [];
  const opened = list.find((row) => row.id === selected) ?? list.find((row) => !row.archived) ?? list[0];

  // The address sets the selection when arriving from a link or pressing back.
  useEffect(() => {
    if (!slug) return;
    const found = list.find((row) => row.slug === slug);
    if (found && found.id !== selected) setSelected(found.id);
  }, [slug, list, selected]);

  // And the other way round: the selection sets the address, including after a key rename.
  useEffect(() => {
    if (opened && opened.slug !== slug) selectSlug(opened.slug);
  }, [opened, slug, selectSlug]);

  const create = useMutation({
    mutationFn: () => api.createTemplate({ name, kind }),
    onSuccess: (row) => {
      notifications.show({ color: 'green', title: row.name, message: 'template created' });
      setCreating(false);
      setName('');
      setSelected(row.id);
      void client.invalidateQueries({ queryKey: ['templates'] });
    },
    onError: (mutationError) =>
      notifications.show({
        color: 'red',
        title: 'Not created',
        message: mutationError instanceof Error ? mutationError.message : String(mutationError),
      }),
  });

  if (error) {
    return (
      <Box p="lg">
        <Alert color="red" title="Could not read the templates">
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

      <Modal opened={creating} onClose={() => setCreating(false)} title="New template">
        <Stack gap="md">
          <TextInput
            data-autofocus
            label="Name"
            placeholder="e.g. AI integration pitch"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            onKeyDown={(event) => event.key === 'Enter' && name.trim() && create.mutate()}
          />
          <Select
            label="Kind"
            data={KIND_OPTIONS}
            value={kind}
            onChange={(value) => value && setKind(value)}
            allowDeselect={false}
          />
          <Text size="xs" c="dimmed">
            The correspondence history key is derived from the name automatically, and can be
            changed later in the template itself.
          </Text>
          <Button disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>
            Create
          </Button>
        </Stack>
      </Modal>

      <SplitView
        listWidth={340}
        list={
          <>
            <PaneHeader>
              <Title order={5} style={{ flex: 1 }}>
                Templates
              </Title>
              <Button variant="default" onClick={() => setSigning(true)}>
                Signature
              </Button>
              <Button variant="default" leftSection={<Plus size={15} />} onClick={() => setCreating(true)}>
                New
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
                title={isLoading ? 'Loading templates' : 'No templates'}
                description="Create the first one: you write the text, the tool only stores it and records it in the contact history."
              />
            </Box>
          )
        }
      />
    </>
  );
}
