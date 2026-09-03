import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, formatDate, type StudioCard } from '../lib/api';
import { Button, ErrorBox, Panel, Score, Tag } from '../components/ui';

const TEMPLATES = ['studio_pitch', 'agency_cold', 'project_offer', 'referral'];

function Card({ card, onAct }: { card: StudioCard; onAct: (body: Record<string, unknown>) => void }) {
  const [open, setOpen] = useState(false);
  const [template, setTemplate] = useState(TEMPLATES[0]!);

  return (
    <Panel className="p-3">
      <div className="flex items-start gap-3">
        <div className="w-10 shrink-0 pt-0.5">
          <Score value={card.score} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <a
              href={`https://${card.domain}`}
              target="_blank"
              rel="noreferrer"
              className="text-[15px] font-medium hover:underline"
            >
              {card.name}
            </a>
            <span className="text-[var(--color-muted)]">{card.domain}</span>
            {card.sizeHint && <Tag>{card.sizeHint}</Tag>}
            {card.country && <Tag>{card.country}</Tag>}
            {card.city && <span className="text-[var(--color-muted)]">{card.city}</span>}
            {card.lastContactedAt && <Tag tone="warn">писали {formatDate(card.lastContactedAt)}</Tag>}
          </div>

          {card.description && (
            <p className="mt-1 line-clamp-2 text-[var(--color-muted)]">{card.description}</p>
          )}

          <div className="mt-1 flex flex-wrap items-center gap-1">
            {card.techHints.map((tech) => (
              <Tag key={tech} tone={['wordpress', 'tilda'].includes(tech) ? 'bad' : 'good'}>
                {tech}
              </Tag>
            ))}
            {card.tags.slice(0, 6).map((tag) => (
              <Tag key={tag}>{tag}</Tag>
            ))}
            {card.openVacancies > 0 && <Tag tone="good">вакансій {card.openVacancies}</Tag>}
            {card.careersUrl && (
              <a href={card.careersUrl} target="_blank" rel="noreferrer" className="hover:underline">
                сторінка вакансій
              </a>
            )}
            {card.sourceUrl && (
              <a
                href={card.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="text-[var(--color-accent)] hover:underline"
              >
                профіль у каталозі
              </a>
            )}
          </div>

          {card.contacts.length > 0 && (
            <div className="mt-1 text-[var(--color-muted)]">
              {card.contacts.map((contact, index) => (
                <span key={index} className="mr-3">
                  {contact.name} {contact.role && `(${contact.role})`} {contact.email}
                </span>
              ))}
            </div>
          )}

          {open && (
            <div className="mt-2 space-y-0.5 border-t border-[var(--color-line)] pt-2">
              {card.why.map((item) => (
                <div key={item.reason} className="flex gap-2">
                  <span className={`w-10 text-right ${item.weight > 0 ? 'text-[var(--color-accent)]' : 'text-[var(--color-danger)]'}`}>
                    {item.weight > 0 ? '+' : ''}
                    {item.weight}
                  </span>
                  <span className="text-[var(--color-muted)]">{item.reason}</span>
                </div>
              ))}
              <div className="pt-1 text-[var(--color-muted)]">джерела: {card.sources.join(', ')}</div>
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
            <Button tone="good" onClick={() => onAct({ action: 'contacted', templateUsed: template })}>
              Написав
            </Button>
          </div>
          <div className="flex gap-1">
            <Button tone="bad" onClick={() => onAct({ action: 'blacklist' })}>
              Блок
            </Button>
            <Button onClick={() => onAct({ action: 'snooze', days: 60 })}>Відкласти 60 днів</Button>
          </div>
          <Button onClick={() => setOpen((value) => !value)}>{open ? 'Згорнути' : 'Чому цей рахунок'}</Button>
        </div>
      </div>
    </Panel>
  );
}

export function StudiosPage() {
  const client = useQueryClient();
  const [filters, setFilters] = useState({ q: '', country: '', min: '', all: '' });

  const { data, error, isLoading } = useQuery({
    queryKey: ['studios', filters],
    queryFn: () => api.studios(filters),
  });

  const act = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) => api.companyAction(id, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['studios'] });
      void client.invalidateQueries({ queryKey: ['stats'] });
    },
  });

  if (error) return <ErrorBox error={error} />;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={filters.q}
          onChange={(event) => setFilters({ ...filters, q: event.target.value })}
          placeholder="назва, домен або тег"
          className="w-56 rounded border border-[var(--color-line)] bg-[var(--color-panel-2)] px-2 py-1"
        />
        <input
          value={filters.country}
          onChange={(event) => setFilters({ ...filters, country: event.target.value })}
          placeholder="країна, напр. UA"
          className="w-36 rounded border border-[var(--color-line)] bg-[var(--color-panel-2)] px-2 py-1"
        />
        <input
          value={filters.min}
          onChange={(event) => setFilters({ ...filters, min: event.target.value })}
          placeholder="мін. рахунок"
          className="w-32 rounded border border-[var(--color-line)] bg-[var(--color-panel-2)] px-2 py-1"
        />
        <label className="flex items-center gap-1 text-[var(--color-muted)]">
          <input
            type="checkbox"
            checked={filters.all === '1'}
            onChange={(event) => setFilters({ ...filters, all: event.target.checked ? '1' : '' })}
          />
          показати тих, кому вже писали
        </label>
        {data && <span className="text-[var(--color-muted)]">поріг {data.threshold}, знайдено {data.cards.length}</span>}
      </div>

      {isLoading && <div className="text-[var(--color-muted)]">завантаження</div>}
      {data?.cards.length === 0 && (
        <Panel className="p-3 text-[var(--color-muted)]">
          порожньо. Імпортуй ще сторінок каталогу (`pnpm cli import:clutch`) або знизь мінімальний рахунок
        </Panel>
      )}

      {data?.cards.map((card) => (
        <Card key={card.companyId} card={card} onAct={(body) => act.mutate({ id: card.companyId, body })} />
      ))}
    </div>
  );
}
