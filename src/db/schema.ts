import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// Часові мітки зберігаються як unix-мілісекунди (integer), щоб переїзд у Postgres
// був заміною типу колонки, а не переписуванням логіки.
const now = sql`(unixepoch() * 1000)`;

export const companies = sqliteTable(
  'companies',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    domain: text('domain').notNull(),
    country: text('country'),
    city: text('city'),
    sizeHint: text('size_hint'),
    sources: text('sources', { mode: 'json' }).$type<string[]>().notNull().default([]),
    careersUrl: text('careers_url'),
    // html | greenhouse | lever | ashby | workable | recruitee | personio | rss | none | unknown
    careersKind: text('careers_kind').notNull().default('unknown'),
    careersSlug: text('careers_slug'),
    techHints: text('tech_hints', { mode: 'json' }).$type<string[]>().notNull().default([]),
    // Теги з каталогів: тип бізнесу, домен, послуги. Не стек, стек живе в tech_hints.
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
    /**
     * Тип компанії: studio | design | startup | product | outstaff | unknown.
     * Потрібен, щоб розвести сторінки Студії і Стартапи і щоб шаблон листа
     * підбирався сам: дизайн-студії пишеться зовсім не те, що стартапу.
     */
    kind: text('kind').notNull().default('unknown'),
    /**
     * Ознаки живості сайту, зібрані enrichment. Агенція з копірайтом 2019 року
     * і мертвим блогом не наймає і не відповідає на листи, і це видно ще до того,
     * як власник витратить вечір на лист.
     */
    copyrightYear: integer('copyright_year'),
    lastPostAt: integer('last_post_at'),
    /**
     * Вектор опису компанії для пошуку схожих. JSON-масив, а не окрема база
     * векторів: компаній сотні, повний перебір у памʼяті займає мілісекунди,
     * і Vectorize тут був би зайвою залежністю.
     */
    embedding: text('embedding'),
    embeddedAt: integer('embedded_at'),
    description: text('description'),
    /**
     * Репутація з каталогу. Оцінка і кількість відгуків це найшвидший спосіб
     * зрозуміти, жива студія чи порожня картка: агенція з 40 відгуками і 4.9
     * працює з клієнтами постійно, картка без жодного відгуку часто мертва.
     * Обидва поля перезаписуються свіжими значеннями, бо це поточний факт,
     * а не те, що було при першій зустрічі.
     */
    rating: real('rating'),
    reviewsCount: integer('reviews_count'),
    /** "$5,000+", "$50 - $99 / hr", 2015. Рядком, бо каталоги пишуть їх по-різному. */
    minProject: text('min_project'),
    hourlyRate: text('hourly_rate'),
    foundedYear: integer('founded_year'),
    /**
     * Блок "Інше": усе, що каталог показав, але під що немає колонки. Нагороди,
     * мови, галузі, відсоток повторних клієнтів, перевірений профіль.
     *
     * Навіщо мішком, а не колонками: кожен каталог має свій набір полів, і
     * заводити колонку під кожне означало б міграцію на кожен новий каталог.
     * Тут дані просто зберігаються і показуються людині, скоринг їх не читає.
     */
    extra: text('extra', { mode: 'json' })
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    // Сторінка компанії в каталозі, звідки вона прийшла: Clutch, DOU тощо.
    sourceUrl: text('source_url'),
    firstSeen: integer('first_seen').notNull().default(now),
    lastChecked: integer('last_checked'),
    lastChangeAt: integer('last_change_at'),
  },
  (t) => [
    uniqueIndex('companies_domain_uq').on(t.domain),
    index('companies_last_checked_idx').on(t.lastChecked),
  ],
);

// status: new | interesting | contacted | replied | rejected_by_me
//         | rejected_by_them | blacklist | snoozed
export const companyState = sqliteTable(
  'company_state',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('new'),
    snoozedUntil: integer('snoozed_until'),
    reason: text('reason'),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('company_state_company_uq').on(t.companyId),
    index('company_state_status_idx').on(t.status),
  ],
);

