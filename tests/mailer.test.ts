import { afterEach, describe, expect, it, vi } from 'vitest';
import { setRuntimeEnv } from '../src/config.js';
import { newMessageId, explainResendError, sendViaResend } from '../src/lib/resend.js';
import { mailer, mailerStatuses } from '../src/lib/mailer.js';

/**
 * Sending through a provider that is not Gmail.
 *
 * What is worth testing here is the request shape, not the network. Threading is
 * the fragile part: Resend has no thread object, so a follow up holds together
 * only if the headers carry the right ids. Get that wrong and the follow up still
 * sends, still looks fine in the history, and lands as a second cold email in the
 * recipient's inbox.
 */

/*
 * Config reads a snapshot taken at import time, because on a worker the values
 * arrive as bindings after the modules load. setRuntimeEnv is the supported way
 * in, and an empty string reads as unset, which is how these tests clean up.
 */
function env(values: Record<string, string>) {
  setRuntimeEnv(values);
}

afterEach(() => {
  env({ RESEND_API_KEY: '', GMAIL_FROM_EMAIL: '', GMAIL_FROM_NAME: '', MAIL_PROVIDER: '' });
});

function configured() {
  env({ RESEND_API_KEY: 're_test_key', GMAIL_FROM_EMAIL: 'me@studio.com', GMAIL_FROM_NAME: 'Me' });
}

function ok(body: unknown) {
  // Typed on purpose: otherwise mock.calls is an empty tuple and the body is unreachable.
  return vi.fn(async (_url: string, init: RequestInit) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }),
  );
}

/** The request body the provider actually sent. */
function sentBody(fetcher: ReturnType<typeof ok>): Record<string, any> {
  return JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
}

describe('Message-Id', () => {
  /*
   * We generate it ourselves because Resend answers with its own id, which is
   * not the RFC header. Without a known header value a follow up has nothing to
   * point at.
   */
  it('is built from the sender domain and wrapped in angle brackets', () => {
    expect(newMessageId('studio.com', 'abc')).toBe('<abc@studio.com>');
  });
});

describe('sending through Resend', () => {
  it('sends the letter and reports the id it can thread on later', async () => {
    configured();
    const fetcher = ok({ id: 'resend-1' });

    const result = await sendViaResend({ to: 'her@acme.com', subject: 'Hi', body: 'Text' }, fetcher);

    expect(result.messageId).toBe('resend-1');
    expect(result.rfcMessageId).toMatch(/^<.+@studio\.com>$/);

    const body = sentBody(fetcher);
    expect(body.from).toBe('Me <me@studio.com>');
    expect(body.to).toBe('her@acme.com');
    expect(body.headers['Message-Id']).toBe(result.rfcMessageId);
  });

  it('carries the threading headers of a follow up', async () => {
    configured();
    const fetcher = ok({ id: 'resend-2' });

    await sendViaResend(
      {
        to: 'her@acme.com',
        subject: 'Following up',
        body: 'Text',
        inReplyTo: '<first@studio.com>',
        references: ['<first@studio.com>'],
      },
      fetcher,
    );

    const body = sentBody(fetcher);
    expect(body.headers['In-Reply-To']).toBe('<first@studio.com>');
    expect(body.headers.References).toBe('<first@studio.com>');
  });

  /* Rule 1 in CLAUDE.md, checked at the last point where it can still be fixed. */
  it('strips em dash on the way out', async () => {
    configured();
    const fetcher = ok({ id: 'resend-3' });

    await sendViaResend({ to: 'her@acme.com', subject: 'A — B', body: 'one — two' }, fetcher);

    const body = sentBody(fetcher);
    expect(body.subject).not.toContain('—');
    expect(body.text).not.toContain('—');
  });

  it('refuses to send without a key or without a sender', async () => {
    env({ RESEND_API_KEY: '', GMAIL_FROM_EMAIL: 'me@studio.com' });
    await expect(sendViaResend({ to: 'a@b.com', subject: 's', body: 'b' })).rejects.toThrow(/RESEND_API_KEY/);

    env({ RESEND_API_KEY: 're_test_key', GMAIL_FROM_EMAIL: 'not-an-email' });
    await expect(sendViaResend({ to: 'a@b.com', subject: 's', body: 'b' })).rejects.toThrow(/sender/);
  });

  it('turns the common failures into one concrete action', () => {
    expect(explainResendError(undefined, 401)).toMatch(/RESEND_API_KEY/);
    expect(explainResendError('domain is not verified', 403)).toMatch(/verify/);
    expect(explainResendError(undefined, 429)).toMatch(/rate limiting/);
  });
});

describe('choosing a provider', () => {
  it('defaults to gmail and switches on the variable', () => {
    expect(mailer().id).toBe('gmail');
    env({ MAIL_PROVIDER: 'resend' });
    expect(mailer().id).toBe('resend');
  });

  /*
   * The asymmetry has to be visible: an API sender has no inbox, so replies are
   * never detected there. Silence about that reads as "nobody answered".
   */
  it('says which provider can notice replies', () => {
    const byId = Object.fromEntries(mailerStatuses().map((row) => [row.id, row]));
    expect(byId.gmail!.readsReplies).toBe(true);
    expect(byId.resend!.readsReplies).toBe(false);
  });
});
