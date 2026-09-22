import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Menu, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  Building2,
  Calculator,
  ChevronDown,
  Compass,
  Inbox,
  Play,
  RefreshCw,
  Sparkles,
  Users,
} from 'lucide-react';
import { api } from '../lib/api';

interface Task {
  id: string;
  label: string;
  hint: string;
  icon: typeof Play;
  run: () => Promise<unknown>;
  describe: (result: never) => string;
}

/**
 * Every long operation under one button in the header. It used to be a four-button bar
 * that took a row on every page and looked equally important, although it runs once
 * a day.
 */
const TASKS: Task[] = [
  {
    id: 'sources',
    label: 'Refresh vacancies',
    hint: 'every board and ATS in turn',
    icon: RefreshCw,
    run: async () => {
      const sources = await api.sources();
      const results = [];
      for (const source of sources.filter((item) => item.kind === 'board')) {
        results.push({ id: source.id, ...(await api.runSource(source.id)) });
      }
      return results;
    },
    describe: (result: { id: string; itemsFound: number }[]) =>
      `${result.length} sources, found ${result.reduce((sum, item) => sum + (item.itemsFound ?? 0), 0)}`,
  },
  {
    id: 'dou',
    label: 'Collect DOU',
    hint: 'company catalog',
    icon: Building2,
    run: () => api.runDou(),
    describe: (result: { itemsFound: number; itemsNew: number }) =>
      `found ${result.itemsFound}, new ${result.itemsNew}`,
  },
  {
    id: 'top-up',
    label: 'Top up the queue',
    hint: 'when the daily slice was fixed before the sources ran',
    icon: Inbox,
    run: () => api.topUpQueue(),
    describe: (result: { added: number; total: number }) =>
      result.added > 0 ? `added ${result.added}, ${result.total} in the slice` : 'no new candidates',
  },
  {
    id: 'enrich',
    label: 'Collect contacts',
    hint: 'names and emails from team pages',
    icon: Users,
    run: () => api.enrich(25),
    describe: (result: { checked: number; withPeople: number; contactsAdded: number }) =>
      `checked ${result.checked}, with names ${result.withPeople}, contacts ${result.contactsAdded}`,
  },
  {
    id: 'embed',
    label: 'Compute similarity',
    hint: 'company vectors through Workers AI',
    icon: Sparkles,
    run: () => api.embed(200),
    describe: (result: { itemsFound: number; itemsNew: number; errors: string[] }) =>
      result.errors.length > 0
        ? `computed ${result.itemsNew}, errors ${result.errors.length}: ${result.errors[0]}`
        : `computed ${result.itemsNew} of ${result.itemsFound}`,
  },
  {
    id: 'discover',
    label: 'Find career pages',
    hint: 'crawl company sites',
    icon: Compass,
    run: () => api.discover(40),
    describe: (result: { checked: number; withAts: number; withHtml: number }) =>
      `checked ${result.checked}, ATS ${result.withAts}, html ${result.withHtml}`,
  },
  {
    id: 'recalc',
    label: 'Rescore',
    hint: 'after changing the weights',
    icon: Calculator,
    run: () => api.recalc(),
    describe: (result: Record<string, number>) =>
      Object.entries(result)
        .map(([key, value]) => `${key} ${value}`)
        .join(', '),
  },
];

export function RunMenu() {
  const client = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (task: Task) => ({ task, result: await task.run() }),
    onSuccess: ({ task, result }) => {
      notifications.show({ color: 'green', title: task.label, message: task.describe(result as never) });
      void client.invalidateQueries();
    },
    onError: (error, task) => {
      notifications.show({
        color: 'red',
        title: task.label,
        message: error instanceof Error ? error.message : String(error),
      });
    },
  });

  const running = mutation.isPending ? mutation.variables : null;

  return (
    <Menu position="bottom-end" width={280}>
      <Menu.Target>
        <Button
          loading={Boolean(running)}
          leftSection={<Play size={14} />}
          rightSection={<ChevronDown size={14} />}
        >
          {running ? running.label : 'Run'}
        </Button>
      </Menu.Target>

      <Menu.Dropdown>
        <Menu.Label>manual run</Menu.Label>
        {TASKS.map((task) => (
          <Menu.Item
            key={task.id}
            leftSection={<task.icon size={15} />}
            onClick={() => mutation.mutate(task)}
            disabled={Boolean(running)}
          >
            {task.label}
            <Text size="xs" c="dimmed">
              {task.hint}
            </Text>
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
