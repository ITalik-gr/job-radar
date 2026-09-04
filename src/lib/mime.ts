/**
 * Складання листа у форматі RFC 2822 і кодування під `users.messages.send`.
 *
 * Винесено окремим файлом без залежностей від Node і від бази: це чиста функція
 * з тестами, і саме тут ховається найтихіший баг усього модуля. Некоректно
 * закодований український лист виглядає нормально у відправника, у логах і в базі,
 * а одержувач бачить кракозябри в темі. Тому кодування тут явне і перевірене
 * тестом, а не залишене на замовчування бібліотеки.
 */

export interface MimeMessage {
  fromName: string;
  fromEmail: string;
  to: string;
  subject: string;
  body: string;
  /** Message-Id листа, на який відповідаємо. Порожнє означає новий лист. */
  inReplyTo?: string | null;
  /** Ланцюжок Message-Id від початку треду, включно з `inReplyTo`. */
  references?: string[];
}

const CRLF = '\r\n';

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** base64url без вирівнювання: саме цього чекає Gmail API в полі `raw`. */
export function base64Url(value: string): string {
  return base64(utf8(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

const ASCII_ONLY = /^[\x20-\x7e]*$/;

/**
 * Заголовок з кирилицею кодується в encoded-word, RFC 2047. Латиниця лишається
 * як є: зайве кодування теми теж працює, але робить її нечитабельною в логах
 * і в деяких старих клієнтах.
 */
export function encodeHeader(value: string): string {
  if (ASCII_ONLY.test(value)) return value;
  return `=?UTF-8?B?${base64(utf8(value))}?=`;
}

/**
 * Імʼя перед адресою. Кирилиця йде в encoded-word, а латиниця зі спецсимволом
 * береться в лапки: кома в незакритому імені розриває заголовок на дві адреси,
 * і лист або не доходить, або доходить не туди.
 */
const HEADER_SPECIALS = /[(),.:;<>@\[\]\\"]/;

export function formatAddress(name: string, email: string): string {
  if (!name) return email;
  if (!ASCII_ONLY.test(name)) return `${encodeHeader(name)} <${email}>`;
  const display = HEADER_SPECIALS.test(name)
    ? `"${name.replace(/([\\"])/g, '\\$1')}"`
    : name;
  return `${display} <${email}>`;
}

/** Тіло переноситься в base64 рядками по 76 символів, як вимагає RFC 2045. */
function base64Body(value: string): string {
  const encoded = base64(utf8(value.replace(/\r?\n/g, CRLF)));
  return (encoded.match(/.{1,76}/g) ?? []).join(CRLF);
}

/**
 * Тільки `text/plain`. HTML-лист від незнайомця фільтрується жорсткіше, і це
 * рішення з OUTREACH.md, а не спрощення реалізації.
 */
export function buildMime(message: MimeMessage): string {
  const headers: string[] = [
    `From: ${formatAddress(message.fromName, message.fromEmail)}`,
    `To: ${message.to}`,
    `Reply-To: ${message.fromEmail}`,
    `Subject: ${encodeHeader(message.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];

  /*
   * Фолоу-ап без цих двох заголовків приходить окремим листом. Формально він
   * доставлений, але виглядає як друга розсилка тій самій людині, а не як
   * продовження розмови, і читається саме так.
   */
  if (message.inReplyTo) headers.push(`In-Reply-To: ${message.inReplyTo}`);
  const references = message.references?.filter(Boolean) ?? [];
  if (references.length > 0) headers.push(`References: ${references.join(' ')}`);

  return `${headers.join(CRLF)}${CRLF}${CRLF}${base64Body(message.body)}${CRLF}`;
}

/** Готовий лист у вигляді, який приймає Gmail API. */
export function encodeMessage(message: MimeMessage): string {
  return base64Url(buildMime(message));
}
