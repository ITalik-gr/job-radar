import { config } from '../config.js';
import { log } from './log.js';
import { encodeMessage, type MimeMessage } from './mime.js';

/**
 * Gmail through OAuth2 and plain REST, without Google's client library.
 *
 * Why no library: exactly three calls are needed (code exchange, token refresh, sending) plus
 * reading a thread for reply detection. The `googleapis` package pulls in dozens of megabytes
 * and does not run on Workers, while here everything fits into one file you can read whole.
 *
 * Why OAuth rather than SMTP with an app password: SMTP returns neither `threadId` nor incoming
 * mail, so it allows neither reply detection nor a follow-up in the same thread. And Google is
 * gradually closing app passwords.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

/**
 * `gmail.send` for sending, `gmail.readonly` only for detecting replies and bounces. Neither
 * `gmail.modify` nor full `mail.google.com` is requested: the tool has no right to change
 * anything in the owner's mailbox.
 */
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
];

export interface StoredToken {
  refreshToken: string;
  accessToken?: string;
  /** Unix milliseconds. Refreshed a minute before expiry, not at the last second. */
  expiresAt?: number;
  email?: string;
  scopes?: string[];
  connectedAt?: number;
}

export function redirectUri(): string {
  return config.gmail.redirectUri || `http://127.0.0.1:${config.gmail.authPort}/callback`;
}

/**
 * The sender address has to be an address.
 *
 * The check is not redundant: the value comes from a secret typed by hand in a terminal, and a
 * keyboard layout slip turns it into gibberish, after which the letter either does not go or
 * goes with an unreadable From. A silent From is worse than an error on screen, because only
 * the recipient sees it.
 */
export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

export function isConfigured(): boolean {
  return Boolean(config.gmail.clientId && config.gmail.clientSecret && isEmail(config.gmail.fromEmail));
}

/**
 * The token store is injected from outside, just like the database driver.
 *
 * Same reason: this file ends up in the Cloudflare Worker bundle along with the API routes, and
 * `node:fs` can do nothing there. The file-based implementation is installed by
 * `gmail-store.node.ts`; on Workers the Gmail token comes from an environment secret instead.
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
    log.warn({ error: String(error) }, 'Gmail token cannot be read');
    return null;
  }
}

export function saveToken(token: StoredToken): void {
  if (!store) throw new Error('token store not attached: import lib/gmail-store.node.js');
  store.save(token);
}

export function forgetToken(): void {
  store?.forget();
}

/**
 * `access_type=offline` and `prompt=consent` are both needed for Google to return a refresh
 * token. Without `prompt=consent` a reconnect yields only an access token for an hour, and the
 * next day sending silently stops working.
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

/** Exchange the browser code for tokens. Called once, by the `auth:gmail` command. */
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
      'Google did not return a refresh token. Revoke access in the account settings and try again',
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
 * A live access token. Refreshes itself 60 seconds before it expires.
 *
 * An expired refresh token is not silent: it throws a clear error with a hint, because a silent
 * failure here means letters just stopped going out, and the owner finds out a week later.
 */
