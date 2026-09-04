import { config } from '../config.js';
import { log } from './log.js';
import { encodeMessage, type MimeMessage } from './mime.js';

/**
 * Gmail через OAuth2 і чистий REST, без клієнтської бібліотеки Google.
 *
 * Навіщо без бібліотеки: потрібні рівно три виклики (обмін коду, оновлення
 * токена, відправка) плюс читання треду на Етапі 5. Пакет `googleapis` тягне
 * десятки мегабайт і не працює на Workers, а тут усе вміщується в один файл,
 * який видно очима цілком.
 *
 * Чому OAuth, а не SMTP з app password: SMTP не віддає ні `threadId`, ні вхідні
 * листи, тобто з ним неможливі ні детекція відповідей, ні фолоу-ап у тому самому
 * треді. Плюс app passwords Google поступово прикриває.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

/**
 * `gmail.send` для відправки, `gmail.readonly` виключно для детекції відповідей
 * і баунсів. Ні `gmail.modify`, ні повний `mail.google.com` не запитуються:
 * інструмент не має права нічого змінювати в пошті власника.
 */
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
];

export interface StoredToken {
  refreshToken: string;
  accessToken?: string;
  /** unix-мілісекунди. Оновлюємо за хвилину до кінця, а не в останню секунду. */
  expiresAt?: number;
  email?: string;
  scopes?: string[];
  connectedAt?: number;
}

export function redirectUri(): string {
  return config.gmail.redirectUri || `http://127.0.0.1:${config.gmail.authPort}/callback`;
}

export function isConfigured(): boolean {
  return Boolean(config.gmail.clientId && config.gmail.clientSecret && config.gmail.fromEmail);
}

/**
 * Сховище токена підставляється ззовні, так само як драйвер бази.
 *
 * Причина та сама: цей файл потрапляє в бандл Cloudflare Worker разом з роутами
 * API, а `node:fs` там ні на що не здатний. Файлову реалізацію ставить
 * `gmail-store.node.ts`, і на Workers розсилки просто немає, що чесно: листи
 * йдуть з ноутбука власника, а не з воркера.
 */
export interface TokenStore {
  load(): StoredToken | null;
  save(token: StoredToken): void;
  forget(): void;
}

let store: TokenStore | null = null;

export function setTokenStore(next: TokenStore): void {
  store = next;
}

export function hasTokenStore(): boolean {
  return store !== null;
}

export function loadToken(): StoredToken | null {
  if (!store) return null;
  try {
    return store.load();
  } catch (error) {
    log.warn({ error: String(error) }, 'токен Gmail не читається');
    return null;
  }
}

export function saveToken(token: StoredToken): void {
  if (!store) throw new Error('сховище токена не підключене: імпортуй lib/gmail-store.node.js');
  store.save(token);
}

export function forgetToken(): void {
  store?.forget();
}

/**
 * `access_type=offline` і `prompt=consent` разом потрібні, щоб Google віддав
 * refresh token. Без `prompt=consent` на повторному підключенні приходить лише
 * access token на годину, і наступного дня розсилка мовчки перестає працювати.
 */
