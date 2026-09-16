import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { getDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { companies, contacts, type Company } from '../src/db/schema.js';
import { upsertCompany } from '../src/pipeline/companies.js';
import { seedOutreachTemplates } from '../src/pipeline/outreach.js';
import { buildSystem, collectCompany, companyVerdict } from '../src/pipeline/verdict.js';

/**
 * Вердикт по компанії. Модель тут підмінена стабом навмисно: перевіряється не те,
 * що вона відповість, а те, що з її відповіддю робить код. Саме там живуть помилки,
 * через які кнопка виглядає робочою: неіснуючий ключ шаблона, прийнятий мовчки, і
 * порожня відповідь, яка не лишає власнику навіть запасного варіанта.
 */

let studio: Company;

function reply(body: Record<string, unknown>) {
  return async () => ({ text: JSON.stringify(body), inputTokens: 100, outputTokens: 50 });
}

const valid = {
  template_slug: 'send_studio_named_en',
  alternative_slug: null,
  language: 'en',
  confidence: 80,
  angle: 'They build headless commerce on Next.js',
  why: 'Стек збігається, є іменний контакт',
  risks: [],
  contact: 'Anna Koval',
  skip: false,
  skip_reason: null,
};

beforeAll(async () => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
  runMigrations().sqlite.close();

  const db = getDb();
  await seedOutreachTemplates();

  studio = (await upsertCompany({ name: 'Acme Studio', domain: 'acme-verdict.com', source: 'test' })).company;
  await db
    .update(companies)
    .set({ kind: 'studio', country: 'PL', techHints: ['next.js', 'react'] })
    .where(eq(companies.id, studio.id));
  await db
    .insert(contacts)
    .values({ companyId: studio.id, name: 'Anna Koval', role: 'CTO', email: 'anna@acme-verdict.com' });
});

describe('збір даних про компанію', () => {
  it('віддає модели тільки те, що є в базі', async () => {
    const block = await collectCompany(studio.id);

    expect(block.domain).toBe('acme-verdict.com');
    expect(block.tech_hints).toEqual(expect.arrayContaining(['next.js', 'react']));
    expect(block.contacts[0]?.name).toBe('Anna Koval');
    expect(block.score_reasons.length).toBeGreaterThan(0);
  });
});

describe('системний блок', () => {
  /*
   * Кеш промпта це збіг початку запиту байт у байт. Тому шаблони мусять лягати в
   * системний блок у стабільному порядку, інакше кожен наступний виклик коштує
   * повну ціну замість десятої частини, і помітити це можна тільки по рахунку.
   */
  it('однаковий при однакових шаблонах', () => {
    const list = [
      { slug: 'b', name: 'Б', kind: 'studio', for_kind: null, language: 'en', target_type: 'studio_named', note: null, body: 'Hi' },
      { slug: 'a', name: 'А', kind: 'studio', for_kind: null, language: 'en', target_type: 'studio_generic', note: null, body: 'Hello' },
    ];

    expect(buildSystem(list, ['факт'])).toBe(buildSystem([...list], ['факт']));
    expect(buildSystem(list, [])).toContain('studio_named');
  });
});

describe('вердикт по компанії', () => {
  it('приймає відповідь моделі і лишає поруч детермінований вибір', async () => {
    const report = await companyVerdict(studio.id, { caller: reply(valid), skipCache: true });

    expect(report.source).toBe('llm');
    expect(report.verdict?.template_slug).toBe('send_studio_named_en');
    expect(report.error).toBeNull();
    // Компанія з Польщі означає англійську, і це рахує код, а не модель.
    expect(report.language).toBe('en');
    expect(report.fallbackTarget).toBe('studio_named');
    expect(report.fallbackSlug).toBeTruthy();
  });

  /*
   * Модель регулярно вигадує схожий, але неіснуючий ключ. Мовчки прийнятий, він
   * вів би в шаблон, якого немає, і кнопка виглядала б робочою, не працюючи.
   */
  it('відкидає неіснуючий ключ шаблона', async () => {
    const report = await companyVerdict(studio.id, {
      caller: reply({ ...valid, template_slug: 'send_studio_named_pl' }),
      skipCache: true,
    });

    expect(report.verdict).toBeNull();
    expect(report.source).toBe('invalid');
    expect(report.error).toContain('send_studio_named_pl');
    // Запасний варіант лишається: без відповіді на "чим писати" власника не лишають.
    expect(report.fallbackSlug).toBeTruthy();
  });

  it('невалідний JSON не валить кнопку', async () => {
    const report = await companyVerdict(studio.id, {
      caller: async () => ({ text: 'вибач, не можу', inputTokens: 10, outputTokens: 5 }),
      skipCache: true,
    });

    expect(report.verdict).toBeNull();
    expect(report.error).toBeTruthy();
  });

  /*
   * Другий клік по тій самій картці не має коштувати нічого. Ключ кешу включає і
   * шаблони, і дані компанії, тому правка тексту або знайдена пошта самі дають
   * новий вердикт, без окремої кнопки "перерахувати".
   */
  it('повторний виклик іде з кешу і моделі не турбує', async () => {
    const first = await companyVerdict(studio.id, { caller: reply(valid), skipCache: true });
    expect(first.source).toBe('llm');

    let called = 0;
    const second = await companyVerdict(studio.id, {
      caller: async () => {
        called += 1;
        return reply(valid)();
      },
    });

    expect(second.source).toBe('cache');
    expect(second.verdict?.template_slug).toBe('send_studio_named_en');
    expect(called).toBe(0);
  });
});
