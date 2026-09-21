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
 * Telegram is a secondary channel here: alerts and reminders only.
 * No inline buttons and no state changes through the bot, every action happens on the web.
 */

export type Sender = (text: string) => Promise<void>;

let bot: Bot | null = null;

export function isConfigured(): boolean {
  return Boolean(config.telegram.token && config.telegram.chatId);
}

async function send(text: string): Promise<void> {
  if (!isConfigured()) {
    log.warn('telegram is not configured, message not sent');
    return;
  }
  bot ??= new Bot(config.telegram.token);
  await bot.api.sendMessage(config.telegram.chatId, text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  });
}

/** Where notification links point. Local interface unless the radar is deployed. */
export const WEB_URL = envValue('WEB_URL') ?? 'http://localhost:5173';

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Morning digest: how much is new in the queue, plus a link to the web. */
export async function digestMessage(day = todayKey()): Promise<string | null> {
  const cards = await getQueue(day);
  const pending = cards.filter((card) => !card.decision);
  if (pending.length === 0) return null;

  const lines = pending
    .slice(0, 5)
    .map((card) => `• <b>${escape(card.company)}</b> ${escape(card.title ?? '')} (${card.score?.toFixed(1)})`);

  return [
    `<b>Queue for ${day}</b>: ${pending.length} cards`,
    ...lines,
    pending.length > 5 ? `and ${pending.length - 5} more` : '',
    WEB_URL,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Sending digest at 10:00: how many drafts are ready and how many follow-ups are due.
 *
 * A separate message from the vacancy queue on purpose: these are different actions. The
 * queue is deciding "interesting or not", sending is "sit down and send".
 */
export async function outreachMessage(): Promise<string | null> {
  const drafts = await listDrafts();
  const ready = drafts.filter((row) => !row.error);
  const stuck = drafts.length - ready.length;
  const due = await dueFollowups();

  if (ready.length === 0 && stuck === 0 && due.length === 0) return null;

  return [
    '<b>Sending</b>',
    `ready drafts: ${ready.length}`,
    stuck > 0 ? `need attention: ${stuck}` : '',
    due.length > 0 ? `follow-ups due: ${due.length}` : '',
    WEB_URL,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Alert about a rare, highly relevant vacancy. The threshold is above the queue threshold. */
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
    `<b>Finds with score ${minScore}+</b>`,
    ...rows.map(
      (row) =>
        `• <b>${escape(row.company)}</b> ${escape(row.vacancy.title ?? '')} (${row.vacancy.score?.toFixed(1)})\n${row.vacancy.url}`,
    ),
  ].join('\n');
}

/** Follow-up reminder: who was written to long ago with no reply. */
export async function followUpMessage(days = 7): Promise<string | null> {
  const rows = await followUps(days);
  if (rows.length === 0) return null;

  return [
    `<b>No reply for over ${days} days</b>: ${rows.length}`,
    ...rows
      .slice(0, 10)
      .map((row) => `• ${escape(row.company)}, contacted ${row.waitingDays}d ago${row.templateUsed ? `, ${escape(row.templateUsed)}` : ''}`),
    `${WEB_URL}`,
  ].join('\n');
}

/** Alert about a broken adapter: warn or error status on the last run. */
export async function brokenSourcesMessage(): Promise<string | null> {
  const db = getDb();
  const rows = await db.select().from(runs).orderBy(desc(runs.startedAt)).limit(100);

  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!latest.has(row.source)) latest.set(row.source, row);

  const broken = [...latest.values()].filter((row) => row.status === 'warn' || row.status === 'error');
  if (broken.length === 0) return null;

  return [
    '<b>Problem sources</b>',
    ...broken.map(
      (row) =>
        `• ${escape(row.source)}: ${row.status}, found ${row.itemsFound}${row.errors.length > 0 ? `, ${escape(row.errors[0] ?? '')}` : ''}`,
    ),
  ].join('\n');
}

/** Look-back for the summary: the longest gap between two sends (Thursday to Monday). */
export const SUMMARY_WINDOW_HOURS = 4 * 24;

/**
 * The only scheduled message: twice a week, everything in one text.
 *
 * Separate pushes (queue, sending, follow-ups, finds, broken sources) used to arrive daily and
 * several at a time, so the bot turned into noise. Now each part is a section of one message,
 * and an empty section is simply left out.
 */
export async function summaryMessage(): Promise<string | null> {
  const strip = (text: string | null): string | null => text?.replace(`\n${WEB_URL}`, '') ?? null;

  const sections = [
    strip(await digestMessage()),
    strip(await highScoreMessage(12, SUMMARY_WINDOW_HOURS)),
    strip(await outreachMessage()),
    strip(await followUpMessage()),
    await brokenSourcesMessage(),
  ].filter((section): section is string => Boolean(section));

  if (sections.length === 0) return null;
  return [...sections, WEB_URL].join('\n\n');
}

export interface NotifyOptions {
  /** Replaces the sender in tests and for a dry run. */
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
 * Telegram does not let a bot write first: until the person presses Start in the chat with the
 * bot, every sendMessage returns "chat not found". This check explains exactly that.
 */
export async function probe(): Promise<ChatProbe> {
  if (!config.telegram.token) {
    return {
      botUsername: null,
      chats: [],
      configuredChatId: config.telegram.chatId,
      reachable: false,
      hint: 'TELEGRAM_BOT_TOKEN is missing from .env',
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
      hint = 'the chat is reachable, messages can be sent';
    } catch (error) {
      hint = `the chat is unreachable: ${error instanceof Error ? error.message : String(error)}. Open https://t.me/${me.username} and press Start`;
    }
  } else {
    hint = `TELEGRAM_CHAT_ID is missing. Open https://t.me/${me.username}, press Start and run this command again`;
  }

  return { botUsername: me.username, chats: [...chats.values()], configuredChatId: config.telegram.chatId, reachable, hint };
}

/**
 * Help inside the bot. This is the only interactive part of Telegram: read only, no state
 * changes. Every action on companies and vacancies happens on the web.
 */
export const HELP_TEXT = `<b>Job Radar</b>, a personal job radar.

<b>How it works</b>
1. <b>Sources</b>. ATS boards (Greenhouse, Lever, Ashby) return vacancies as clean JSON, RSS feeds
   (WeWorkRemotely, Himalayas, Remotive) and RemoteOK give a stream of remote roles.
   Companies without an ATS are crawled through their own careers pages.
2. <b>Company catalogs</b>. DOU is collected automatically, Clutch and TechBehemoths sit behind
   Cloudflare, so they are imported as pages saved from the browser.
3. <b>Change detection</b>. For ATS boards vacancy ids are compared. For ordinary pages the text
   is stripped of dates, counters and hashes, then the hashes of individual blocks are compared.
   So daily cosmetic changes do not count as new vacancies.
4. <b>Filter</b>. Stop words first (angular, .net, qa, casino and the rest), they cut a vacancy
   before any model call. Then Claude Haiku extracts stack, seniority, location, salary and
   English level as strict JSON.
5. <b>Scoring</b> is deterministic, the lists live in config/scoring.json:
   • the role is checked by title, otherwise an accountant with a description about Next.js gets into the queue
   • geo: "Remote (US)", "San Francisco, hybrid" and any city without signs of remote work
     do not fit, because relocation is not an option
   • penalties for 5+ years (-4), 7+ (-8), lead roles, equity only, C1 plus a video call
   • the title weighs three times more than the text, text points are capped
6. <b>Queue</b>. A slice of 10 cards is fixed every day and does not reshuffle during the day.
   Anything shown in the last 30 days does not come back.

<b>What to do on the web</b> ${WEB_URL}
• <b>Queue</b>: vacancies. Interesting, Not interesting, Contacted (with a template choice), Block, Snooze
• <b>Studios</b>: agencies and web studios worth offering services to. They need no vacancy,
  the score comes from size, service profile, site stack and country
• <b>Companies</b>: search and filters, vacancy history, correspondence and page snapshots
• <b>Contacts</b>: who was written to, when, and whether they replied. Marks: positive, rejection, auto-reply
• <b>Stats</b>: top technologies, median salaries, vacancy lifetime, suspected ghost jobs, funnel
• <b>Sources</b>: the state of each adapter, manual run buttons

<b>What arrives here</b>
One summary on Monday and Thursday at 10:00, nothing in between:
• the queue for the day
• rare finds with score 12+ since the previous summary
• ready drafts and follow-ups due
• those contacted over 7 days ago with no reply
• broken sources (zero results where there used to be more)

<b>Bot commands</b>
/help this help
/status what is in the database and the queue right now
/queue top cards for today
/followups who is due a reminder

Actions on vacancies are deliberately not available through the bot, that is what the web is for.`;

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
    `<b>Status</b>`,
    `companies: ${counts?.companies ?? 0}`,
    `open vacancies: ${counts?.open ?? 0}, above threshold: ${counts?.above ?? 0}`,
    `in today's queue: ${pending} of ${cards.length}`,
    `awaiting reply over 7 days: ${waiting.length}`,
    `for manual review: ${counts?.review ?? 0}`,
    WEB_URL,
  ].join('\n');
}

