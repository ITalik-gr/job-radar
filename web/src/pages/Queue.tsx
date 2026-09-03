import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, formatSalary, type QueueCard } from '../lib/api';
import { Button, ErrorBox, Panel, Score, Tag } from '../components/ui';

const TEMPLATES = ['fullstack_ai', 'frontend_react', 'agency_cold', 'referral'];

function Card({ card, onAct }: { card: QueueCard; onAct: (body: Record<string, unknown>) => void }) {
  const [open, setOpen] = useState(false);
  const [template, setTemplate] = useState(TEMPLATES[0]!);
  const salary = formatSalary(card);

  return (
    <Panel className="p-3">
      <div className="flex items-start gap-3">
        <div className="w-10 shrink-0 pt-0.5">
          <Score value={card.score} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-medium">{card.company}</span>
            <a
              href={`https://${card.domain}`}
              target="_blank"
              rel="noreferrer"
              className="text-[var(--color-muted)] hover:underline"
            >
              {card.domain}
            </a>
            {card.needsReview && <Tag tone="warn">потребує перегляду</Tag>}
            {card.contactedNote && <Tag tone="warn">{card.contactedNote}</Tag>}
          </div>

          <a href={card.url} target="_blank" rel="noreferrer" className="block text-[15px] hover:underline">
            {card.title ?? 'без назви'}
          </a>

          <div className="mt-1 flex flex-wrap items-center gap-1">
            {card.stack.slice(0, 8).map((tech) => (
              <Tag key={tech}>{tech}</Tag>
            ))}
            {card.seniority && <Tag>{card.seniority}</Tag>}
            {card.remote && <Tag tone="good">remote</Tag>}
            {card.location && <span className="text-[var(--color-muted)]">{card.location}</span>}
            {salary && <Tag tone="good">{salary}</Tag>}
          </div>

          {open && (
            <div className="mt-2 space-y-2 border-t border-[var(--color-line)] pt-2">
              {card.why && <p className="text-[var(--color-muted)]">{card.why}</p>}
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-[var(--color-panel-2)] p-2 text-[11px] text-[var(--color-muted)]">
                {(card.rawText ?? '').slice(0, 4000)}
              </pre>
            </div>
          )}
        </div>

        <div className="flex w-64 shrink-0 flex-col gap-1">
          <div className="flex gap-1">
            <Button tone="good" onClick={() => onAct({ action: 'interesting' })}>
              Цікаво
            </Button>
            <Button onClick={() => onAct({ action: 'not_interesting' })}>Не цікаво</Button>
          </div>
          <div className="flex gap-1">
            <select
              value={template}
              onChange={(event) => setTemplate(event.target.value)}
              className="min-w-0 flex-1 rounded border border-[var(--color-line)] bg-[var(--color-panel-2)] px-1 py-1 text-[12px]"
            >
              {TEMPLATES.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <Button
              tone="good"
              onClick={() => onAct({ action: 'contacted', channel: 'email', templateUsed: template })}
            >
              Написав
            </Button>
          </div>
          <div className="flex gap-1">
            <Button tone="bad" onClick={() => onAct({ action: 'blacklist' })}>
              Блок компанії
            </Button>
            <Button onClick={() => onAct({ action: 'snooze', days: 30 })}>Відкласти 30 днів</Button>
          </div>
          <Button onClick={() => setOpen((value) => !value)}>{open ? 'Згорнути' : 'Розкрити'}</Button>
        </div>
      </div>
    </Panel>
  );
}

export function QueuePage() {
  const client = useQueryClient();
  const { data, error, isLoading } = useQuery({ queryKey: ['queue'], queryFn: () => api.queue() });

  const act = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) => api.act(id, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['queue'] });
      void client.invalidateQueries({ queryKey: ['stats'] });
    },
  });

  if (error) return <ErrorBox error={error} />;
  if (isLoading || !data) return <div className="text-[var(--color-muted)]">завантаження</div>;

  const pending = data.cards.filter((card) => !card.decision);

  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-3 text-[var(--color-muted)]">
        <span>
          зріз за {data.day}: {pending.length} з {data.total} чекають рішення
        </span>
        {act.error && <span className="text-[var(--color-danger)]">{String(act.error)}</span>}
      </div>

      {pending.length === 0 && (
        <Panel className="p-3 text-[var(--color-muted)]">
          на сьогодні все розібрано. новий зріз буде завтра, або запусти джерела на вкладці Джерела
        </Panel>
      )}

      {pending.map((card) => (
        <Card
          key={card.queueItemId}
          card={card}
          onAct={(body) => act.mutate({ id: card.vacancyId, body })}
        />
      ))}
    </div>
  );
}
