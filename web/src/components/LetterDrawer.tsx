import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Drawer, Group, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { CircleCheck, FilePlus2, Send } from 'lucide-react';
import { api, type Blocker, type StudioCard } from '../lib/api';
import { Counters, DraftCard, useNow, useSendDraft } from '../pages/Sending';
import { LetterBlock } from './LetterBlock';
import { MonoLabel } from './ui';

/**
 * The letter, as a drawer over the company page: closing it returns to whatever was under it.
 *
 * Two states. Without a draft it shows the owner's template filled for this company and one
 * button that builds the draft. With a draft it shows the same card as the Outbox: the address,
 * the text, the send checks and the pause timer, and the one Send button (rule 10: every letter
 * is a human click, the server runs every guard again).
 */
export function LetterDrawer({
  card,
  opened,
  onClose,
}: {
  card: StudioCard;
  opened: boolean;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [template, setTemplate] = useState<string | null>(null);
  const [blockersById, setBlockersById] = useState<Record<number, Blocker[]>>({});
  const now = useNow();

  const drafts = useQuery({ queryKey: ['drafts'], queryFn: () => api.drafts(), enabled: opened });
  const draft = drafts.data?.drafts.find((row) => row.companyId === card.companyId) ?? null;

  const send = useSendDraft(setBlockersById);
  const discard = useMutation({
    mutationFn: (id: number) => api.discardDraft(id),
    onSuccess: () => client.invalidateQueries({ queryKey: ['drafts'] }),
  });

  const build = useMutation({
    mutationFn: () => api.draftForCompany(card.companyId, template),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ['drafts'] });
      if (result.reason) notifications.show({ color: 'yellow', title: card.name, message: result.reason });
    },
    onError: (error: Error) => notifications.show({ color: 'red', title: 'no draft', message: error.message }),
  });

  const named = card.contacts.find((contact) => contact.name);
  const email =
    card.contacts.find((contact) => contact.name && contact.email && contact.emailValid)?.email ??
    card.contacts.find((contact) => contact.email && contact.emailValid)?.email ??
    null;

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size={640}
      padding="lg"
      title={
        <Group gap={10}>
          <Send size={18} strokeWidth={1.75} />
          <Text className="display" fz={18}>
            Letter to {card.name}
          </Text>
        </Group>
      }
    >
      {drafts.isLoading && (
        <Text size="sm" c="dimmed">
          loading
        </Text>
      )}

      {drafts.data && (
        <Stack gap="md">
          <Counters counters={drafts.data.counters} now={now} />

          {draft ? (
            <>
              <Group gap={6}>
                <CircleCheck size={15} color="var(--mantine-color-green-7)" />
                <Text size="sm" c="gray.7">
                  The draft is ready. Send checks run again on the server when you press Send.
                </Text>
              </Group>
              <DraftCard
                draft={draft}
                sending={send.isPending && send.variables === draft.id}
                blockers={blockersById[draft.id] ?? []}
                onSend={(id) => send.mutate(id)}
                onDiscard={(id) => discard.mutate(id)}
              />
            </>
          ) : (
            <>
              <div>
                <MonoLabel>recipient</MonoLabel>
                <Text size="sm" mt={2}>
                  {named?.name ? `${named.name}${named.role ? `, ${named.role}` : ''}, ` : ''}
                  {email ?? 'no email yet: building the draft crawls the site for one'}
                </Text>
              </div>

              <LetterBlock
                company={card.name}
                domain={card.domain}
                kind={card.kind}
                stack={card.techHints}
                contactName={named?.name ?? null}
                contactEmail={email}
                city={card.city}
                country={card.country}
                industry={card.industry}
                slug={template}
                onSlug={setTemplate}
                templateKind="studio"
              />

              {!email && (
                <Alert color="yellow" p="xs">
                  No valid address for this company. The draft can still be built, and the address typed in it.
                </Alert>
              )}

              <Group>
                <Button
                  variant="filled"
                  leftSection={<FilePlus2 size={15} />}
                  loading={build.isPending}
                  onClick={() => build.mutate()}
                >
                  Build the draft
                </Button>
                <Text size="xs" c="dimmed">
                  The draft is the template above with the values filled in. It is sent from here or from the Outbox, one click per letter.
                </Text>
              </Group>
            </>
          )}
        </Stack>
      )}
    </Drawer>
  );
}