export const contacts = sqliteTable(
  'contacts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name'),
    role: text('role'),
    email: text('email'),
    /**
     * Адреса, яка дала hard bounce, лишається в базі, але позначається мертвою:
     * видаляти її не можна, бо тоді enrichment знайде її знову і лист піде
     * вдруге на ту саму скриньку.
     */
    emailValid: integer('email_valid', { mode: 'boolean' }).notNull().default(true),
    telegram: text('telegram'),
    xHandle: text('x_handle'),
    linkedin: text('linkedin'),
    sourceUrl: text('source_url'),
    firstSeen: integer('first_seen').notNull().default(now),
  },
  (t) => [index('contacts_company_idx').on(t.companyId)],
);

export const snapshots = sqliteTable(
  'snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    fetchedAt: integer('fetched_at').notNull().default(now),
    contentHash: text('content_hash').notNull(),
    textNormalized: text('text_normalized').notNull(),
    // хеші окремих блоків, для блочного дифу (Етап 3)
    blockHashes: text('block_hashes', { mode: 'json' }).$type<string[]>().notNull().default([]),
  },
  (t) => [index('snapshots_company_fetched_idx').on(t.companyId, t.fetchedAt)],
);

export const vacancies = sqliteTable(
  'vacancies',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    externalId: text('external_id'),
    url: text('url').notNull(),
    title: text('title'),
    rawText: text('raw_text'),
    stack: text('stack', { mode: 'json' }).$type<string[]>().notNull().default([]),
    seniority: text('seniority'),
    remote: integer('remote', { mode: 'boolean' }),
    location: text('location'),
    salaryMin: integer('salary_min'),
    salaryMax: integer('salary_max'),
    currency: text('currency'),
    englishLevelRequired: text('english_level_required'),
    firstSeen: integer('first_seen').notNull().default(now),
    lastSeen: integer('last_seen').notNull().default(now),
    closedAt: integer('closed_at'),
    llmRelevance: integer('llm_relevance'),
    llmWhy: text('llm_why'),
    // null означає, що класифікація не вдалась і запис чекає ручного перегляду
    isVacancy: integer('is_vacancy', { mode: 'boolean' }),
    needsReview: integer('needs_review', { mode: 'boolean' }).notNull().default(false),
    score: real('score'),
    dedupeKey: text('dedupe_key').notNull(),
  },
  (t) => [
    uniqueIndex('vacancies_dedupe_uq').on(t.dedupeKey),
    index('vacancies_company_idx').on(t.companyId),
    index('vacancies_score_idx').on(t.score),
    index('vacancies_closed_idx').on(t.closedAt),
  ],
);

