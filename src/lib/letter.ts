/**
 * Filling values into a letter template.
 *
 * There is **no text generation** here: the owner writes the letter, and this function only fills
 * in the company name, the contact name and the rest. CLAUDE.md section 7 forbids model-written
 * letters, and this file has no model calls and never will.
 *
 * The file lives in `src/lib` rather than the front end so that the shared tests and typecheck
 * cover it, and so the same logic is available to the server. That is why it must stay free of
 * Node dependencies.
 */

export interface LetterContext {
  company: string;
  domain: string;
  contactName?: string | null;
  /** The segment, `companies.kind`: studio | design | startup | smb | ecommerce | ... */
  kind?: string | null;
  industry?: string | null;
  stack?: string[];
  city?: string | null;
  country?: string | null;
  /**
   * The letter language, uk or en. It decides which words `{{niche}}` expands to: a Ukrainian
   * label inside an English letter reads as a glitch. Defaults to en.
   */
  language?: string | null;
  /** One concrete issue from the site audit: "loads 9 s on a phone". The reason to write. */
  finding?: string | null;
  /** The open lead the letter answers: a tender or a public request. */
  leadTitle?: string | null;
  /**
   * The signature. Kept apart from the template text because it is the same in every letter, and
   * editing it in ten templates one by one means they drift apart sooner or later.
   */
  signature?: string | null;
}

/** Hints for the template editor: the owner has to see what can be inserted at all. */
export const LETTER_PLACEHOLDERS: { token: string; hint: string }[] = [
  { token: 'company', hint: 'company name' },
  { token: 'domain', hint: 'domain, e.g. acme.com' },
  { token: 'site', hint: 'site address, https://acme.com' },
  { token: 'contact_name', hint: 'contact name, if found' },
  { token: 'first_name', hint: 'only the first word of the name' },
  { token: 'niche', hint: 'studio, startup, business..., in the letter language' },
  { token: 'industry', hint: 'industry: dental, legal, saas...' },
  { token: 'their_stack', hint: 'stack from their site, comma separated' },
  { token: 'finding', hint: 'one issue from the site audit' },
  { token: 'lead_title', hint: 'title of the open lead: a tender, a request' },
  { token: 'city', hint: 'company city' },
  { token: 'country', hint: 'company country' },
  { token: 'signature', hint: 'the signature shared by all letters' },
];

/** Placeholder syntax, shown in the editor: a fallback after a bar is used when the value is empty. */
export const FALLBACK_HINT = '{{first_name|колеги}}: the text after | is used when there is no value';

const NICHE_LABELS: Record<'en' | 'uk', Record<string, string>> = {
  en: {
    studio: 'a development studio',
    design: 'a design studio',
    startup: 'a startup',
    product: 'a product company',
    outstaff: 'an outstaffing company',
    smb: 'a business',
    ecommerce: 'an online store',
    public: 'an organisation',
  },
  // Ukrainian letters get Ukrainian words: this is letter content, not interface copy.
  uk: {
    studio: 'студія',
    design: 'дизайн-студія',
    startup: 'стартап',
    product: 'продуктова компанія',
    outstaff: 'аутстаф-компанія',
    smb: 'бізнес',
    ecommerce: 'інтернет-магазин',
    public: 'організація',
  },
};

export interface RenderedLetter {
  text: string;
  /** Placeholders that got no value and have no fallback. The interface has to highlight them. */
  missing: string[];
  /** Tokens missing from the supported list. Most often a typo. */
  unknown: string[];
}

/**
 * Fills a template. There is no text generation here: the owner writes the letter, this only
 * puts in values.
 *
 * `{{token}}` with no value is replaced by an empty string and reported in `missing`, so a draft
 * saying "Hi ," is blocked before it exists. `{{token|fallback}}` uses the fallback instead and
 * is never missing: `{{first_name|колеги}}` gives "колеги" for a shared mailbox, and
 * `{{finding|}}` makes a sentence optional.
 */
export function renderLetter(template: string, context: LetterContext): RenderedLetter {
  const language = context.language === 'uk' ? 'uk' : 'en';
  const values: Record<string, string> = {
    company: context.company ?? '',
    domain: context.domain ?? '',
    site: context.domain ? `https://${context.domain}` : '',
    contact_name: context.contactName ?? '',
    first_name: (context.contactName ?? '').trim().split(/\s+/)[0] ?? '',
    niche: context.kind ? (NICHE_LABELS[language][context.kind] ?? '') : '',
    industry: context.industry ?? '',
    their_stack: (context.stack ?? []).join(', '),
    finding: context.finding ?? '',
    lead_title: context.leadTitle ?? '',
    city: context.city ?? '',
    country: context.country ?? '',
    signature: context.signature ?? '',
  };

  const missing = new Set<string>();
  const unknown = new Set<string>();
  const text = template.replace(TOKEN, (_match, rawToken: string, fallback: string | undefined) => {
    const token = rawToken.toLowerCase();
    if (!(token in values)) {
      unknown.add(token);
      return '';
    }
    const value = values[token]!;
    if (value) return value;
    if (fallback !== undefined) return fallback.trim();
    missing.add(token);
    return '';
  });

  return {
    // Substituting an empty value leaves double spaces and dangling commas.
    text: text.replace(/[ \t]{2,}/g, ' ').replace(/ ,/g, ',').replace(/\n{3,}/g, '\n\n').trim(),
    missing: [...missing],
    unknown: [...unknown],
  };
}

/** `{{ token }}` or `{{ token | fallback text }}`. The fallback cannot contain a closing brace. */
export const TOKEN = /\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/gi;

/** A `mailto:` link with subject and body. An empty address means the button is disabled. */
export function mailtoLink(email: string | null, subject: string, body: string): string | null {
  if (!email) return null;
  const params = new URLSearchParams();
  if (subject) params.set('subject', subject);
  if (body) params.set('body', body);
  // URLSearchParams encodes a space as +, while mail clients expect %20.
  return `mailto:${email}?${params.toString().replace(/\+/g, '%20')}`;
}
