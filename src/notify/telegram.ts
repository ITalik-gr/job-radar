import { Bot } from 'grammy';
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { config, envValue } from '../config.js';
import { getDb } from '../db/client.js';
import { companies, runs, vacancies } from '../db/schema.js';
import { log } from '../lib/log.js';
import { followUps } from '../pipeline/actions.js';
import { getQueue, todayKey } from '../pipeline/queue.js';
import { listDrafts } from '../pipeline/outreach.js';
import { dueFollowups } from '../pipeline/followups.js';

/**
 * Телеграм тут допоміжний канал: тільки алерти і нагадування.
 * Ніяких інлайн-кнопок і керування станом через бота, всі дії робляться у вебі.
 */

export type Sender = (text: string) => Promise<void>;

let bot: Bot | null = null;

export function isConfigured(): boolean {
  return Boolean(config.telegram.token && config.telegram.chatId);
}

async function send(text: string): Promise<void> {
  if (!isConfigured()) {
    log.warn('телеграм не налаштований, повідомлення не надіслано');
    return;
  }
  bot ??= new Bot(config.telegram.token);
  await bot.api.sendMessage(config.telegram.chatId, text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
}

export const WEB_URL = envValue('WEB_URL') ?? 'https://job-radar.example.workers.dev';

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Ранковий дайджест: скільки нового у черзі і посилання на веб. */
export async function digestMessage(day = todayKey()): Promise<string | null> {
  const cards = await getQueue(day);
  const pending = cards.filter((card) => !card.decision);
  if (pending.length === 0) return null;

  const lines = pending
    .slice(0, 5)
    .map((card) => `• <b>${escape(card.company)}</b> ${escape(card.title ?? '')} (${card.score?.toFixed(1)})`);

  return [
    `<b>Черга на ${day}</b>: ${pending.length} карток`,
    ...lines,
    pending.length > 5 ? `і ще ${pending.length - 5}` : '',
    WEB_URL,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Дайджест розсилки о 10:00: скільки чернеток готово і скільки фолоу-апів настало.
 *
 * Окремим повідомленням від черги вакансій навмисно: це різні дії. Черга це
 * рішення "цікаво чи ні", розсилка це "сісти і надіслати".
 */
export async function outreachMessage(): Promise<string | null> {
  const drafts = await listDrafts();
  const ready = drafts.filter((row) => !row.error);
  const stuck = drafts.length - ready.length;
  const due = await dueFollowups();

  if (ready.length === 0 && stuck === 0 && due.length === 0) return null;

  return [
    '<b>Розсилка</b>',
    `готових чернеток: ${ready.length}`,
    stuck > 0 ? `потребують уваги: ${stuck}` : '',
    due.length > 0 ? `настав фолоу-ап: ${due.length}` : '',
    WEB_URL,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Алерт про рідкісну дуже релевантну вакансію. Поріг вищий за поріг черги. */
export async function highScoreMessage(minScore = 12, sinceHours = 24): Promise<string | null> {
  const db = getDb();
  const since = Date.now() - sinceHours * 3_600_000;

  const rows = await db
    .select({ vacancy: vacancies, company: companies.name })
    .from(vacancies)
    .innerJoin(companies, eq(companies.id, vacancies.companyId))
    .where(
      and(
        isNull(vacancies.closedAt),
        gte(vacancies.firstSeen, since),
        sql`${vacancies.score} >= ${minScore}`,
      ),
    )
    .orderBy(desc(vacancies.score))
    .limit(5);

  if (rows.length === 0) return null;

  return [
    `<b>Знахідки зі score ${minScore}+</b>`,
    ...rows.map(
      (row) =>
        `• <b>${escape(row.company)}</b> ${escape(row.vacancy.title ?? '')} (${row.vacancy.score?.toFixed(1)})\n${row.vacancy.url}`,
    ),
  ].join('\n');
}

/** Нагадування про фолоу-апи: кому писали давно і відповіді немає. */
export async function followUpMessage(days = 7): Promise<string | null> {
  const rows = await followUps(days);
  if (rows.length === 0) return null;

  return [
    `<b>Без відповіді понад ${days} днів</b>: ${rows.length}`,
    ...rows
      .slice(0, 10)
      .map((row) => `• ${escape(row.company)}, писали ${row.waitingDays} дн тому${row.templateUsed ? `, ${escape(row.templateUsed)}` : ''}`),
    `${WEB_URL}`,
  ].join('\n');
}

/** Алерт про поламаний адаптер: статус warn або error в останньому запуску. */
export async function brokenSourcesMessage(): Promise<string | null> {
  const db = getDb();
  const rows = await db.select().from(runs).orderBy(desc(runs.startedAt)).limit(100);

  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!latest.has(row.source)) latest.set(row.source, row);

  const broken = [...latest.values()].filter((row) => row.status === 'warn' || row.status === 'error');
  if (broken.length === 0) return null;

  return [
    '<b>Проблемні джерела</b>',
    ...broken.map(
      (row) =>
        `• ${escape(row.source)}: ${row.status}, знайдено ${row.itemsFound}${row.errors.length > 0 ? `, ${escape(row.errors[0] ?? '')}` : ''}`,
    ),
  ].join('\n');
}

export interface NotifyOptions {
  /** Підміна відправника у тестах і для сухого прогону. */
  sender?: Sender;
}

async function deliver(text: string | null, options: NotifyOptions): Promise<boolean> {
  if (!text) return false;
  await (options.sender ?? send)(text);
  return true;
}

export interface ChatProbe {
  botUsername: string | null;
  chats: { id: number; type: string; title: string }[];
  configuredChatId: string;
  reachable: boolean;
  hint: string;
}

/**
 * Телеграм не дозволяє боту писати першим: поки людина не натисне Start у чаті з ботом,
 * будь-який sendMessage повертає "chat not found". Ця перевірка це і пояснює.
 */
export async function probe(): Promise<ChatProbe> {
  if (!config.telegram.token) {
    return {
      botUsername: null,
      chats: [],
      configuredChatId: config.telegram.chatId,
      reachable: false,
      hint: 'немає TELEGRAM_BOT_TOKEN у .env',
    };
  }

  const probeBot = new Bot(config.telegram.token);
  const me = await probeBot.api.getMe();
  const updates = await probeBot.api.getUpdates({ limit: 20 });

  const chats = new Map<number, { id: number; type: string; title: string }>();
  for (const update of updates) {
    const chat = update.message?.chat ?? update.my_chat_member?.chat ?? update.channel_post?.chat;
    if (!chat) continue;
    chats.set(chat.id, {
      id: chat.id,
      type: chat.type,
      title: 'title' in chat ? (chat.title ?? '') : `${chat.first_name ?? ''} ${chat.username ? '@' + chat.username : ''}`.trim(),
    });
  }

  let reachable = false;
  let hint = '';
  if (config.telegram.chatId) {
    try {
      await probeBot.api.getChat(config.telegram.chatId);
      reachable = true;
      hint = 'чат доступний, можна надсилати';
    } catch (error) {
      hint = `чат недоступний: ${error instanceof Error ? error.message : String(error)}. Відкрий https://t.me/${me.username} і натисни Start`;
    }
  } else {
    hint = `немає TELEGRAM_CHAT_ID. Відкрий https://t.me/${me.username}, натисни Start і запусти цю команду ще раз`;
  }

  return { botUsername: me.username, chats: [...chats.values()], configuredChatId: config.telegram.chatId, reachable, hint };
}

/**
 * Довідка в боті. Це єдина інтерактивна частина телеграма: тільки читання,
 * жодних змін стану. Всі дії над компаніями і вакансіями робляться у вебі.
 */
export const HELP_TEXT = `<b>Job Radar</b>, особистий радар вакансій.

<b>Як це працює</b>
1. <b>Джерела</b>. ATS (Greenhouse, Lever, Ashby) віддають вакансії чистим JSON, RSS-фіди
   (WeWorkRemotely, Himalayas, Remotive) і RemoteOK дають потік віддалених позицій.
   Компанії без ATS обходяться по власних career-сторінках.
2. <b>Каталоги компаній</b>. DOU збирається автоматично, Clutch і TechBehemoths за
   Cloudflare, тому імпортуються збереженими сторінками з браузера.
3. <b>Виявлення змін</b>. Для ATS порівнюються id вакансій. Для звичайних сторінок текст
   чиститься від дат, лічильників і хешів, потім порівнюються хеші окремих блоків.
   Тому щоденні косметичні зміни не рахуються за нові вакансії.
4. <b>Фільтр</b>. Спершу стоп-слова (angular, .net, qa, casino і решта), вони ріжуть
   вакансію ще до звернення до моделі. Потім Claude Haiku витягує стек, грейд, локацію,
   вилку і рівень англійської строгим JSON.
5. <b>Скоринг</b> детермінований, списки лежать у config/scoring.json:
   • роль перевіряється за назвою, інакше бухгалтер з описом про Next.js лізе в чергу
   • гео: "Remote (US)", "San Francisco, hybrid" і будь-яке місто без ознак віддаленості
     не підходять, бо переїзд неможливий
   • мінуси за 5+ років (-4), 7+ (-8), лідську позицію, equity only, C1 плюс відеозвінок
   • назва важить утричі більше за текст, бали з тексту обмежені стелею
6. <b>Черга</b>. Щодня фіксується зріз з 10 карток, він не перемішується протягом дня.
   Показане за останні 30 днів більше не повертається.

<b>Що робити у вебі</b> ${WEB_URL}
• <b>Черга</b>: вакансії. Цікаво, Не цікаво, Написав (з вибором шаблона), Блок, Відкласти
• <b>Студії</b>: агенції і веб-студії, яким варто запропонувати послуги. Вакансія їм не потрібна,
  рахунок рахується з розміру, профілю послуг, стеку сайту і країни
• <b>Компанії</b>: пошук і фільтри, історія вакансій, листування і знімків сторінок
• <b>Контакти</b>: кому писали, коли, чи відповіли. Позначки: позитивна, відмова, автовідповідь
• <b>Статистика</b>: топ технологій, медіанні вилки, час життя вакансій, підозри на ghost jobs, воронка
• <b>Джерела</b>: стан кожного адаптера, кнопки запуску вручну

<b>Що приходить сюди</b>
• 10:00 дайджест черги
• 18:00 нагадування про тих, кому писали понад 7 днів тому без відповіді
• алерт про рідкісну знахідку зі score 12+
• алерт про поламане джерело (нуль результатів там, де раніше було більше)

<b>Команди бота</b>
/help довідка
/status що зараз у базі і в черзі
/queue топ карток на сьогодні
/followups кому час нагадати

Дії над вакансіями через бота навмисно не робляться, для цього є веб.`;

export async function statusText(): Promise<string> {
  const db = getDb();
  const [counts] = await db
    .select({
      companies: sql<number>`(select count(*) from companies)`,
      open: sql<number>`(select count(*) from vacancies where closed_at is null)`,
      above: sql<number>`(select count(*) from vacancies where score >= ${config.pipeline.scoreThreshold})`,
      review: sql<number>`(select count(*) from vacancies where needs_review = 1)`,
    })
    .from(vacancies)
    .limit(1);

  const cards = await getQueue();
  const pending = cards.filter((card) => !card.decision).length;
  const waiting = await followUps(7);

  return [
    `<b>Стан</b>`,
    `компаній: ${counts?.companies ?? 0}`,
    `відкритих вакансій: ${counts?.open ?? 0}, з них вище порогу: ${counts?.above ?? 0}`,
    `у черзі сьогодні: ${pending} з ${cards.length}`,
    `чекають відповіді понад 7 днів: ${waiting.length}`,
    `на ручний перегляд: ${counts?.review ?? 0}`,
    WEB_URL,
  ].join('\n');
}

let running: Bot | null = null;

/** Довгий полінг для команд довідки. Вимикається змінною TELEGRAM_BOT=off. */
function registerCommands(instance: Bot): void {
  instance.command(['start', 'help'], (ctx) =>
    ctx.reply(HELP_TEXT, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
  );
  instance.command('status', async (ctx) =>
    ctx.reply(await statusText(), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
  );
  instance.command('queue', async (ctx) =>
    ctx.reply((await digestMessage()) ?? 'черга порожня', {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    }),
  );
  instance.command('followups', async (ctx) =>
    ctx.reply((await followUpMessage()) ?? 'усім відповіли або нікому не писали', {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    }),
  );

  instance.catch((error) => log.warn({ err: String(error.error) }, 'бот спіткнувся на оновленні'));
}

/** Довгий полінг для Node. На Workers замість нього вебхук. */
export async function startBot(): Promise<void> {
  if (!isConfigured() || running) return;
  const instance = buildBot();
  running = instance;
  void instance.start({ onStart: (info) => log.info({ bot: info.username }, 'телеграм-бот слухає команди') });
}

/**
 * На Cloudflare довгий полінг неможливий, тому команди приходять вебхуком.
 * Обробник той самий, що і в полінгу, тільки викликається з роуту API.
 */
export function buildBot(): Bot {
  const instance = new Bot(config.telegram.token);
  registerCommands(instance);
  return instance;
}

export async function stopBot(): Promise<void> {
  if (!running) return;
  await running.stop();
  running = null;
}

export const notify = {
  digest: (options: NotifyOptions = {}) => digestMessage().then((text) => deliver(text, options)),
  highScore: (options: NotifyOptions = {}) => highScoreMessage().then((text) => deliver(text, options)),
  followUps: (options: NotifyOptions = {}) => followUpMessage().then((text) => deliver(text, options)),
  broken: (options: NotifyOptions = {}) => brokenSourcesMessage().then((text) => deliver(text, options)),
  outreach: (options: NotifyOptions = {}) => outreachMessage().then((text) => deliver(text, options)),
  raw: (text: string, options: NotifyOptions = {}) => deliver(text, options),
};
