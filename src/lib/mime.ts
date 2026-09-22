/**
 * Building a letter in RFC 2822 format and encoding it for `users.messages.send`.
 *
 * Pulled out into its own file with no dependency on Node or the database: it is a
 * pure function with tests, and this is exactly where the quietest bug in the whole
 * module hides. An incorrectly encoded Ukrainian letter looks fine to the sender, in
 * the logs, and in the database, while the recipient sees garbled characters in the
 * subject. So the encoding here is explicit and covered by a test, not left to a
 * library's default.
 */

export interface MimeMessage {
  fromName: string;
  fromEmail: string;
  to: string;
  subject: string;
  body: string;
  /** The Message-Id of the letter being replied to. Empty means a new letter. */
  inReplyTo?: string | null;
  /** The chain of Message-Ids from the start of the thread, including `inReplyTo`. */
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

/** base64url without padding: exactly what the Gmail API expects in the `raw` field. */
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
 * A header with Cyrillic gets encoded as an encoded-word, RFC 2047. Latin text is
 * left as is: encoding the subject unnecessarily also works, but makes it unreadable
 * in logs and in some older clients.
 */
export function encodeHeader(value: string): string {
  if (ASCII_ONLY.test(value)) return value;
  return `=?UTF-8?B?${base64(utf8(value))}?=`;
}

/**
 * The name before the address. Cyrillic goes into an encoded-word, and Latin text
 * with a special character gets quoted: a comma in an unquoted name splits the
 * header into two addresses, and the letter either does not arrive or arrives at
 * the wrong place.
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

/** The body is wrapped in base64 lines of 76 characters, as required by RFC 2045. */
function base64Body(value: string): string {
  const encoded = base64(utf8(value.replace(/\r?\n/g, CRLF)));
  return (encoded.match(/.{1,76}/g) ?? []).join(CRLF);
}

/**
 * Only `text/plain`. An HTML letter from a stranger gets filtered more aggressively,
 * and this is a decision from OUTREACH.md, not an implementation shortcut.
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
   * A follow-up without these two headers arrives as a separate letter. Formally it
   * is delivered, but it looks like a second blast to the same person rather than a
   * continuation of the conversation, and that is exactly how it reads.
   */
  if (message.inReplyTo) headers.push(`In-Reply-To: ${message.inReplyTo}`);
  const references = message.references?.filter(Boolean) ?? [];
  if (references.length > 0) headers.push(`References: ${references.join(' ')}`);

  return `${headers.join(CRLF)}${CRLF}${CRLF}${base64Body(message.body)}${CRLF}`;
}

/** The finished letter in the form the Gmail API accepts. */
export function encodeMessage(message: MimeMessage): string {
  return base64Url(buildMime(message));
}
