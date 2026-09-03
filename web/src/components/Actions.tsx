import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Button, Panel } from './ui';

interface Action {
  id: string;
  label: string;
  running: string;
  run: () => Promise<unknown>;
  describe: (result: never) => string;
}

/**
 * Панель ручних дій. Все, що раніше робилось у терміналі, тепер доступне з інтерфейсу:
 * запуск джерел, збір каталогу, discovery і перерахунок після правки конфіга.
 */
export function ActionsBar() {
  const client = useQueryClient();
  const [log, setLog] = useState<{ text: string; tone: 'ok' | 'bad' } | null>(null);

  const actions: Action[] = [
    {
      id: 'sources',
      label: 'Оновити вакансії',
      running: 'тягну джерела',
      run: async () => {
        const sources = await api.sources();
        const results = [];
        for (const source of sources.filter((item) => item.kind === 'board')) {
          results.push({ id: source.id, ...(await api.runSource(source.id)) });
        }
        return results;
      },
      describe: (result: { id: string; itemsFound: number }[]) =>
        `оновлено ${result.length} джерел, знайдено ${result.reduce((sum, item) => sum + (item.itemsFound ?? 0), 0)}`,
    },
    {
      id: 'dou',
      label: 'Зібрати DOU',
      running: 'збираю каталог',
      run: () => api.runDou(),
      describe: (result: { itemsFound: number; itemsNew: number }) =>
        `знайдено ${result.itemsFound}, нових ${result.itemsNew}`,
    },
    {
      id: 'discover',
      label: 'Знайти career-сторінки',
      running: 'обходжу сайти',
      run: () => api.discover(40),
      describe: (result: { checked: number; withAts: number; withHtml: number }) =>
        `обійдено ${result.checked}, ATS ${result.withAts}, html ${result.withHtml}`,
    },
    {
      id: 'recalc',
      label: 'Перерахувати рахунки',
      running: 'рахую',
      run: () => api.recalc(),
      describe: (result: Record<string, number>) =>
        Object.entries(result)
          .map(([key, value]) => `${key} ${value}`)
          .join(', '),
    },
  ];

  const mutation = useMutation({
    mutationFn: async (action: Action) => ({ action, result: await action.run() }),
    onSuccess: ({ action, result }) => {
      setLog({ text: action.describe(result as never), tone: 'ok' });
      void client.invalidateQueries();
    },
    onError: (error) => setLog({ text: String(error), tone: 'bad' }),
  });

  return (
    <Panel className="mb-2 flex flex-wrap items-center gap-2 p-2">
      {actions.map((action) => (
        <Button
          key={action.id}
          onClick={() => mutation.mutate(action)}
          disabled={mutation.isPending}
        >
          {mutation.isPending && mutation.variables?.id === action.id ? action.running : action.label}
        </Button>
      ))}

      {log && (
        <span className={log.tone === 'bad' ? 'text-[var(--color-danger)]' : 'text-[var(--color-muted)]'}>
          {log.text}
        </span>
      )}
      {mutation.isPending && <span className="text-[var(--color-muted)]">може зайняти хвилину</span>}
    </Panel>
  );
}
