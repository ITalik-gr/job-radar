import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, formatDate } from '../lib/api';
import { Button, ErrorBox, Panel, Tag } from '../components/ui';

const REPLY_LABELS: Record<string, string> = {
  positive: 'позитивна',
  rejection: 'відмова',
  auto: 'автовідповідь',
};

export function OutreachPage() {
  const client = useQueryClient();
  const { data, error, isLoading } = useQuery({ queryKey: ['outreach'], queryFn: () => api.outreach() });

  const reply = useMutation({
    mutationFn: ({ id, type }: { id: number; type: string }) => api.reply(id, type),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['outreach'] });
      void client.invalidateQueries({ queryKey: ['stats'] });
      void client.invalidateQueries({ queryKey: ['companies'] });
    },
  });

  if (error) return <ErrorBox error={error} />;
  if (isLoading || !data) return <div className="text-[var(--color-muted)]">завантаження</div>;
  if (data.length === 0) return <Panel className="p-3 text-[var(--color-muted)]">ще нікому не писали</Panel>;

  return (
    <Panel>
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-left text-[11px] uppercase text-[var(--color-muted)]">
            <th className="px-2 py-1">коли</th>
            <th className="px-2 py-1">компанія</th>
            <th className="px-2 py-1">вакансія</th>
            <th className="px-2 py-1">канал</th>
            <th className="px-2 py-1">шаблон</th>
            <th className="px-2 py-1">відповідь</th>
            <th className="px-2 py-1">дія</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => {
            const overdue = row.waitingDays !== null && row.waitingDays >= 7;
            return (
              <tr
                key={row.id}
                className={`border-t border-[var(--color-line)] ${overdue ? 'bg-[#2a2213]' : ''}`}
              >
                <td className="px-2 py-1">{formatDate(row.sentAt)}</td>
                <td className="px-2 py-1">{row.company}</td>
                <td className="max-w-64 truncate px-2 py-1">
                  {row.vacancyUrl ? (
                    <a href={row.vacancyUrl} target="_blank" rel="noreferrer" className="hover:underline">
                      {row.vacancyTitle ?? row.vacancyUrl}
                    </a>
                  ) : (
                    '-'
                  )}
                </td>
                <td className="px-2 py-1">{row.channel}</td>
                <td className="px-2 py-1">{row.templateUsed ?? '-'}</td>
                <td className="px-2 py-1">
                  {row.replyType ? (
                    <Tag tone={row.replyType === 'positive' ? 'good' : row.replyType === 'rejection' ? 'bad' : 'neutral'}>
                      {REPLY_LABELS[row.replyType] ?? row.replyType}
                    </Tag>
                  ) : (
                    <Tag tone={overdue ? 'warn' : 'neutral'}>чекаємо {row.waitingDays} дн</Tag>
                  )}
                </td>
                <td className="px-2 py-1">
                  {!row.replyType && (
                    <div className="flex gap-1">
                      <Button tone="good" onClick={() => reply.mutate({ id: row.id, type: 'positive' })}>
                        Позитивна
                      </Button>
                      <Button tone="bad" onClick={() => reply.mutate({ id: row.id, type: 'rejection' })}>
                        Відмова
                      </Button>
                      <Button onClick={() => reply.mutate({ id: row.id, type: 'auto' })}>Авто</Button>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}
