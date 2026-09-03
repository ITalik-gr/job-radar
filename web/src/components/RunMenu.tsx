import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Menu, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Building2, Calculator, ChevronDown, Compass, Play, RefreshCw } from 'lucide-react';
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
 * Усі довгі операції під однією кнопкою в шапці. Раніше це була панель на чотири
 * кнопки, яка займала рядок на кожній сторінці і виглядала однаково важливою,
 * хоча запускається раз на день.
 */
const TASKS: Task[] = [
  {
    id: 'sources',
    label: 'Оновити вакансії',
    hint: 'усі борди і ATS по черзі',
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
      `${result.length} джерел, знайдено ${result.reduce((sum, item) => sum + (item.itemsFound ?? 0), 0)}`,
  },
  {
    id: 'dou',
    label: 'Зібрати DOU',
    hint: 'каталог компаній',
    icon: Building2,
    run: () => api.runDou(),
    describe: (result: { itemsFound: number; itemsNew: number }) =>
      `знайдено ${result.itemsFound}, нових ${result.itemsNew}`,
  },
  {
    id: 'discover',
    label: 'Знайти career-сторінки',
    hint: 'обхід сайтів компаній',
    icon: Compass,
    run: () => api.discover(40),
    describe: (result: { checked: number; withAts: number; withHtml: number }) =>
      `обійдено ${result.checked}, ATS ${result.withAts}, html ${result.withHtml}`,
  },
  {
    id: 'recalc',
    label: 'Перерахувати рахунки',
    hint: 'після правки ваг у конфізі',
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
          {running ? running.label : 'Запустити'}
        </Button>
      </Menu.Target>

      <Menu.Dropdown>
        <Menu.Label>ручний запуск</Menu.Label>
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
