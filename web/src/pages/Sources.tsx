import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type SourceRow } from '../lib/api';
import { Button, ErrorBox, Panel, Tag } from '../components/ui';

function when(ms: number | undefined): string {
  if (!ms) return 'ніколи';
  const hours = Math.floor((Date.now() - ms) / 3_600_000);
  if (hours < 1) return 'щойно';
  if (hours < 24) return `${hours} год тому`;
  return `${Math.floor(hours / 24)} дн тому`;
}

export function SourcesPage() {
  const client = useQueryClient();
  const { data, error, isLoading } = useQuery({ queryKey: ['sources'], queryFn: () => api.sources() });

  const run = useMutation({
    mutationFn: (id: string) => api.runSource(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['sources'] }),
  });

  if (error) return <ErrorBox error={error} />;
  if (isLoading || !data) return <div className="text-[var(--color-muted)]">завантаження</div>;

  return (
    <div className="space-y-2">
      {run.error && <span className="text-[var(--color-danger)]">{String(run.error)}</span>}

      <Panel>
        <table className="w-full border-collapse">
          <thead>
            <tr className="text-left text-[11px] uppercase text-[var(--color-muted)]">
              <th className="px-2 py-1">джерело</th>
              <th className="px-2 py-1">тип</th>
              <th className="px-2 py-1">останній запуск</th>
              <th className="px-2 py-1">статус</th>
              <th className="px-2 py-1">знайдено</th>
              <th className="px-2 py-1">нових</th>
              <th className="px-2 py-1">помилки</th>
              <th className="px-2 py-1"></th>
            </tr>
          </thead>
          <tbody>
            {data.map((row: SourceRow) => {
              const status = row.lastRun?.status ?? 'ніколи не запускався';
              const bad = status === 'warn' || status === 'error';
              return (
                <tr key={row.id} className={`border-t border-[var(--color-line)] ${bad ? 'bg-[#2a1618]' : ''}`}>
                  <td className="px-2 py-1">{row.id}</td>
                  <td className="px-2 py-1 text-[var(--color-muted)]">{row.kind}</td>
                  <td className="px-2 py-1">{when(row.lastRun?.startedAt)}</td>
                  <td className="px-2 py-1">
                    <Tag tone={bad ? 'bad' : row.lastRun ? 'good' : 'neutral'}>{status}</Tag>
                  </td>
                  <td className="px-2 py-1">{row.lastRun?.itemsFound ?? ''}</td>
                  <td className="px-2 py-1">{row.lastRun?.itemsNew ?? ''}</td>
                  <td className="max-w-80 truncate px-2 py-1 text-[var(--color-danger)]">
                    {row.lastRun?.errors.join('; ')}
                  </td>
                  <td className="px-2 py-1">
                    <Button
                      onClick={() => run.mutate(row.id)}
                      disabled={run.isPending && run.variables === row.id}
                    >
                      {run.isPending && run.variables === row.id ? 'працює' : 'Запустити'}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
