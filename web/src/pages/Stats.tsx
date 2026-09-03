import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { ErrorBox, Panel, Tag } from '../components/ui';

function Bars({ rows, unit = '' }: { rows: { label: string; value: number }[]; unit?: string }) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return (
    <div className="space-y-0.5">
      {rows.map((row) => (
        <div key={row.label} className="flex items-center gap-2">
          <span className="w-32 shrink-0 truncate text-[var(--color-muted)]">{row.label}</span>
          <span
            className="h-3 rounded-sm bg-[#1e4433]"
            style={{ width: `${Math.max(2, (row.value / max) * 100)}%` }}
          />
          <span className="w-16 shrink-0 text-right">
            {row.value}
            {unit}
          </span>
        </div>
      ))}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Panel className="p-3">
      <div className="mb-2 text-[11px] uppercase tracking-wide text-[var(--color-muted)]">{title}</div>
      {children}
    </Panel>
  );
}

const FUNNEL_LABELS: Record<string, string> = {
  companies: 'компаній',
  vacanciesOpen: 'відкритих вакансій',
  shown: 'показано у черзі',
  decided: 'розібрано',
  contacted: 'написано',
  replied: 'відповіли',
  positive: 'позитивних',
  waitingReply: 'чекають відповіді',
};

export function StatsPage() {
  const { data, error, isLoading } = useQuery({ queryKey: ['fullStats'], queryFn: () => api.fullStats() });

  if (error) return <ErrorBox error={error} />;
  if (isLoading || !data) return <div className="text-[var(--color-muted)]">завантаження</div>;

  return (
    <div className="grid gap-2 md:grid-cols-2">
      <Card title="топ технологій у вакансіях за 90 днів">
        {data.topTech.length === 0 ? (
          <span className="text-[var(--color-muted)]">даних ще немає, потрібна класифікація</span>
        ) : (
          <Bars rows={data.topTech.slice(0, 15).map((row) => ({ label: row.tech, value: row.count }))} />
        )}
      </Card>

      <Card title="воронка">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          {Object.entries(data.funnel).map(([key, value]) => (
            <div key={key} className="flex justify-between border-b border-[var(--color-line)] pb-0.5">
              <span className="text-[var(--color-muted)]">{FUNNEL_LABELS[key] ?? key}</span>
              <span>{value}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card title="медіанна вилка за грейдом">
        {data.salariesBySeniority.length === 0 ? (
          <span className="text-[var(--color-muted)]">вилок у вакансіях ще немає</span>
        ) : (
          <table className="w-full">
            <tbody>
              {data.salariesBySeniority.map((row) => (
                <tr key={row.group} className="border-b border-[var(--color-line)]">
                  <td className="py-0.5">{row.group}</td>
                  <td className="py-0.5 text-right">{row.median ?? '-'}</td>
                  <td className="w-16 py-0.5 text-right text-[var(--color-muted)]">{row.count} шт</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="час життя вакансій">
        <div className="mb-2 flex gap-4">
          <span>
            медіана: <b>{data.lifetimes.medianDays?.toFixed(1) ?? 'даних немає'}</b> дн
          </span>
          <span className="text-[var(--color-muted)]">закритих {data.lifetimes.closedCount}</span>
          <span className={data.lifetimes.ghosts.length > 0 ? 'text-[var(--color-warn)]' : ''}>
            підозр на ghost jobs: {data.lifetimes.ghosts.length}
          </span>
        </div>
        <div className="max-h-48 space-y-0.5 overflow-auto">
          {data.lifetimes.ghosts.map((ghost) => (
            <div key={ghost.id} className="flex items-center gap-2">
              <Tag tone="warn">{ghost.days} дн</Tag>
              <a href={ghost.url} target="_blank" rel="noreferrer" className="truncate hover:underline">
                {ghost.company}: {ghost.title}
              </a>
            </div>
          ))}
        </div>
      </Card>

      <Card title="нові вакансії по днях">
        {data.perDay.length === 0 ? (
          <span className="text-[var(--color-muted)]">поки що порожньо</span>
        ) : (
          <Bars rows={data.perDay.slice(0, 20).map((row) => ({ label: row.day, value: row.count }))} />
        )}
      </Card>

      <Card title="медіанна вилка за країною">
        {data.salariesByCountry.length === 0 ? (
          <span className="text-[var(--color-muted)]">вилок у вакансіях ще немає</span>
        ) : (
          <Bars
            rows={data.salariesByCountry.map((row) => ({ label: row.group, value: row.median ?? 0 }))}
          />
        )}
      </Card>
    </div>
  );
}
