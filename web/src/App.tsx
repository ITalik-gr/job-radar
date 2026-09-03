import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, setToken } from './lib/api';
import { ActionsBar } from './components/Actions';
import { QueuePage } from './pages/Queue';
import { CompaniesPage } from './pages/Companies';
import { OutreachPage } from './pages/Outreach';
import { StatsPage } from './pages/Stats';
import { StudiosPage } from './pages/Studios';
import { SourcesPage } from './pages/Sources';

const TABS = [
  { id: 'queue', label: 'Черга' },
  { id: 'studios', label: 'Студії' },
  { id: 'companies', label: 'Компанії' },
  { id: 'outreach', label: 'Контакти' },
  { id: 'stats', label: 'Статистика' },
  { id: 'sources', label: 'Джерела' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function App() {
  const [tab, setTab] = useState<TabId>('queue');
  const { data: stats, error: statsError } = useQuery({
    queryKey: ['stats'],
    queryFn: () => api.stats(),
    refetchInterval: 30_000,
    retry: false,
  });
  const { data: waiting } = useQuery({
    queryKey: ['followups'],
    queryFn: () => api.outreach(7),
    refetchInterval: 60_000,
  });

  // Задеплоєна версія без токена не покаже нічого, тому питаємо його одразу.
  const needsToken = statsError instanceof Error && /токен/i.test(statsError.message);

  if (needsToken) {
    return (
      <div className="mx-auto max-w-md p-6">
        <div className="mb-2">Потрібен токен доступу</div>
        <input
          autoFocus
          placeholder="RADAR_TOKEN"
          className="w-full rounded border border-[var(--color-line)] bg-[var(--color-panel-2)] px-2 py-1"
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            setToken((event.target as HTMLInputElement).value.trim());
            window.location.reload();
          }}
        />
        <p className="mt-2 text-[var(--color-muted)]">
          Той самий, що заданий секретом RADAR_TOKEN у воркері. Зберігається локально в браузері.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1400px] p-3">
      <header className="mb-3 flex flex-wrap items-center gap-3 border-b border-[var(--color-line)] pb-2">
        <span className="text-[15px] font-medium">Job Radar</span>

        <nav className="flex gap-1">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`rounded px-2 py-1 ${
                tab === item.id
                  ? 'bg-[var(--color-panel-2)] text-[var(--color-ink)]'
                  : 'text-[var(--color-muted)] hover:text-[var(--color-ink)]'
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex gap-3 text-[var(--color-muted)]">
          {stats && (
            <>
              <span>вакансій {stats.vacancies.open}</span>
              <span>вище порогу {stats.vacancies.aboveThreshold}</span>
              <span>написано {stats.funnel.contacted}</span>
              <span>виклики моделі {stats.llmBudgetLeft}</span>
            </>
          )}
          {waiting && waiting.length > 0 && (
            <span className="text-[var(--color-warn)]">фолоу-апів {waiting.length}</span>
          )}
        </div>
      </header>

      <ActionsBar />

      {tab === 'queue' && <QueuePage />}
      {tab === 'studios' && <StudiosPage />}
      {tab === 'companies' && <CompaniesPage />}
      {tab === 'outreach' && <OutreachPage />}
      {tab === 'stats' && <StatsPage />}
      {tab === 'sources' && <SourcesPage />}
    </div>
  );
}
