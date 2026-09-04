/**
 * Підстановка значень у шаблон листа.
 *
 * Тут **немає генерації тексту**: лист пише власник, а ця функція лише підставляє
 * назву компанії, імʼя контакту і стек. Розділ 11 у CLAUDE.md забороняє генерувати
 * листи, і звернень до моделі в цьому файлі немає і не буде.
 *
 * Файл лежить у `src/lib`, а не у фронті, щоб його покривали загальні тести
 * і типчек, і щоб та сама логіка була доступна серверу, якщо колись знадобиться.
 * Через це він мусить лишатись без залежностей від Node.
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
   * Перший абзац листа: або від моделі, або статичний з шаблона. Приходить сюди
   * готовим рядком, бо рішення, чий саме це текст, приймається до підстановки.
   */
  intro?: string | null;
}

/** Підписи для редактора шаблонів: власник має бачити, що взагалі можна вставити. */
export const LETTER_PLACEHOLDERS: { token: string; hint: string }[] = [
  { token: 'company', hint: 'назва компанії' },
  { token: 'domain', hint: 'домен, напр. acme.com' },
  { token: 'contact_name', hint: 'імʼя контакту, якщо знайшли' },
  { token: 'first_name', hint: 'тільки перше слово з імені' },
  { token: 'niche', hint: 'студія, дизайн-студія, стартап' },
  { token: 'their_stack', hint: 'стек із їхнього сайту, через кому' },
  { token: 'vacancy_title', hint: 'назва вакансії, якщо лист із Черги' },
  { token: 'intro', hint: 'перший абзац: від моделі або статичний з шаблона' },
  { token: 'city', hint: 'місто компанії' },
  { token: 'country', hint: 'країна компанії' },
];

const NICHE_LABELS: Record<string, string> = {
  studio: 'студія',
  design: 'дизайн-студія',
  startup: 'стартап',
  product: 'продуктова компанія',
  outstaff: 'аутстаф-компанія',
};

export interface RenderedLetter {
  text: string;
  /** Плейсхолдери, для яких не знайшлось значення. Інтерфейс має їх підсвітити. */
  missing: string[];
  /** Токени, яких немає в переліку підтримуваних. Найчастіше це друкарська помилка. */
  unknown: string[];
}

/**
 * Порожній плейсхолдер замінюється на порожній рядок, а не лишається як `{{...}}`.
 * Причина проста: власник копіює текст і вставляє в пошту, і фігурні дужки в листі
 * виглядають як недбалість. Але список порожніх повертається, щоб інтерфейс
 * попередив до того, як лист піде.
 */
export function renderLetter(template: string, context: LetterContext): RenderedLetter {
  const values: Record<string, string> = {
    company: context.company ?? '',
    domain: context.domain ?? '',
    contact_name: context.contactName ?? '',
    first_name: (context.contactName ?? '').split(' ')[0] ?? '',
    niche: context.kind ? (NICHE_LABELS[context.kind] ?? '') : '',
    their_stack: (context.stack ?? []).join(', '),
    vacancy_title: context.vacancyTitle ?? '',
    intro: context.intro ?? '',
    city: context.city ?? '',
    country: context.country ?? '',
  };

  const missing = new Set<string>();
  const unknown = new Set<string>();

  const text = template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_match, rawToken: string) => {
    const token = rawToken.toLowerCase();
    if (!(token in values)) {
      unknown.add(token);
      return '';
    }
    const value = values[token]!;
    if (!value) missing.add(token);
    return value;
  });

  return {
    // Підстановка порожнього значення лишає подвійні пробіли і висячі коми.
    text: text.replace(/[ \t]{2,}/g, ' ').replace(/ ,/g, ',').replace(/\n{3,}/g, '\n\n').trim(),
    missing: [...missing],
    unknown: [...unknown],
  };
}

/** Посилання `mailto:` з темою і тілом. Порожня адреса означає, що кнопка неактивна. */
export function mailtoLink(email: string | null, subject: string, body: string): string | null {
  if (!email) return null;
  const params = new URLSearchParams();
  if (subject) params.set('subject', subject);
  if (body) params.set('body', body);
  // URLSearchParams кодує пробіл як +, а поштові клієнти чекають %20.
  return `mailto:${email}?${params.toString().replace(/\+/g, '%20')}`;
}
