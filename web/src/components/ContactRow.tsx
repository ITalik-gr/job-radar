import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Anchor, Badge, Button, Group, Text, TextInput, Tooltip, UnstyledButton } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Mail, Pencil, Trash2 } from 'lucide-react';
import { api, type CompanyContact } from '../lib/api';

/**
 * Рядок контакту з правкою на місці.
 *
 * Збір приносить половинки: зі сторінки команди імʼя з посадою без адреси, зі
 * сторінки контактів адресу без імені, а частину адрес видно тільки очима. Без
 * цієї правки звести половинки докупи можна було лише заведенням ще одного рядка,
 * тобто з двох половинок виходило три, і жодна з них не була контактом.
 *
 * Поле лишається порожнім, поки в нього не вписали: порожнє означає "немає", а не
 * "не чіпати", і стерте поле стирається. Сервер зливає рядки, якщо після правки
 * адреса збіглася з наявною, тому дублікат тут зробити важко.
 */
export function ContactRow({ companyId, contact }: { companyId: number; contact: CompanyContact }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(contact.name ?? '');
  const [role, setRole] = useState(contact.role ?? '');
  const [email, setEmail] = useState(contact.email ?? '');

  /* Той самий рядок стоїть і в картці студії, і в картці компанії, тому оновлюються обидва списки. */
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
        title: result.contact.name ?? result.contact.email ?? 'контакт',
        message:
          result.merged > 0
            ? `збережено, злито з наявним рядком (${result.merged})`
            : 'збережено',
      });
    },
    onError: (error: Error) =>
      notifications.show({ color: 'red', title: 'не збереглось', message: error.message }),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteContact(companyId, contact.id),
    onSuccess: () => {
      invalidate();
      notifications.show({ color: 'gray', title: 'контакт видалено', message: contact.name ?? contact.email ?? '' });
    },
    onError: (error: Error) =>
      notifications.show({ color: 'red', title: 'не видалилось', message: error.message }),
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
        {/* Половинка видно одразу: інакше незрозуміло, чого цьому контакту бракує. */}
        {contact.name && !contact.email && (
          <Text size="xs" c="dimmed">
            адреси немає
          </Text>
        )}
        {!contact.emailValid && (
          <Badge color="red" size="sm" variant="light">
            адреса мертва
          </Badge>
        )}
        <Tooltip label="правити: дописати пошту людині або імʼя до адреси">
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
        label="імʼя"
        placeholder="порожньо означає немає"
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
      />
      <TextInput
        size="xs"
        w={130}
        label="посада"
        placeholder="CTO"
        value={role}
        onChange={(event) => setRole(event.currentTarget.value)}
      />
      <TextInput
        size="xs"
        w={220}
        label="пошта"
        placeholder="anna@studio.com"
        value={email}
        onChange={(event) => setEmail(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') save.mutate();
          if (event.key === 'Escape') reset();
        }}
      />
      <Button size="xs" loading={save.isPending} onClick={() => save.mutate()}>
        Зберегти
      </Button>
      <Button size="xs" variant="subtle" onClick={reset}>
        Скасувати
      </Button>
      <Tooltip label="видалити: у збір регулярно потрапляє інвестор з відгуку або клієнт з кейсу">
        <Button size="xs" variant="subtle" color="red" loading={remove.isPending} onClick={() => remove.mutate()}>
          <Trash2 size={13} />
        </Button>
      </Tooltip>
    </Group>
  );
}