export async function accessToken(): Promise<string> {
  if (!isConfigured()) {
    throw new Error('Gmail is not configured: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GMAIL_FROM_EMAIL are required');
  }

  if (!hasTokenStore()) {
    throw new Error('Gmail sending runs locally: Workers has nowhere to keep the Gmail token');
  }

  const token = loadToken();
  if (!token?.refreshToken) {
    throw new Error('Gmail is not connected, run: pnpm cli auth:gmail');
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
    throw new Error(`${String(error)}. The refresh token expired, run again: pnpm cli auth:gmail`);
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
  /** The address from settings, as is. Shown even when it is broken. */
  fromEmail: string | null;
  emailValid: boolean;
  scopes: string[];
  connectedAt: number | null;
  /** When the current access token expires. The refresh token lives longer and has no date. */
  expiresAt: number | null;
  hint: string | null;
}

/** Connection status for the interface and the CLI. There must be no silent states here. */
export function gmailStatus(): GmailStatus {
  const configured = isConfigured();
  const local = hasTokenStore();
  /*
   * The token is read independently of the other settings. Otherwise a broken sender address
   * would pretend mail is not connected at all, and the owner would go through OAuth again
   * instead of fixing one secret.
   */
  const token = loadToken();
  const connected = Boolean(token?.refreshToken);
  const emailValid = isEmail(config.gmail.fromEmail);

  return {
    configured,
    connected,
    email: emailValid ? (token?.email ?? null) : null,
    fromEmail: config.gmail.fromEmail || null,
    emailValid,
    scopes: token?.scopes ?? [],
    connectedAt: token?.connectedAt ?? null,
    expiresAt: token?.expiresAt ?? null,
    hint: !local
      ? 'Gmail sending runs locally, not on Workers'
      : config.gmail.fromEmail && !emailValid
        ? `GMAIL_FROM_EMAIL is not an address: "${config.gmail.fromEmail}". Looks like a keyboard layout slip, set the secret again`
        : !configured
          ? 'set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GMAIL_FROM_EMAIL'
          : connected
            ? null
            : 'press "connect" and grant access in Google',
  };
}

export interface SendInput {
  to: string;
  subject: string;
  body: string;
  /** The original thread. Required for a follow-up, otherwise it goes out as a separate letter. */
  threadId?: string | null;
  inReplyTo?: string | null;
  references?: string[];
}

export interface SendResult {
  messageId: string;
  threadId: string;
  /** The RFC Message-Id header. Needed so a follow-up references exactly this letter. */
  rfcMessageId: string | null;
}

/**
 * Em dashes are stripped here, at the last line of defence before sending.
 *
 * The rule forbids them everywhere, but the only place where a violation can no longer be fixed
 * is a sent letter. So the check sits exactly at the exit, not only in the template editor.
 */
export function stripEmDash(text: string): string {
  return text.replace(/\s*—\s*/g, ', ').replace(/,\s*,/g, ',');
}

/**
 * Gmail errors arrive as a paragraph of text with a link to the console. The most common ones
 * mean one specific action, and naming it right away is cheaper than making someone read the
 * paragraph and guess.
 */
export function explainSendError(message: string | undefined, status: number): string {
  const text = message ?? `code ${status}`;

  if (/has not been used in project|is disabled/i.test(text)) {
    return 'The Gmail API is disabled in the Google project. Enable it in Google Cloud Console (APIs and Services, Enable APIs, Gmail API) and retry in a minute';
  }
  if (/insufficient|scope/i.test(text)) {
    return 'missing permissions: reconnect mail to grant gmail.send and gmail.readonly';
  }
  if (/invalid_grant|unauthorized|401/i.test(text)) {
    return 'the Gmail token expired or was revoked, reconnect mail';
  }
  if (/rate|quota|429/i.test(text)) {
    return 'Gmail temporarily limited sending, try again in a few minutes';
  }
  return `Gmail rejected the letter: ${text}`;
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
    throw new Error(explainSendError(data.error?.message, response.status));
  }

  log.info({ to: input.to, messageId: data.id }, 'letter sent');
  return {
    messageId: data.id,
    threadId: data.threadId ?? data.id,
    rfcMessageId: await rfcMessageId(data.id, token),
  };
}

/**
 * The Message-Id Gmail set after sending. Without it a follow-up has nothing to reference: the
 * `id` in the API response is an internal identifier, while `In-Reply-To` and `References`
 * expect exactly the RFC value in angle brackets.
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
  /** The first lines of the letter. Nothing more is needed to classify a reply. */
  snippet: string;
  /** The auto-responder header. Its presence removes the need to ask a model. */
  autoSubmitted: string | null;
}

/**
 * Thread messages with minimal headers. `format=metadata` on purpose: the body is not needed for
 * classification, and not reading more than needed is both faster and more honest towards the
 * `gmail.readonly` scope.
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
  if (!response.ok) throw new Error(`Gmail: thread ${threadId} cannot be read, ${response.status}`);

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
