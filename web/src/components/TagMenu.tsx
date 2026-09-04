import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Menu, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Ban, ChevronDown, Minus, Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';

/**
 * Тег зі стеку вакансії, який можна одразу відправити у правила. Раніше побачити
 * термін і змінити його вагу були дві різні задачі в різних місцях: тег у картці,
 * а вага в config/scoring.json, який на проді взагалі не редагується.
 *
 * Ваги і стоп-слова діють на нові та перераховані записи, тому після правки
 * нагадуємо про перерахунок, а не робимо його тихо: перерахунок ходить по всій базі.
 */
export function TagMenu({ term }: { term: string }) {
  const client = useQueryClient();
  const { data } = useQuery({ queryKey: ['rules'], queryFn: () => api.rules() });

  const weight = data?.rules.weights.terms[term];
  const stopped = data?.rules.stopWords.includes(term) ?? false;

  const done = (message: string) => {
    notifications.show({
      color: 'green',
      title: term,
      message: `${message}. Щоб застосувати до наявних вакансій: Запустити, Перерахувати рахунки`,
    });
    void client.invalidateQueries({ queryKey: ['rules'] });
  };

  const fail = (error: unknown) =>
    notifications.show({
      color: 'red',
      title: term,
      message: error instanceof Error ? error.message : String(error),
    });

  const setWeight = useMutation({
    mutationFn: (next: number | null) => api.termWeight(term, next),
    onSuccess: (_result, next) => done(next === null ? 'вагу прибрано' : `вага ${next}`),
    onError: fail,
  });

  const setStop = useMutation({
    mutationFn: (remove: boolean) => api.stopWord(term, remove),
    onSuccess: (_result, remove) => done(remove ? 'прибрано зі стоп-слів' : 'у стоп-словах'),
    onError: fail,
  });

  const current = weight ?? 0;

  return (
    <Menu position="bottom-start" width={230} withinPortal>
      <Menu.Target>
        <Badge
          color={stopped ? 'red' : weight === undefined ? 'gray' : weight > 0 ? 'brand' : 'yellow'}
          rightSection={<ChevronDown size={11} />}
          style={{ cursor: 'pointer' }}
        >
          {term}
          {weight !== undefined && ` ${weight > 0 ? '+' : ''}${weight}`}
        </Badge>
      </Menu.Target>

      <Menu.Dropdown>
        <Menu.Label>
          {stopped
            ? 'у стоп-словах, вакансії з ним відсіюються'
            : weight === undefined
              ? 'ваги немає, термін ні на що не впливає'
              : `поточна вага ${weight}`}
        </Menu.Label>

        <Menu.Item
          leftSection={<Plus size={15} />}
          onClick={() => setWeight.mutate(current + 1)}
          disabled={setWeight.isPending}
        >
          Підняти вагу
          <Text size="xs" c="dimmed">
            стане {current + 1}
          </Text>
        </Menu.Item>

        <Menu.Item
          leftSection={<Minus size={15} />}
          onClick={() => setWeight.mutate(current - 1)}
          disabled={setWeight.isPending}
        >
          Понизити вагу
          <Text size="xs" c="dimmed">
            стане {current - 1}
          </Text>
        </Menu.Item>

        {weight !== undefined && (
          <Menu.Item
            leftSection={<Trash2 size={15} />}
            onClick={() => setWeight.mutate(null)}
            disabled={setWeight.isPending}
          >
            Прибрати вагу
          </Menu.Item>
        )}

        <Menu.Divider />

        {stopped ? (
          <Menu.Item leftSection={<Ban size={15} />} onClick={() => setStop.mutate(true)}>
            Прибрати зі стоп-слів
          </Menu.Item>
        ) : (
          <Menu.Item color="red" leftSection={<Ban size={15} />} onClick={() => setStop.mutate(false)}>
            У стоп-слова
            <Text size="xs" c="dimmed">
              вакансії з цим словом більше не показуються
            </Text>
          </Menu.Item>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
