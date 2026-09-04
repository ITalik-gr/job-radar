import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ActionIcon, Button, Checkbox, Group, Paper, Stack, Text, TextInput } from '@mantine/core';
import { Trash2 } from 'lucide-react';
import { api } from '../lib/api';

/**
 * Факти про власника, які модель має право згадати в першому абзаці.
 *
 * Галочка це і є весь контроль: вимкнений факт зникає з промпта, і жоден лист
 * більше його не згадає. Тексти пише власник, тут вони лише лежать.
 */
export function FactsPanel() {
  const client = useQueryClient();
  const [key, setKey] = useState('');
  const [textUk, setTextUk] = useState('');
  const [textEn, setTextEn] = useState('');

  const { data } = useQuery({ queryKey: ['facts'], queryFn: () => api.facts() });
  const refresh = () => client.invalidateQueries({ queryKey: ['facts'] });

  const create = useMutation({
    mutationFn: () => api.createFact({ key, textUk, textEn }),
    onSuccess: () => {
      setKey('');
      setTextUk('');
      setTextEn('');
      void refresh();
    },
  });

  const toggle = useMutation({
    mutationFn: ({ id, isActive }: { id: number; isActive: boolean }) =>
      api.updateFact(id, { isActive }),
    onSuccess: refresh,
  });

  const remove = useMutation({ mutationFn: api.deleteFact, onSuccess: refresh });

  return (
    <Paper withBorder p="sm">
      <Text size="sm" fw={600} mb={4}>
        Факти для AI-абзацу
      </Text>
      <Text size="xs" c="dimmed" mb="xs">
        Модель не має права згадати нічого, чого немає в цьому списку.
      </Text>

      <Stack gap={6} mb="sm">
        {(data ?? []).map((fact) => (
          <Group key={fact.id} justify="space-between" gap="xs" wrap="nowrap">
            <Checkbox
              size="xs"
              checked={fact.isActive}
              label={`${fact.key}: ${fact.textUk}`}
              onChange={(event) =>
                toggle.mutate({ id: fact.id, isActive: event.currentTarget.checked })
              }
            />
            <ActionIcon
              size="sm"
              variant="subtle"
              color="red"
              onClick={() => remove.mutate(fact.id)}
              aria-label="видалити факт"
            >
              <Trash2 size={14} />
            </ActionIcon>
          </Group>
        ))}
        {(data ?? []).length === 0 && (
          <Text size="xs" c="dimmed">
            фактів немає, модель писатиме тільки про компанію
          </Text>
        )}
      </Stack>

      <Group gap="xs" align="end">
        <TextInput size="xs" label="ключ" value={key} onChange={(e) => setKey(e.currentTarget.value)} w={100} />
        <TextInput size="xs" label="українською" value={textUk} onChange={(e) => setTextUk(e.currentTarget.value)} style={{ flex: 1 }} />
        <TextInput size="xs" label="англійською" value={textEn} onChange={(e) => setTextEn(e.currentTarget.value)} style={{ flex: 1 }} />
        <Button size="xs" disabled={!key || !textUk || !textEn} loading={create.isPending} onClick={() => create.mutate()}>
          Додати
        </Button>
      </Group>
    </Paper>
  );
}
