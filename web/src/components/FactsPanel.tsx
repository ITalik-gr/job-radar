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
 * Факти про власника для AI-абзацу.
 *
 * Це whitelist: модель має право згадати тільки те, що тут увімкнене, а
 * валідатор перевіряє результат окремо і відкочує абзац на шаблонний, якщо в
 * ньому зʼявилось щось стороннє. Тому список короткий і конкретний, а не резюме.
 *
 * Живе в модалці, а не окремим блоком під редактором: список потрібен раз на
 * місяць, а внизу сторінки він ще й не розкривався, бо там нема куди рости.
 */

/** Приклади, а не порожні поля: без них незрозуміло, якого розміру має бути факт. */
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
      <Tooltip label="що модель має право згадати про тебе в першому абзаці">
        <Button
          variant="default"
          size="xs"
          leftSection={<Sparkles size={14} />}
          onClick={() => setOpen(true)}
        >
          Факти для AI
          <Badge size="xs" ml={6} color={active > 0 ? 'blue' : 'gray'} variant="light">
            {active}
          </Badge>
        </Button>
      </Tooltip>

      <Modal opened={open} onClose={() => setOpen(false)} title="Факти про тебе для AI-абзацу" size="lg">
        <Text size="xs" c="dimmed">
          Перший абзац листа модель пише про компанію. Ці факти вона має право згадати
          про тебе, і нічого поза списком. Вимкнений факт зникає з промпта одразу, для
          всіх наступних листів.
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
              <Tooltip label="видалити факт">
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="red"
                  onClick={() => remove.mutate(fact.id)}
                  aria-label="видалити факт"
                >
                  <Trash2 size={14} />
                </ActionIcon>
              </Tooltip>
            </Group>
          ))}

          {rows.length === 0 && (
            <Box>
              <Text size="xs" c="dimmed" mb={6}>
                Фактів немає, модель писатиме тільки про компанію. Можна взяти приклад:
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
                    {example.uk}
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
            label="ключ"
            description="назва для тебе"
            placeholder="stack"
            value={key}
            onChange={(event) => setKey(event.currentTarget.value)}
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
          />
          <TextInput
            size="xs"
            label="українською"
            placeholder="3+ роки комерційного досвіду"
            value={textUk}
            onChange={(event) => setTextUk(event.currentTarget.value)}
            style={{ flex: 1 }}
          />
          <TextInput
            size="xs"
            label="англійською"
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
            Додати
          </Button>
        </Group>
        <Text size="xs" c="dimmed" mt={6}>
          Обидві мови обовʼязкові: лист українській компанії йде українською, решті
          англійською, і підмінити одну мову іншою тут нічим.
        </Text>
      </Modal>
    </>
  );
}
