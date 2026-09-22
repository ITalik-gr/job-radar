import { describe, expect, it } from 'vitest';
import {
  base64Url,
  buildMime,
  encodeHeader,
  encodeMessage,
  formatAddress,
  fromBase64Url,
} from '../src/lib/mime.js';
import { explainSendError, stripEmDash } from '../src/lib/gmail.js';

/**
 * The Cyrillic test is mandatory here, section 11 of OUTREACH.md. Broken encoding of a Ukrainian
 * letter is a silent bug: in the database, in the logs and for the sender the text is right, and
 * only the recipient sees garbage. The Ukrainian fixtures below are therefore deliberate.
 */

const base = {
  fromName: 'Olena Koval',
  fromEmail: 'olena@example.com',
  to: 'anton@acme.com',
  subject: 'Frontend для Acme',
  body: 'Вітаю, Антоне.\n\nПишу щодо вакансії.\n\nOlena',
};

/** The letter body sits in base64 after the blank line that separates the headers. */
function decodeBody(raw: string): string {
  const [, ...rest] = raw.split('\r\n\r\n');
  const encoded = rest.join('\r\n\r\n').replace(/\r\n/g, '');
  return fromBase64Url(encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
}

function headerLine(raw: string, name: string): string | undefined {
  return raw
    .split('\r\n')
    .find((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`));
}

describe('header encoding', () => {
  it('Latin text stays readable', () => {
    expect(encodeHeader('Front-end for Acme')).toBe('Front-end for Acme');
  });

  it('Cyrillic goes into an encoded-word', () => {
    const encoded = encodeHeader('Привіт');
    expect(encoded.startsWith('=?UTF-8?B?')).toBe(true);
    expect(fromBase64Url(base64Url('Привіт'))).toBe('Привіт');
  });

  it('a name with a comma is quoted, otherwise the comma splits the address', () => {
    expect(formatAddress('Koval, Olena', 'a@b.com')).toBe('"Koval, Olena" <a@b.com>');
  });

  it('Cyrillic in a name goes into an encoded-word', () => {
    expect(formatAddress('Олена Коваль', 'a@b.com')).toContain('=?UTF-8?B?');
  });

  it('an empty name gives a bare address without angle brackets', () => {
    expect(formatAddress('', 'a@b.com')).toBe('a@b.com');
  });
});

describe('RFC 2822 letter with Cyrillic', () => {
  const raw = buildMime(base);

  it('the subject is encoded and decodes back to the same text', () => {
    const line = headerLine(raw, 'Subject')!;
    const encoded = line.slice('Subject: =?UTF-8?B?'.length, -2);
    expect(fromBase64Url(encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))).toBe(
      'Frontend для Acme',
    );
  });

  it('the body decodes character for character as it was built', () => {
    expect(decodeBody(raw)).toBe(base.body.replace(/\n/g, '\r\n'));
  });

  it('declares utf-8 and base64, otherwise the client guesses the encoding', () => {
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(raw).toContain('Content-Transfer-Encoding: base64');
  });

  it('text/plain only: html from a stranger is filtered more harshly', () => {
    expect(raw).not.toContain('text/html');
    expect(raw).not.toContain('multipart');
  });

  it('From with a name and Reply-To to the same address', () => {
    expect(headerLine(raw, 'From')).toBe('From: Olena Koval <olena@example.com>');
    expect(headerLine(raw, 'Reply-To')).toBe('Reply-To: olena@example.com');
  });

  it('base64 lines are no longer than 76 characters, as RFC 2045 requires', () => {
    const long = buildMime({ ...base, body: 'Дуже довгий український рядок. '.repeat(40) });
    const lines = long.split('\r\n\r\n').slice(1).join('').split('\r\n');
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(76);
  });

  it('raw for the API is base64url without padding', () => {
    const encoded = encodeMessage(base);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(fromBase64Url(encoded)).toBe(raw);
  });
});

describe('follow-up threading', () => {
  it('a new letter has neither In-Reply-To nor References', () => {
    const raw = buildMime(base);
    expect(headerLine(raw, 'In-Reply-To')).toBeUndefined();
    expect(headerLine(raw, 'References')).toBeUndefined();
  });

  it('a follow-up references the original with both headers', () => {
    const raw = buildMime({
      ...base,
      inReplyTo: '<abc@mail.gmail.com>',
      references: ['<abc@mail.gmail.com>'],
    });
    expect(headerLine(raw, 'In-Reply-To')).toBe('In-Reply-To: <abc@mail.gmail.com>');
    expect(headerLine(raw, 'References')).toBe('References: <abc@mail.gmail.com>');
  });

  it('References holds the whole chain separated by spaces', () => {
    const raw = buildMime({
      ...base,
      inReplyTo: '<second@mail.gmail.com>',
      references: ['<first@mail.gmail.com>', '<second@mail.gmail.com>'],
    });
    expect(headerLine(raw, 'References')).toBe(
      'References: <first@mail.gmail.com> <second@mail.gmail.com>',
    );
  });

  it('empty values in the chain leave no extra spaces', () => {
    const raw = buildMime({ ...base, references: ['<a@b>', ''] });
    expect(headerLine(raw, 'References')).toBe('References: <a@b>');
  });
});

describe('send errors', () => {
  it('a disabled Gmail API is explained with one action', () => {
    const raw =
      'Gmail API has not been used in project 8312224703 before or it is disabled. Enable it by visiting https://console.developers.google.com/...';
    expect(explainSendError(raw, 403)).toContain('Enable it in Google Cloud Console');
  });

  it('an expired token leads to reconnecting', () => {
    expect(explainSendError('invalid_grant', 401)).toContain('reconnect mail');
  });

  it('an unfamiliar error is passed on as is, without an invented explanation', () => {
    expect(explainSendError('something odd', 500)).toContain('something odd');
  });
});

describe('em dash on the way out', () => {
  it('is stripped before sending, the last line of defence', () => {
    expect(stripEmDash('Ми робимо сайти — і магазини')).toBe('Ми робимо сайти, і магазини');
  });

  it('text without one is unchanged', () => {
    expect(stripEmDash('Ми робимо сайти, і магазини')).toBe('Ми робимо сайти, і магазини');
  });
});
