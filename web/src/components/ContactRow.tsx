import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Anchor, Badge, Button, Group, Text, TextInput, Tooltip, UnstyledButton } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Mail, Pencil, Trash2 } from 'lucide-react';
import { api, type CompanyContact } from '../lib/api';

/**
 * A contact row with in-place editing.
 *
 * Collection brings halves: a team page gives a name and a title with no address, a
 * contact page gives an address with no name, and some addresses are only visible to
 * the eye. Without this edit the only way to join the halves was to add yet another
 * row, so two halves became three, and none of them was a contact.
 *
 * A field stays empty until something is typed in: empty means "none", not "leave it",
 * and a cleared field is cleared. The server merges rows when the edited address matches
 * an existing one, so making a duplicate here is hard.
 */
export function ContactRow({ companyId, contact }: { companyId: number; contact: CompanyContact }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(contact.name ?? '');
  const [role, setRole] = useState(contact.role ?? '');
  const [email, setEmail] = useState(contact.email ?? '');

  /* The same row appears on the studio card and on the company card, so both lists are refreshed. */
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: ['studios'] });
    void client.invalidateQueries({ queryKey: ['company', companyId] });
  };

  const reset = () => {
    setName(contact.name ?? '');
    setRole(contact.role ?? '');
    setEmail(contact.email ?? '');
    setEditing(false);
  };

  const save = useMutation({
    mutationFn: () => api.updateContact(companyId, contact.id, { name, role, email }),
    onSuccess: (result) => {
      setEditing(false);
      invalidate();
      notifications.show({
        color: 'green',
        title: result.contact.name ?? result.contact.email ?? 'contact',
        message:
          result.merged > 0
            ? `saved, merged with an existing row (${result.merged})`
            : 'saved',
      });
    },
    onError: (error: Error) =>
      notifications.show({ color: 'red', title: 'not saved', message: error.message }),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteContact(companyId, contact.id),
    onSuccess: () => {
      invalidate();
      notifications.show({ color: 'gray', title: 'contact deleted', message: contact.name ?? contact.email ?? '' });
    },
    onError: (error: Error) =>
      notifications.show({ color: 'red', title: 'not deleted', message: error.message }),
  });

  if (!editing) {
    return (
      <Group gap="xs" wrap="nowrap">
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
        {/* Show a half contact as such right away: otherwise it is unclear what this contact lacks. */}
        {contact.name && !contact.email && (
          <Text size="xs" c="dimmed">
            no address
          </Text>
        )}
        {!contact.emailValid && (
          <Badge color="red" size="sm" variant="light">
            dead address
          </Badge>
        )}
        <Tooltip label="edit: add an address to a person or a name to an address">
          <UnstyledButton
            onClick={() => setEditing(true)}
            style={{ display: 'flex', alignItems: 'center', color: 'var(--mantine-color-dimmed)' }}
          >
            <Pencil size={13} />
          </UnstyledButton>
        </Tooltip>
      </Group>
    );
  }

  return (
    <Group gap="xs" align="end" wrap="wrap">
      <TextInput
        size="xs"
        w={150}
        label="name"
        placeholder="empty means none"
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
      />
      <TextInput
        size="xs"
        w={130}
        label="title"
        placeholder="CTO"
        value={role}
        onChange={(event) => setRole(event.currentTarget.value)}
      />
      <TextInput
        size="xs"
        w={220}
        label="email"
        placeholder="anna@studio.com"
        value={email}
        onChange={(event) => setEmail(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') save.mutate();
          if (event.key === 'Escape') reset();
        }}
      />
      <Button size="xs" loading={save.isPending} onClick={() => save.mutate()}>
        Save
      </Button>
      <Button size="xs" variant="subtle" onClick={reset}>
        Cancel
      </Button>
      <Tooltip label="delete: collection regularly picks up an investor from a testimonial or a client from a case study">
        <Button size="xs" variant="subtle" color="red" loading={remove.isPending} onClick={() => remove.mutate()}>
          <Trash2 size={13} />
        </Button>
      </Tooltip>
    </Group>
  );
}