export const outreach = sqliteTable(
  'outreach',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    companyId: integer('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    vacancyId: integer('vacancy_id').references(() => vacancies.id, { onDelete: 'set null' }),
    /**
     * Контакт, якому пишемо. На відміну від `contact_name` і `contact_email`,
     * це живий звʼязок: він потрібен, щоб позначити адресу невалідною після
     * hard bounce. Знімок імені і пошти лишається поруч і переживає видалення.
     */
    contactId: integer('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
    channel: text('channel').notNull(),
    /**
     * Порожнє означає, що лист ще не пішов. Чернетка живе в цій же таблиці,
     * а не в окремій: інакше при відправці довелось би переносити рядок і
     * гарантувати, що знімок тексту не зміниться дорогою.
     */
    sentAt: integer('sent_at'),
    templateUsed: text('template_used'),
    templateId: integer('template_id').references(() => templates.id, { onDelete: 'set null' }),
    /** uk | en. Знімок на момент чернетки, шаблон потім можуть перекласти. */
    language: text('language'),
    /** Те, що реально пішло, після всіх правок людини. Не перегенеровується. */
    subjectFinal: text('subject_final'),
    bodyFinal: text('body_final'),
    /**
     * Перший абзац від моделі зберігається окремо від тіла листа навмисно:
     * через сотню листів це єдиний спосіб порівняти конверсію з персоналізацією
     * і без неї, не розбираючи текст назад на абзаци.
     */
    aiUsed: integer('ai_used', { mode: 'boolean' }).notNull().default(false),
    aiParagraph: text('ai_paragraph'),
    /**
     * Чому абзац від моделі не використали. Порожнє при `ai_used` означає, що все
     * пройшло. Потрібне для статистики відкатів: якщо їх понад 30 відсотків,
     * поганий промпт, і без розбивки по причинах цього не видно.
     */
    aiFallbackReason: text('ai_fallback_reason'),
    /** draft | approved | sent | failed | bounced | replied */
    status: text('status').notNull().default('sent'),
    gmailMessageId: text('gmail_message_id'),
    /**
     * Заголовок Message-Id самого листа. Не те саме, що `gmail_message_id`:
     * той внутрішній для API, а фолоу-ап у `In-Reply-To` чекає саме RFC-значення
     * у кутових дужках. Без цього поля ланцюжок треду не збирається.
     */
    rfcMessageId: text('rfc_message_id'),
    gmailThreadId: text('gmail_thread_id'),
    queuedAt: integer('queued_at'),
    /**
     * Кому саме писали. Не звʼязок із `contacts`, а знімок імені і пошти на момент
     * листа: контакт може змінитись або зникнути з сайту, а історія має лишитись
     * читабельною через рік.
     */
    contactName: text('contact_name'),
    contactEmail: text('contact_email'),
    replyAt: integer('reply_at'),
    // positive | rejection | autoreply | ooo | unclear
    replyType: text('reply_type'),
    /** hard | soft. Hard означає, що адреса мертва і більше не використовується. */
    bounceType: text('bounce_type'),
    /** Лист, продовженням якого є цей. Фолоу-ап рівно один, тому ланцюжок короткий. */
    followupOf: integer('followup_of'),
    followupDueAt: integer('followup_due_at'),
    /**
     * Чому чернетка не готова: порожній обовʼязковий плейсхолдер, немає адреси,
     * порожній шаблон. Такі лежать окремою вкладкою, а не тихо зникають.
     */
    error: text('error'),
    note: text('note'),
  },
  (t) => [
    index('outreach_company_idx').on(t.companyId),
    index('outreach_sent_idx').on(t.sentAt),
    index('outreach_status_idx').on(t.status),
    index('outreach_followup_idx').on(t.followupDueAt),
  ],
);

/**
 * Whitelist фактів про власника, які модель має право згадати в першому абзаці.
 *
 * Навіщо в базі, а не в промпті: список правиться з інтерфейсу, і кожен факт
 * можна вимкнути, не чіпаючи код. Модель не має права сказати нічого, чого тут
 * немає, і валідатор це перевіряє.
 */
export const facts = sqliteTable(
  'facts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    key: text('key').notNull(),
    textUk: text('text_uk').notNull(),
    textEn: text('text_en').notNull(),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('facts_key_uq').on(t.key)],
);

/**
 * Лічильник відправок за добу. Живе окремо від `outreach`, бо на ньому тримаються
 * і денний ліміт, і пауза між листами, і прогрів: рахувати це кожного разу
 * агрегатом по історії означає залежати від того, що історію ніхто не чистив.
 */
export const sendLog = sqliteTable('send_log', {
  day: text('day').primaryKey(),
  count: integer('count').notNull().default(0),
  lastSentAt: integer('last_sent_at'),
});

export const runs = sqliteTable(
  'runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    startedAt: integer('started_at').notNull().default(now),
    finishedAt: integer('finished_at'),
    source: text('source').notNull(),
    itemsFound: integer('items_found').notNull().default(0),
    itemsNew: integer('items_new').notNull().default(0),
    errors: text('errors', { mode: 'json' }).$type<string[]>().notNull().default([]),
    // running | ok | warn | error
    status: text('status').notNull().default('running'),
  },
  (t) => [index('runs_source_started_idx').on(t.source, t.startedAt)],
);

/**
 * Денний зріз черги. Без нього список щодня перемішується під тим, хто його читає:
 * нова вакансія з вищим рахунком витісняє ту, яку власник ще не встиг подивитись.
 * Порядок фіксується один раз на добу, рішення записується сюди ж.
 */
