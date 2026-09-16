import { config } from '../config.js';
import { isConfigured as gmailConfigured, gmailStatus, sendMessage as sendViaGmail } from './gmail.js';
import { resendStatus, sendViaResend } from './resend.js';
import type { SendInput, SendResult } from './gmail.js';

/**
 * Who actually puts the letter on the wire.
 *
 * Gmail was the only option for a long time and it is still the best one for a
 * person writing from their own mailbox: it threads properly and it can read the
 * inbox, which is how replies are detected at all. It is also the hardest part of
 * the setup, it needs a Google Cloud project, and it cannot run on a worker,
 * because the refresh token is a file on disk.
 *
 * So sending is a small interface with more than one implementation behind it.
 * The pipeline keeps calling one function, every guard in `send-guards.ts` stays
 * exactly where it is, and the choice becomes one environment variable.
 *
 * The important asymmetry, and the reason `readsReplies` exists: an API sender
 * only sends. It has no inbox to look at, so reply detection and bounce handling
 * simply do not happen there. That has to be said out loud in the interface
 * rather than discovered when a reply never shows up.
 */

export type MailerId = 'gmail' | 'resend';

export interface MailerStatus {
  id: MailerId;
  connected: boolean;
  fromEmail: string | null;
  /** Whether this provider can look at the mailbox and notice answers. */
  readsReplies: boolean;
  /** What to do when `connected` is false. Null when everything is fine. */
  hint: string | null;
}

export interface Mailer {
  id: MailerId;
  readsReplies: boolean;
  isConfigured(): boolean;
  status(): MailerStatus;
  send(input: SendInput): Promise<SendResult>;
}

const gmail: Mailer = {
  id: 'gmail',
  readsReplies: true,
  isConfigured: gmailConfigured,
  status() {
    const state = gmailStatus();
    return {
      id: 'gmail',
      connected: state.connected,
      fromEmail: state.fromEmail ?? state.email,
      readsReplies: true,
      hint: state.hint,
    };
  },
  send: sendViaGmail,
};

const resend: Mailer = {
  id: 'resend',
  /*
   * Resend sends and nothing else. Replies land in whatever mailbox the From
   * address belongs to, and the radar has no way in there, so follow up
   * reminders keep working while "did they answer" becomes a manual question.
   */
  readsReplies: false,
  isConfigured: () => Boolean(config.mail.resendKey && config.gmail.fromEmail),
  status: resendStatus,
  send: sendViaResend,
};

const MAILERS: Record<MailerId, Mailer> = { gmail, resend };

export function mailer(): Mailer {
  return MAILERS[config.mail.provider];
}

/** Every provider, for the settings screen. */
export function mailerStatuses(): MailerStatus[] {
  return Object.values(MAILERS).map((item) => item.status());
}

/**
 * Send through whichever provider is configured.
 *
 * `src/pipeline/send.ts` calls this and nothing else, so adding a provider never
 * touches the sending rules: the daily ceiling, the gap between letters, the
 * quiet hours and the bounce ratio all sit in front of this call.
 */
export async function deliver(input: SendInput): Promise<SendResult> {
  return mailer().send(input);
}
