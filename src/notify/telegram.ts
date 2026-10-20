import { Bot } from 'grammy';
import { desc, sql } from 'drizzle-orm';
import { config, envValue } from '../config.js';
import { getDb } from '../db/client.js';
import { runs } from '../db/schema.js';
import { log } from '../lib/log.js';
import { followUps } from '../pipeline/actions.js';
import { listDrafts } from '../pipeline/outreach.js';
import { studioPage } from '../pipeline/studios.js';
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

/** Top leads waiting for a decision, plus a link to the web. */
export async function digestMessage(): Promise<string | null> {
  const page = await studioPage({ limit: 5 });
  if (page.cards.length === 0) return null;

  const lines = page.cards.map(
    (card) => `• <b>${escape(card.name)}</b> ${escape(card.kind)} (${card.score.toFixed(1)})`,
  );

  return [`<b>Leads</b>: ${page.aboveThreshold} above the threshold`, ...lines, WEB_URL].join('\n');
}

/**
 * Sending digest at 10:00: how many drafts are ready and how many follow-ups are due.
 *
 * A separate message from the lead list on purpose: these are different actions. The list
 * is deciding "interesting or not", sending is "sit down and send".
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

/** New companies since the last summary that already score high. */
export async function highScoreMessage(minScore = 10, sinceHours = 24): Promise<string | null> {
  const since = Date.now() - sinceHours * 3_600_000;
  const page = await studioPage({ minScore, limit: 1000 });
  const fresh = page.cards.filter((card) => card.firstSeen >= since).slice(0, 5);
  if (fresh.length === 0) return null;

  return [
    `<b>New leads with score ${minScore}+</b>`,
    ...fresh.map((card) => `• <b>${escape(card.name)}</b> ${escape(card.domain)} (${card.score.toFixed(1)})`),
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
 * Separate pushes (leads, sending, follow-ups, finds, broken sources) used to arrive daily and
 * several at a time, so the bot turned into noise. Now each part is a section of one message,
 * and an empty section is simply left out.
 */
export async function summaryMessage(): Promise<string | null> {
  const strip = (text: string | null): string | null => text?.replace(`\n${WEB_URL}`, '') ?? null;

  const sections = [
    strip(await digestMessage()),
    strip(await highScoreMessage(10, SUMMARY_WINDOW_HOURS)),
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
 * changes. Every action on companies happens on the web.
 */
export const HELP_TEXT = `<b>Lead Radar</b>, a personal client finder.

<b>How it works</b>
1. <b>Sources</b>. Catalogs (DOU, YC, Awwwards, Clutch and others through the extension) bring
   companies. Boards (HN, Getro, DOU, Djinni, ATS) bring companies and a "hiring developers" signal.
2. <b>Enrichment</b>. The site is crawled for stack, signs of life and named contacts.
3. <b>Scoring</b> is deterministic, the weights live in config/scoring.json and on the Rules
   page: segment, industry, size, stack, country, reputation, hiring.
4. <b>Letters</b> are your own templates with placeholders. Every letter is sent by your click.

<b>What to do on the web</b> ${WEB_URL}
• <b>Studios</b> and <b>Companies</b>: leads, filters, actions, drafts
• <b>Sending</b>: drafts ready to go, the daily limit
• <b>Outreach</b>: who was written to, when, and whether they replied
• <b>Sources</b> and <b>Operations</b>: adapter health and manual runs

<b>What arrives here</b>
One summary on Monday and Thursday at 10:00, nothing in between:
• top leads
• new strong leads since the previous summary
• ready drafts and follow-ups due
• those contacted over 7 days ago with no reply
• broken sources (zero results where there used to be more)

<b>Bot commands</b>
/help this help
/status what is in the database right now
/queue top leads
/followups who is due a reminder`;

export async function statusText(): Promise<string> {
  const db = getDb();
  const [counts] = await db.all<{ companies: number; ua: number; hiring: number }>(
    sql`select count(*) as companies,
      sum(case when market = 'ua' then 1 else 0 end) as ua,
      sum(case when hiring_devs = 1 then 1 else 0 end) as hiring
    from companies`,
  );
  const page = await studioPage({ limit: 1 });
  const waiting = await followUps(7);

  return [
    `<b>Status</b>`,
    `companies: ${counts?.companies ?? 0}, Ukrainian: ${counts?.ua ?? 0}, hiring: ${counts?.hiring ?? 0}`,
    `leads above the threshold: ${page.aboveThreshold}`,
    `awaiting reply over 7 days: ${waiting.length}`,
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
    ctx.reply((await digestMessage()) ?? 'no leads above the threshold', {
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