let running: Bot | null = null;

/** Long polling for the help commands. Disabled with TELEGRAM_BOT=off. */
function registerCommands(instance: Bot): void {
  instance.command(['start', 'help'], (ctx) =>
    ctx.reply(HELP_TEXT, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
  );
  instance.command('status', async (ctx) =>
    ctx.reply(await statusText(), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }),
  );
  instance.command('queue', async (ctx) =>
    ctx.reply((await digestMessage()) ?? 'the queue is empty', {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    }),
  );
  instance.command('followups', async (ctx) =>
    ctx.reply((await followUpMessage()) ?? 'everyone replied or nobody was contacted', {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    }),
  );

  instance.catch((error) => log.warn({ err: String(error.error) }, 'the bot stumbled on an update'));
}

/** Long polling for Node. On Workers a webhook is used instead. */
export async function startBot(): Promise<void> {
  if (!isConfigured() || running) return;
  const instance = buildBot();
  running = instance;
  void instance.start({ onStart: (info) => log.info({ bot: info.username }, 'telegram bot is listening for commands') });
}

/**
 * Long polling is impossible on Cloudflare, so commands arrive through a webhook.
 * The handler is the same as for polling, it is just called from an API route.
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
  summary: (options: NotifyOptions = {}) => summaryMessage().then((text) => deliver(text, options)),
  raw: (text: string, options: NotifyOptions = {}) => deliver(text, options),
};