export function authUrl(state = ''): string {
  const params = new URLSearchParams({
    client_id: config.gmail.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: GMAIL_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  if (state) params.set('state', state);
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const data = (await response.json()) as TokenResponse;
  if (!response.ok || data.error) {
    throw new Error(`Gmail OAuth: ${data.error ?? response.status} ${data.error_description ?? ''}`.trim());
  }
  return data;
}

/** Обмін коду з браузера на токени. Викликається один раз, командою `auth:gmail`. */
export async function exchangeCode(code: string): Promise<StoredToken> {
  const data = await tokenRequest({
    code,
    client_id: config.gmail.clientId,
    client_secret: config.gmail.clientSecret,
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code',
  });

  if (!data.refresh_token) {
    throw new Error(
      'Google не віддав refresh token. Відкликати доступ у налаштуваннях акаунта і повторити',
    );
  }

  const token: StoredToken = {
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
    scopes: data.scope?.split(' '),
    connectedAt: Date.now(),
  };

  saveToken(token);
  const profile = await profileEmail(token.accessToken!);
  if (profile) {
    token.email = profile;
    saveToken(token);
  }
  return token;
}

async function profileEmail(accessToken: string): Promise<string | null> {
  const response = await fetch(`${GMAIL_API}/profile`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { emailAddress?: string };
  return data.emailAddress ?? null;
}

/**
 * Живий access token. Оновлюється сам за 60 секунд до кінця життя.
 *
 * Протухлий refresh token не мовчить: він кидає зрозумілу помилку з підказкою,
 * бо мовчазний відмовник тут означає, що листи просто перестали йти, а власник
 * дізнається про це через тиждень.
 */
export async function accessToken(): Promise<string> {
  if (!isConfigured()) {
    throw new Error('Gmail не налаштований: потрібні GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GMAIL_FROM_EMAIL');
  }

  if (!hasTokenStore()) {
    throw new Error('розсилка працює локально: на Workers немає де тримати токен Gmail');
  }

  const token = loadToken();
  if (!token?.refreshToken) {
    throw new Error('Gmail не підключений, виконати: pnpm cli auth:gmail');
  }

  if (token.accessToken && token.expiresAt && token.expiresAt > Date.now() + 60_000) {
    return token.accessToken;
  }

  let data: TokenResponse;
  try {
    data = await tokenRequest({
      refresh_token: token.refreshToken,
      client_id: config.gmail.clientId,
      client_secret: config.gmail.clientSecret,
      grant_type: 'refresh_token',
    });
  } catch (error) {
    throw new Error(`${String(error)}. Refresh token протух, повторити: pnpm cli auth:gmail`);
  }

  const next: StoredToken = {
    ...token,
    accessToken: data.access_token,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
  };
  saveToken(next);
  return next.accessToken!;
}

export interface GmailStatus {
  configured: boolean;
  connected: boolean;
  email: string | null;
  scopes: string[];
  connectedAt: number | null;
  /** Коли протухає поточний access token. Refresh token живе довше і дати не має. */
  expiresAt: number | null;
  hint: string | null;
}

/** Стан підключення для інтерфейсу і для CLI. Мовчазних станів тут бути не має. */
export function gmailStatus(): GmailStatus {
  const configured = isConfigured();
  const local = hasTokenStore();
  const token = configured ? loadToken() : null;
  const connected = Boolean(token?.refreshToken);

  return {
    configured,
    connected,
    email: token?.email ?? null,
    scopes: token?.scopes ?? [],
    connectedAt: token?.connectedAt ?? null,
    expiresAt: token?.expiresAt ?? null,
    hint: !local
      ? 'розсилка запускається локально, не на Workers'
      : !configured
        ? 'заповнити GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET і GMAIL_FROM_EMAIL у .env'
        : connected
          ? null
          : 'виконати pnpm cli auth:gmail',
  };
}

export interface SendInput {
  to: string;
  subject: string;
  body: string;
  /** Тред оригіналу. Обовʼязковий для фолоу-апу, інакше він піде окремим листом. */
  threadId?: string | null;
  inReplyTo?: string | null;
  references?: string[];
}

export interface SendResult {
  messageId: string;
  threadId: string;
  /** RFC-заголовок Message-Id. Потрібен, щоб фолоу-ап послався саме на цей лист. */
  rfcMessageId: string | null;
}

/**
 * Em dash ріжеться тут, на останньому рубежі перед відправкою.
 *
 * Правило заборонає його всюди, але єдине місце, де порушення вже неможливо
 * виправити, це надісланий лист. Тому перевірка стоїть саме на виході, а не
 * лише в редакторі шаблонів.
 */
export function stripEmDash(text: string): string {
  return text.replace(/\s*—\s*/g, ', ').replace(/,\s*,/g, ',');
}

export async function sendMessage(input: SendInput): Promise<SendResult> {
  const token = await accessToken();

  const message: MimeMessage = {
    fromName: config.gmail.fromName,
    fromEmail: config.gmail.fromEmail,
    to: input.to,
    subject: stripEmDash(input.subject),
    body: stripEmDash(input.body),
    inReplyTo: input.inReplyTo,
    references: input.references,
  };

  const response = await fetch(`${GMAIL_API}/messages/send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      raw: encodeMessage(message),
      ...(input.threadId ? { threadId: input.threadId } : {}),
    }),
  });

  const data = (await response.json()) as {
    id?: string;
    threadId?: string;
    error?: { message?: string };
  };
  if (!response.ok || !data.id) {
    throw new Error(`Gmail не прийняв лист: ${data.error?.message ?? response.status}`);
  }

  log.info({ to: input.to, messageId: data.id }, 'лист надіслано');
  return {
    messageId: data.id,
    threadId: data.threadId ?? data.id,
    rfcMessageId: await rfcMessageId(data.id, token),
  };
}

/**
 * Message-Id, який Gmail проставив уже після відправки. Без нього фолоу-ап нема
 * на що послатись: `id` з відповіді API це внутрішній ідентифікатор, а заголовки
 * `In-Reply-To` і `References` чекають саме RFC-значення в кутових дужках.
 */
async function rfcMessageId(messageId: string, token: string): Promise<string | null> {
  const response = await fetch(
    `${GMAIL_API}/messages/${messageId}?format=metadata&metadataHeaders=Message-Id`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!response.ok) return null;
  const data = (await response.json()) as {
    payload?: { headers?: { name: string; value: string }[] };
  };
  const header = data.payload?.headers?.find((row) => row.name.toLowerCase() === 'message-id');
  return header?.value ?? null;
}

export interface ThreadMessage {
  id: string;
  from: string;
  subject: string;
  date: string;
  /** Перші рядки листа. Більше для класифікації відповіді не потрібно. */
  snippet: string;
  /** Заголовок автовідповідача. Його наявність знімає потребу питати модель. */
  autoSubmitted: string | null;
}

/**
 * Повідомлення треду з мінімумом заголовків. `format=metadata` навмисно: тіло
 * листа для класифікації не потрібне, а не читати зайве це і швидше, і чесніше
 * щодо скоупа `gmail.readonly`.
 */
export async function threadMessages(threadId: string): Promise<ThreadMessage[]> {
  const token = await accessToken();
  const params = new URLSearchParams({ format: 'metadata' });
  for (const header of ['From', 'Subject', 'Date', 'Auto-Submitted']) {
    params.append('metadataHeaders', header);
  }

  const response = await fetch(`${GMAIL_API}/threads/${threadId}?${params.toString()}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`Gmail: тред ${threadId} не читається, ${response.status}`);

  const data = (await response.json()) as {
    messages?: {
      id: string;
      snippet?: string;
      payload?: { headers?: { name: string; value: string }[] };
    }[];
  };

  return (data.messages ?? []).map((message) => {
    const header = (name: string) =>
      message.payload?.headers?.find((row) => row.name.toLowerCase() === name)?.value ?? '';
    return {
      id: message.id,
      from: header('from'),
      subject: header('subject'),
      date: header('date'),
      snippet: message.snippet ?? '',
      autoSubmitted: header('auto-submitted') || null,
    };
  });
}
