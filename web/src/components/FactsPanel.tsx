import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Group,
  Modal,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { Plus, Sparkles, Trash2 } from 'lucide-react';
import { api } from '../lib/api';

/**
 * Facts about the owner for the AI paragraph.
 *
 * This is a whitelist: the model may mention only what is switched on here, and a
 * validator checks the result separately and falls back to the template paragraph if
 * anything else shows up in it. So the list is short and concrete, not a resume.
 *
 * It lives in a modal rather than a block under the editor: the list is needed once a
 * month, and at the bottom of the page it could not even expand, having no room to grow.
 */

/** Examples rather than empty fields: without them it is unclear how big a fact should be. */
const EXAMPLES = [
  { key: 'stack', uk: 'React, Next.js, TypeScript, Node', en: 'React, Next.js, TypeScript, Node' },
  { key: 'years', uk: '3+ роки комерційного досвіду', en: '3+ years of commercial experience' },
  { key: 'ai', uk: 'інтеграції з Anthropic API', en: 'Anthropic API integrations' },
];

export function FactsPanel() {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
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

  const rows = data ?? [];
  const active = rows.filter((row) => row.isActive).length;
  const ready = key.trim() && textUk.trim() && textEn.trim();

  return (
    <>
      <Tooltip label="what the model may say about you in the first paragraph">
        <Button
          variant="default"
          size="xs"
          leftSection={<Sparkles size={14} />}
          onClick={() => setOpen(true)}
        >
          AI facts
          <Badge size="xs" ml={6} color={active > 0 ? 'blue' : 'gray'} variant="light">
            {active}
          </Badge>
        </Button>
      </Tooltip>

      <Modal opened={open} onClose={() => setOpen(false)} title="Facts about you for the AI paragraph" size="lg">
        <Text size="xs" c="dimmed">
          The model writes the first paragraph of a letter about the company. These are
          the facts it may mention about you, and nothing outside the list. A switched off
          fact leaves the prompt at once, for every letter that follows.
        </Text>

        <Stack gap={4} mt="sm">
          {rows.map((fact) => (
            <Group key={fact.id} justify="space-between" gap="xs" wrap="nowrap">
              <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                <Switch
                  size="xs"
                  checked={fact.isActive}
                  onChange={(event) =>
                    toggle.mutate({ id: fact.id, isActive: event.currentTarget.checked })
                  }
                />
                <Badge
                  size="xs"
                  color="gray"
                  style={{ fontFamily: 'var(--mantine-font-family-monospace)' }}
                >
                  {fact.key}
                </Badge>
                <Text size="xs" truncate c={fact.isActive ? undefined : 'dimmed'}>
                  {fact.textUk}
                </Text>
                <Text size="xs" c="dimmed" truncate>
                  {fact.textEn}
                </Text>
              </Group>
              <Tooltip label="delete fact">
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="red"
                  onClick={() => remove.mutate(fact.id)}
                  aria-label="delete fact"
                >
                  <Trash2 size={14} />
                </ActionIcon>
              </Tooltip>
            </Group>
          ))}

          {rows.length === 0 && (
            <Box>
              <Text size="xs" c="dimmed" mb={6}>
                No facts yet, the model will write only about the company. Pick an example:
              </Text>
              <Group gap={6}>
                {EXAMPLES.map((example) => (
                  <Badge
                    key={example.key}
                    variant="light"
                    color="gray"
                    style={{ cursor: 'pointer' }}
                    onClick={() => {
                      setKey(example.key);
                      setTextUk(example.uk);
                      setTextEn(example.en);
                    }}
                  >
                    {example.en}
                  </Badge>
                ))}
              </Group>
            </Box>
          )}
        </Stack>

        <Group gap="xs" align="end" mt="md" wrap="nowrap">
          <TextInput
            size="xs"
            w={110}
            label="key"
            description="a name for yourself"
            placeholder="stack"
            value={key}
            onChange={(event) => setKey(event.currentTarget.value)}
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
          />
          <TextInput
            size="xs"
            label="Ukrainian"
            placeholder="3+ роки комерційного досвіду"
            value={textUk}
            onChange={(event) => setTextUk(event.currentTarget.value)}
            style={{ flex: 1 }}
          />
          <TextInput
            size="xs"
            label="English"
            placeholder="3+ years of commercial experience"
            value={textEn}
            onChange={(event) => setTextEn(event.currentTarget.value)}
            style={{ flex: 1 }}
          />
          <Button
            size="xs"
            leftSection={<Plus size={14} />}
            disabled={!ready}
            loading={create.isPending}
            onClick={() => create.mutate()}
          >
            Add
          </Button>
        </Group>
        <Text size="xs" c="dimmed" mt={6}>
          Both languages are required: a letter to a Ukrainian company goes out in
          Ukrainian, to everyone else in English, and nothing here can stand in for the
          missing one.
        </Text>
      </Modal>
    </>
  );
}