export const queueItems = sqliteTable(
  'queue_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    day: text('day').notNull(),
    vacancyId: integer('vacancy_id')
      .notNull()
      .references(() => vacancies.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    scoreAtPick: real('score_at_pick'),
    // pending | interesting | not_interesting | contacted | blacklist | snoozed
    decision: text('decision'),
    decidedAt: integer('decided_at'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('queue_items_day_vacancy_uq').on(t.day, t.vacancyId),
    index('queue_items_day_idx').on(t.day, t.position),
  ],
);

/**
 * Кеш класифікацій. Ключ це хеш тексту, який реально пішов у модель, плюс модель і
 * версія промпта. Редизайн верстки міняє хеш блока, але не текст вакансії, тому
 * повторний виклик моделі не потрібен.
 */
export const llmCache = sqliteTable(
  'llm_cache',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    key: text('key').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    response: text('response', { mode: 'json' }).notNull(),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [uniqueIndex('llm_cache_key_uq').on(t.key)],
);

/** Денний лічильник викликів, щоб не спалити бюджет мовчки. */
export const llmUsage = sqliteTable('llm_usage', {
  day: text('day').primaryKey(),
  calls: integer('calls').notNull().default(0),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  failures: integer('failures').notNull().default(0),
});

/**
 * Налаштування, які власник править з інтерфейсу. `config/scoring.json` лишається
 * значенням за замовчуванням, а запис тут його перекриває.
 *
 * Навіщо окрема таблиця, а не файл: на Workers файлової системи немає, конфіг вшитий
 * у бандл. Без цієї таблиці правила на проді можна змінити лише новим деплоєм.
 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at').notNull().default(now),
});

/**
 * Шаблони листів і резюме. Тексти пише власник, інструмент їх лише зберігає
 * і підставляє в історію контактів. Генерувати листи тут заборонено, розділ 11
 * у CLAUDE.md, тому жодного звернення до моделі в цій таблиці не передбачено.
 */
export const templates = sqliteTable(
  'templates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Стабільний ключ, який лягає в outreach.template_used. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    /** vacancy | studio | resume. Визначає, де шаблон пропонується. */
    kind: text('kind').notNull().default('vacancy'),
    /**
     * Мова тексту: uk | en. Один шаблон не буває двомовним, бо переклад це інший
     * текст, а не те саме іншими словами. Вибір мови детермінований: країна UA
     * означає uk, решта en.
     */
    language: text('language').notNull().default('uk'),
    /**
     * Під який випадок розсилки заточений шаблон:
     * vacancy | studio_named | studio_generic | followup.
     *
     * Саме за цим полем чернетка вибирає шаблон, і вибір робить код, не модель.
     * Порожнє означає, що шаблон у розсилці не бере участі і лежить для ручного
     * копіювання зі сторінки Шаблони.
     */
    targetType: text('target_type'),
    /**
     * Тип компанії, під який заточений текст: design | startup | studio | outstaff.
     * Порожнє означає універсальний. Дизайн-студії і стартапу пишеться зовсім різне,
     * і вибирати шаблон руками щоразу це те саме тертя, через яке листи не пишуться.
     */
    forKind: text('for_kind'),
    subject: text('subject'),
    /**
     * Статичний перший абзац. Тіло листа підставляє його через `{{intro}}`.
     *
     * Розділений навмисно: перший абзац це єдине, що персоналізується моделлю,
     * а другий і третій містять факти про власника і генеруватись не мають.
     * Відкат валідації означає підстановку саме цього тексту, тому лист ніколи
     * не лишається без першого абзацу і ніколи не блокується через модель.
     */
    intro: text('intro'),
    body: text('body').notNull().default(''),
    note: text('note'),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull().default(now),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [uniqueIndex('templates_slug_uq').on(t.slug)],
);

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
export type Vacancy = typeof vacancies.$inferSelect;
export type NewVacancy = typeof vacancies.$inferInsert;
export type Snapshot = typeof snapshots.$inferSelect;
export type QueueItem = typeof queueItems.$inferSelect;
export type Outreach = typeof outreach.$inferSelect;
export type CompanyState = typeof companyState.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type Template = typeof templates.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type Fact = typeof facts.$inferSelect;
export type SendLog = typeof sendLog.$inferSelect;
export type NewTemplate = typeof templates.$inferInsert;
