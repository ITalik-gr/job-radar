import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Menu, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Ban, ChevronDown, Minus, Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';

/**
 * A tag from the vacancy stack that can go straight into the rules. Before this, seeing
 * a term and changing its weight were two tasks in two places: the tag on the card, the
 * weight in config/scoring.json, which cannot be edited in production at all.
 *
 * Weights and stop words apply to new and rescored records, so after an edit we remind
 * about rescoring rather than doing it silently: a rescore walks the whole database.
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
      message: `${message}. To apply it to existing vacancies: Run, Rescore`,
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
    onSuccess: (_result, next) => done(next === null ? 'weight removed' : `weight ${next}`),
    onError: fail,
  });

  const setStop = useMutation({
    mutationFn: (remove: boolean) => api.stopWord(term, remove),
    onSuccess: (_result, remove) => done(remove ? 'removed from stop words' : 'added to stop words'),
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
            ? 'a stop word, vacancies with it are filtered out'
            : weight === undefined
              ? 'no weight, the term affects nothing'
              : `current weight ${weight}`}
        </Menu.Label>

        <Menu.Item
          leftSection={<Plus size={15} />}
          onClick={() => setWeight.mutate(current + 1)}
          disabled={setWeight.isPending}
        >
          Raise weight
          <Text size="xs" c="dimmed">
            becomes {current + 1}
          </Text>
        </Menu.Item>

        <Menu.Item
          leftSection={<Minus size={15} />}
          onClick={() => setWeight.mutate(current - 1)}
          disabled={setWeight.isPending}
        >
          Lower weight
          <Text size="xs" c="dimmed">
            becomes {current - 1}
          </Text>
        </Menu.Item>

        {weight !== undefined && (
          <Menu.Item
            leftSection={<Trash2 size={15} />}
            onClick={() => setWeight.mutate(null)}
            disabled={setWeight.isPending}
          >
            Remove weight
          </Menu.Item>
        )}

        <Menu.Divider />

        {stopped ? (
          <Menu.Item leftSection={<Ban size={15} />} onClick={() => setStop.mutate(true)}>
            Remove from stop words
          </Menu.Item>
        ) : (
          <Menu.Item color="red" leftSection={<Ban size={15} />} onClick={() => setStop.mutate(false)}>
            Add to stop words
            <Text size="xs" c="dimmed">
              vacancies with this word will no longer show
            </Text>
          </Menu.Item>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
