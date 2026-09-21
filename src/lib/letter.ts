/**
 * Filling values into a letter template.
 *
 * There is **no text generation** here: the owner writes the letter, and this function only fills
 * in the company name, the contact name and the stack. Section 11 of CLAUDE.md forbids generating
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
  /** studio | design | startup | product | outstaff */
  kind?: string | null;
  stack?: string[];
  vacancyTitle?: string | null;
  city?: string | null;
  country?: string | null;
  /**
   * The letter language, uk or en. It decides which words `{{niche}}` expands to: a Ukrainian
   * label inside an English letter reads as a glitch. Defaults to en.
   */
  language?: string | null;
  /**
   * The first paragraph of the letter: either from the model or static from the template. It
   * arrives as a ready string, because who wrote it is decided before substitution.
   */
  intro?: string | null;
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
  { token: 'contact_name', hint: 'contact name, if found' },
  { token: 'first_name', hint: 'only the first word of the name' },
  { token: 'niche', hint: 'studio, design studio, startup, in the letter language' },
  { token: 'their_stack', hint: 'stack from their site, comma separated' },
  { token: 'vacancy_title', hint: 'vacancy title, if the letter comes from the Queue' },
  { token: 'intro', hint: 'first paragraph: from the model or static from the template' },
  { token: 'signature', hint: 'the signature shared by all letters' },
  { token: 'city', hint: 'company city' },
  { token: 'country', hint: 'company country' },
];

const NICHE_LABELS: Record<'en' | 'uk', Record<string, string>> = {
  en: {
    studio: 'a development studio',
    design: 'a design studio',
    startup: 'a startup',
    product: 'a product company',
    outstaff: 'an outstaffing company',
  },
  // Ukrainian letters get Ukrainian words: this is letter content, not interface copy.
  uk: {
    studio: 'студія',
    design: 'дизайн-студія',
    startup: 'стартап',
    product: 'продуктова компанія',
    outstaff: 'аутстаф-компанія',
  },
};

export interface RenderedLetter {
  text: string;
  /** Placeholders that got no value. The interface has to highlight them. */
  missing: string[];
  /** Tokens missing from the supported list. Most often a typo. */
  unknown: string[];
}

/**
 * An empty placeholder is replaced with an empty string rather than left as `{{...}}`. The reason
 * is simple: the owner copies the text into a mail client, and curly braces in a letter look
 * careless. But the list of empty ones is returned, so the interface can warn before the letter goes.
 */
export function renderLetter(template: string, context: LetterContext): RenderedLetter {
  const base: Record<string, string> = {
    company: context.company ?? '',
    domain: context.domain ?? '',
    contact_name: context.contactName ?? '',
    first_name: (context.contactName ?? '').split(' ')[0] ?? '',
    niche: context.kind ? (NICHE_LABELS[context.language === 'uk' ? 'uk' : 'en'][context.kind] ?? '') : '',
    their_stack: (context.stack ?? []).join(', '),
    vacancy_title: context.vacancyTitle ?? '',
    city: context.city ?? '',
    country: context.country ?? '',
    signature: context.signature ?? '',
  };

  /*
   * The first paragraph is not inserted as a ready string, it goes through substitution itself.
   * Otherwise `{{company}}` written in the "First paragraph" field would reach the mail as curly
   * braces: replacement is a single pass, and inserted text is not scanned again.
   *
   * The `intro` token inside the paragraph itself is left out on purpose: it lands in `unknown`,
   * and the owner sees a warning instead of silent recursion.
   */
  const introMissing = new Set<string>();
  const introUnknown = new Set<string>();
  const intro = substitute(context.intro ?? '', base, introMissing, introUnknown);

  const values: Record<string, string> = { ...base, intro };

  const missing = new Set<string>();
  const unknown = new Set<string>();
  const text = substitute(template, values, missing, unknown);

  /*
   * Paragraph complaints count only when the template actually uses it. A paragraph written
   * "just in case" for a template without the marker must not block the letter.
   */
  if (HAS_INTRO.test(template)) {
    for (const token of introMissing) missing.add(token);
    for (const token of introUnknown) unknown.add(token);
  }

  return {
    // Substituting an empty value leaves double spaces and dangling commas.
    text: text.replace(/[ \t]{2,}/g, ' ').replace(/ ,/g, ',').replace(/\n{3,}/g, '\n\n').trim(),
    missing: [...missing],
    unknown: [...unknown],
  };
}

const TOKEN = /\{\{\s*([a-z_]+)\s*\}\}/gi;

/** Whether the template uses the first paragraph at all. Without it the paragraph is checked for nothing. */
export const HAS_INTRO = /\{\{\s*intro\s*\}\}/i;

function substitute(
  template: string,
  values: Record<string, string>,
  missing: Set<string>,
  unknown: Set<string>,
): string {
  return template.replace(TOKEN, (_match, rawToken: string) => {
    const token = rawToken.toLowerCase();
    if (!(token in values)) {
      unknown.add(token);
      return '';
    }
    const value = values[token]!;
    if (!value) missing.add(token);
    return value;
  });
}

/** A `mailto:` link with subject and body. An empty address means the button is disabled. */
export function mailtoLink(email: string | null, subject: string, body: string): string | null {
  if (!email) return null;
  const params = new URLSearchParams();
  if (subject) params.set('subject', subject);
  if (body) params.set('body', body);
  // URLSearchParams encodes a space as +, while mail clients expect %20.
  return `mailto:${email}?${params.toString().replace(/\+/g, '%20')}`;
}
