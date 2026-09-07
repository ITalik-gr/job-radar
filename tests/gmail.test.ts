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
 * Тест на кирилицю тут обовʼязковий, розділ 11 OUTREACH.md. Некоректне кодування
 * українського листа це мовчазний баг: у базі, в логах і у відправника текст
 * правильний, кракозябри бачить тільки одержувач.
 */

const base = {
  fromName: 'Alex Example',
  fromEmail: 'italik@example.com',
  to: 'anton@acme.com',
  subject: 'Frontend для Acme',
  body: 'Вітаю, Антоне.\n\nПишу щодо вакансії.\n\nAlex',
};

/** Тіло листа лежить у base64 після порожнього рядка, який відділяє заголовки. */
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

describe('кодування заголовків', () => {
  it('латиниця лишається читабельною', () => {
    expect(encodeHeader('Front-end for Acme')).toBe('Front-end for Acme');
  });

  it('кирилиця йде в encoded-word', () => {
    const encoded = encodeHeader('Привіт');
    expect(encoded.startsWith('=?UTF-8?B?')).toBe(true);
    expect(fromBase64Url(base64Url('Привіт'))).toBe('Привіт');
  });

  it('імʼя з комою береться в лапки, інакше кома розірве адресу', () => {
    expect(formatAddress('Example, Alex', 'a@b.com')).toBe('"Example, Alex" <a@b.com>');
  });

  it('кирилиця в імені йде в encoded-word', () => {
    expect(formatAddress('Олекса Приклад', 'a@b.com')).toContain('=?UTF-8?B?');
  });

  it('порожнє імʼя дає голу адресу без кутових дужок', () => {
    expect(formatAddress('', 'a@b.com')).toBe('a@b.com');
  });
});

describe('лист RFC 2822 з кирилицею', () => {
  const raw = buildMime(base);

  it('тема закодована і розкодовується назад у той самий текст', () => {
    const line = headerLine(raw, 'Subject')!;
    const encoded = line.slice('Subject: =?UTF-8?B?'.length, -2);
    expect(fromBase64Url(encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))).toBe(
      'Frontend для Acme',
    );
  });

  it('тіло розкодовується посимвольно так само, як його склали', () => {
    expect(decodeBody(raw)).toBe(base.body.replace(/\n/g, '\r\n'));
  });

  it('оголошує utf-8 і base64, інакше клієнт вгадує кодування сам', () => {
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(raw).toContain('Content-Transfer-Encoding: base64');
  });

  it('тільки text/plain: html від незнайомця фільтрується жорсткіше', () => {
    expect(raw).not.toContain('text/html');
    expect(raw).not.toContain('multipart');
  });

  it('From з іменем і Reply-To на ту саму адресу', () => {
    expect(headerLine(raw, 'From')).toBe('From: Alex Example <italik@example.com>');
    expect(headerLine(raw, 'Reply-To')).toBe('Reply-To: italik@example.com');
  });

  it('рядки base64 не довші за 76 символів, як вимагає RFC 2045', () => {
    const long = buildMime({ ...base, body: 'Дуже довгий український рядок. '.repeat(40) });
    const lines = long.split('\r\n\r\n').slice(1).join('').split('\r\n');
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(76);
  });

  it('raw для API це base64url без вирівнювання', () => {
    const encoded = encodeMessage(base);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(fromBase64Url(encoded)).toBe(raw);
  });
});

describe('тредування фолоу-апу', () => {
  it('новий лист не має ні In-Reply-To, ні References', () => {
    const raw = buildMime(base);
    expect(headerLine(raw, 'In-Reply-To')).toBeUndefined();
    expect(headerLine(raw, 'References')).toBeUndefined();
  });

  it('фолоу-ап посилається на оригінал обома заголовками', () => {
    const raw = buildMime({
      ...base,
      inReplyTo: '<abc@mail.gmail.com>',
      references: ['<abc@mail.gmail.com>'],
    });
    expect(headerLine(raw, 'In-Reply-To')).toBe('In-Reply-To: <abc@mail.gmail.com>');
    expect(headerLine(raw, 'References')).toBe('References: <abc@mail.gmail.com>');
  });

  it('References тримає весь ланцюжок через пробіл', () => {
    const raw = buildMime({
      ...base,
      inReplyTo: '<second@mail.gmail.com>',
      references: ['<first@mail.gmail.com>', '<second@mail.gmail.com>'],
    });
    expect(headerLine(raw, 'References')).toBe(
      'References: <first@mail.gmail.com> <second@mail.gmail.com>',
    );
  });

  it('порожні значення в ланцюжку не лишають зайвих пробілів', () => {
    const raw = buildMime({ ...base, references: ['<a@b>', ''] });
    expect(headerLine(raw, 'References')).toBe('References: <a@b>');
  });
});

describe('помилки відправки', () => {
  it('вимкнений Gmail API пояснюється однією дією', () => {
    const raw =
      'Gmail API has not been used in project 8312224703 before or it is disabled. Enable it by visiting https://console.developers.google.com/...';
    expect(explainSendError(raw, 403)).toContain('Увімкнути його в Google Cloud Console');
  });

  it('протухлий токен веде до повторного підключення', () => {
    expect(explainSendError('invalid_grant', 401)).toContain('підключити пошту заново');
  });

  it('незнайома помилка віддається як є, без вигаданого пояснення', () => {
    expect(explainSendError('щось дивне', 500)).toContain('щось дивне');
  });
});

describe('em dash на виході', () => {
  it('ріжеться перед відправкою, це останній рубіж', () => {
    expect(stripEmDash('Ми робимо сайти — і магазини')).toBe('Ми робимо сайти, і магазини');
  });

  it('текст без нього не міняється', () => {
    expect(stripEmDash('Ми робимо сайти, і магазини')).toBe('Ми робимо сайти, і магазини');
  });
});
