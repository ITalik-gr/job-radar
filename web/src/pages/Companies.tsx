import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, formatDate, type CompanyRow } from '../lib/api';
import { Button, ErrorBox, Field, Panel, Score, Tag } from '../components/ui';

const STATUSES = [
  'new',
  'interesting',
  'contacted',
  'replied',
  'rejected_by_me',
  'rejected_by_them',
  'blacklist',
  'snoozed',
];

function Detail({ id, onClose }: { id: number; onClose: () => void }) {
  const client = useQueryClient();
  const { data, error } = useQuery({ queryKey: ['company', id], queryFn: () => api.company(id) });

  const setState = useMutation({
    mutationFn: (status: string) => api.setCompanyState(id, { status }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['company', id] });
      void client.invalidateQueries({ queryKey: ['companies'] });
    },
  });

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Panel className="p-3 text-[var(--color-muted)]">завантаження</Panel>;

  const open = data.vacancies.filter((v) => !v.closedAt);
  const closed = data.vacancies.filter((v) => v.closedAt);

  return (
    <Panel className="p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[15px] font-medium">{data.company.name}</div>
          <a
            href={`https://${data.company.domain}`}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--color-muted)] hover:underline"
          >
            {data.company.domain}
          </a>
        </div>
        <Button onClick={onClose}>Закрити</Button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Field label="статус">
          <select
            value={data.state?.status ?? 'new'}
            onChange={(event) => setState.mutate(event.target.value)}
            className="w-full rounded border border-[var(--color-line)] bg-[var(--color-panel-2)] px-1 py-0.5"
          >
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </Field>
        <Field label="ats">{data.company.careersKind}</Field>
        <Field label="країна">{data.company.country ?? '-'}</Field>
        <Field label="джерела">{data.company.sources.join(', ')}</Field>
        <Field label="стек із сайту">{data.company.techHints.join(', ') || '-'}</Field>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div>
          <div className="mb-1 text-[11px] uppercase text-[var(--color-muted)]">
            вакансії: {open.length} відкритих, {closed.length} закритих
          </div>
          <div className="max-h-72 space-y-1 overflow-auto">
            {data.vacancies.map((vacancy) => (
              <div key={vacancy.id} className="flex items-center gap-2 border-b border-[var(--color-line)] pb-1">
                <Score value={vacancy.score} />
                <a href={vacancy.url} target="_blank" rel="noreferrer" className="flex-1 truncate hover:underline">
                  {vacancy.title ?? vacancy.url}
                </a>
                <span className="text-[var(--color-muted)]">
                  {formatDate(vacancy.firstSeen)}
                  {vacancy.closedAt ? ` - ${formatDate(vacancy.closedAt)}` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <div className="mb-1 text-[11px] uppercase text-[var(--color-muted)]">контакти</div>
            {data.contacts.length === 0 && <div className="text-[var(--color-muted)]">немає</div>}
            {data.contacts.map((contact) => (
              <div key={contact.id}>
                {contact.name} {contact.role && <Tag>{contact.role}</Tag>} {contact.email}
              </div>
            ))}
          </div>

          <div>
            <div className="mb-1 text-[11px] uppercase text-[var(--color-muted)]">листування</div>
            {data.outreach.length === 0 && <div className="text-[var(--color-muted)]">не писали</div>}
            {data.outreach.map((row) => (
              <div key={row.id}>
                {formatDate(row.sentAt)} {row.channel} {row.templateUsed && <Tag>{row.templateUsed}</Tag>}{' '}
                {row.replyType ? <Tag tone="good">{row.replyType}</Tag> : <Tag tone="warn">без відповіді</Tag>}
              </div>
            ))}
          </div>

          <div>
            <div className="mb-1 text-[11px] uppercase text-[var(--color-muted)]">знімки сторінок</div>
            {data.snapshots.length === 0 && <div className="text-[var(--color-muted)]">немає</div>}
            {data.snapshots.map((snapshot) => (
              <div key={snapshot.id} className="text-[var(--color-muted)]">
                {formatDate(snapshot.fetchedAt)} {snapshot.contentHash} блоків {snapshot.blocks}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Panel>
  );
}

export function CompaniesPage() {
  const [filters, setFilters] = useState({ q: '', status: '', ats: '', country: '' });
  const [selected, setSelected] = useState<number | null>(null);

  const { data, error, isLoading } = useQuery({
    queryKey: ['companies', filters],
    queryFn: () => api.companies(filters),
  });

  if (error) return <ErrorBox error={error} />;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <input
          value={filters.q}
          onChange={(event) => setFilters({ ...filters, q: event.target.value })}
          placeholder="пошук за назвою або доменом"
          className="w-64 rounded border border-[var(--color-line)] bg-[var(--color-panel-2)] px-2 py-1"
        />
        <select
          value={filters.status}
          onChange={(event) => setFilters({ ...filters, status: event.target.value })}
          className="rounded border border-[var(--color-line)] bg-[var(--color-panel-2)] px-2 py-1"
        >
          <option value="">будь-який статус</option>
          {STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
        <select
          value={filters.ats}
          onChange={(event) => setFilters({ ...filters, ats: event.target.value })}
          className="rounded border border-[var(--color-line)] bg-[var(--color-panel-2)] px-2 py-1"
        >
          <option value="">будь-який ats</option>
          {['greenhouse', 'lever', 'ashby', 'html', 'unknown'].map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
      </div>

      {selected !== null && <Detail id={selected} onClose={() => setSelected(null)} />}

      <Panel>
        <table className="w-full border-collapse">
          <thead>
            <tr className="text-left text-[11px] uppercase text-[var(--color-muted)]">
              <th className="px-2 py-1">рахунок</th>
              <th className="px-2 py-1">компанія</th>
              <th className="px-2 py-1">домен</th>
              <th className="px-2 py-1">розмір</th>
              <th className="px-2 py-1">країна</th>
              <th className="px-2 py-1">ats</th>
              <th className="px-2 py-1">статус</th>
              <th className="px-2 py-1">відкритих</th>
              <th className="px-2 py-1">перевірено</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td className="px-2 py-1 text-[var(--color-muted)]" colSpan={9}>
                  завантаження
                </td>
              </tr>
            )}
            {data?.map((row: CompanyRow) => (
              <tr
                key={row.id}
                onClick={() => setSelected(row.id)}
                className="cursor-pointer border-t border-[var(--color-line)] hover:bg-[var(--color-panel-2)]"
              >
                <td className="px-2 py-1">
                  <Score value={row.score} />
                </td>
                <td className="px-2 py-1">{row.name}</td>
                <td className="px-2 py-1 text-[var(--color-muted)]">{row.domain}</td>
                <td className="px-2 py-1 text-[var(--color-muted)]">{row.sizeHint ?? ''}</td>
                <td className="px-2 py-1">{row.country ?? ''}</td>
                <td className="px-2 py-1">{row.careersKind}</td>
                <td className="px-2 py-1">
                  <Tag tone={row.status === 'blacklist' ? 'bad' : row.status === 'replied' ? 'good' : 'neutral'}>
                    {row.status ?? 'new'}
                  </Tag>
                </td>
                <td className="px-2 py-1">{row.openVacancies}</td>
                <td className="px-2 py-1 text-[var(--color-muted)]">{formatDate(row.lastChecked)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
