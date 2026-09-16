import { config } from '../config.js';
import { isEmail, stripEmDash, type SendInput, type SendResult } from './gmail.js';
import { log } from './log.js';
import type { MailerStatus } from './mailer.js';

/**
 * Sending through Resend.
 *
 * Why this one next to Gmail: it is an HTTPS call and nothing else. No OAuth
 * dance, no Google Cloud project, no token file, and because there is no token
 * file it is the first sender that works from the worker. Setup is an API key
 * and a verified domain.
 *
 * What it does not do is read mail. Replies go to the mailbox behind the From
 * address and the radar never sees them, so reply detection stays a Gmail
 * feature. `readsReplies: false` in the registry says so, and the interface
 * shows it rather than letting someone assume answers are being tracked.
 */

const API = 'https://api.resend.com/emails';

/**
 * We mint the Message-Id ourselves instead of taking one from the response.
 *
 * Resend answers with its own id, which is not the RFC header, and a follow up
 * needs the header: `In-Reply-To` and `References` are matched by mail clients
 * on that exact value. Setting it on the way out is the only way to know it
 * afterwards, and it is a legal thing to do: any sender may choose its own.
 */
export function newMessageId(domain: string, random = crypto.randomUUID()): string {
  return `<${random}@${domain}>`;
}

/** Domain part of the sender address. Used for the Message-Id, per RFC 5322. */
function senderDomain(email: string): string {
  return email.split('@')[1] ?? 'localhost';
}

export function resendStatus(): MailerStatus {
  const key = Boolean(config.mail.resendKey);
  const from = config.gmail.fromEmail;
  const valid = isEmail(from);

  return {
    id: 'resend',
    connected: key && valid,
    fromEmail: from || null,
    readsReplies: false,
    hint: !key
      ? 'no RESEND_API_KEY'
      : !valid
        ? 'GMAIL_FROM_EMAIL is empty or malformed: Resend needs a sender on a domain you verified'
        : null,
  };
}

export interface ResendCaller {
  (url: string, init: RequestInit): Promise<Response>;
}

/**
 * The caller is injectable so that the test can check the request shape without
 * a network or an API key. Everything interesting here is in that shape: the
 * threading headers and the Message-Id we generate.
 */
export async function sendViaResend(
  input: SendInput,
  fetcher: ResendCaller = fetch,
): Promise<SendResult> {
  const key = config.mail.resendKey;
  if (!key) throw new Error('no RESEND_API_KEY');

  const from = config.gmail.fromEmail;
  if (!isEmail(from)) throw new Error('sender address is empty or malformed');

  const messageId = newMessageId(senderDomain(from));

  /*
   * Threading is carried by headers alone. Resend has no thread object, so a
   * follow up is held together the way plain SMTP holds it together: it points
   * at the id of the letter it answers, and repeats the chain in References.
   */
  const headers: Record<string, string> = { 'Message-Id': messageId };
  if (input.inReplyTo) headers['In-Reply-To'] = input.inReplyTo;
  if (input.references?.length) headers.References = input.references.join(' ');

  const response = await fetcher(API, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: config.gmail.fromName ? `${config.gmail.fromName} <${from}>` : from,
      to: input.to,
      subject: stripEmDash(input.subject),
      text: stripEmDash(input.body),
      headers,
    }),
  });

  const data = (await response.json().catch(() => ({}))) as {
    id?: string;
    message?: string;
    name?: string;
  };

  if (!response.ok || !data.id) {
    throw new Error(explainResendError(data.message ?? data.name, response.status));
  }

  log.info({ to: input.to, messageId: data.id }, 'letter sent through Resend');

  return {
    messageId: data.id,
    /*
     * No thread object exists here, so the letter's own id stands in for one.
     * Follow ups do not read this field, they read rfcMessageId, but leaving it
     * empty would make the history look like the send half failed.
     */
    threadId: data.id,
    rfcMessageId: messageId,
  };
}

/**
 * Resend errors are short and machine shaped. The two that actually happen mean
 * one concrete action each, and saying it beats printing the raw name.
 */
export function explainResendError(message: string | undefined, status: number): string {
  const text = message ?? `status ${status}`;

  if (status === 401 || /api[_ ]?key/i.test(text)) {
    return 'Resend rejected the API key: check RESEND_API_KEY';
  }
  if (/domain|not verified/i.test(text)) {
    return 'the sender domain is not verified in Resend: add and verify it, then send again';
  }
  if (status === 429 || /rate/i.test(text)) {
    return 'Resend is rate limiting, try again in a few minutes';
  }
  return `Resend did not accept the letter: ${text}`;
}
