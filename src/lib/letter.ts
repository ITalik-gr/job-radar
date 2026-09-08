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
  /**
   * Підпис. Лежить окремо від тексту шаблона, бо він однаковий у всіх листах,
   * а правити його в десяти шаблонах по черзі означає рано чи пізно розійтись
   * у них між собою.
   */
  signature?: string | null;
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
  { token: 'signature', hint: 'підпис, спільний для всіх листів' },
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
  const base: Record<string, string> = {
    company: context.company ?? '',
    domain: context.domain ?? '',
    contact_name: context.contactName ?? '',
    first_name: (context.contactName ?? '').split(' ')[0] ?? '',
    niche: context.kind ? (NICHE_LABELS[context.kind] ?? '') : '',
    their_stack: (context.stack ?? []).join(', '),
    vacancy_title: context.vacancyTitle ?? '',
    city: context.city ?? '',
    country: context.country ?? '',
    signature: context.signature ?? '',
  };

  /*
   * Перший абзац підставляється не як готовий рядок, а сам проходить підстановку.
   * Інакше `{{company}}`, написаний у полі "Перший абзац", доїжджав би до пошти
   * фігурними дужками: заміна робиться за один прохід і вставлений текст повторно
   * не переглядається.
   *
   * Токена `intro` всередині самого абзацу немає навмисно: він потрапить у
   * `unknown` і власник побачить попередження замість тихої рекурсії.
   */
  const introMissing = new Set<string>();
  const introUnknown = new Set<string>();
  const intro = substitute(context.intro ?? '', base, introMissing, introUnknown);

  const values: Record<string, string> = { ...base, intro };

  const missing = new Set<string>();
  const unknown = new Set<string>();
  const text = substitute(template, values, missing, unknown);

  /*
   * Претензії до абзацу зараховуються лише тоді, коли шаблон його справді бере.
   * Абзац, написаний "про запас" для шаблона без мітки, не має блокувати лист.
   */
  if (HAS_INTRO.test(template)) {
    for (const token of introMissing) missing.add(token);
    for (const token of introUnknown) unknown.add(token);
  }

  return {
    // Підстановка порожнього значення лишає подвійні пробіли і висячі коми.
    text: text.replace(/[ \t]{2,}/g, ' ').replace(/ ,/g, ',').replace(/\n{3,}/g, '\n\n').trim(),
    missing: [...missing],
    unknown: [...unknown],
  };
}

const TOKEN = /\{\{\s*([a-z_]+)\s*\}\}/gi;

/** Чи бере шаблон перший абзац узагалі. Без цього абзац перевіряється даремно. */
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

/** Посилання `mailto:` з темою і тілом. Порожня адреса означає, що кнопка неактивна. */
export function mailtoLink(email: string | null, subject: string, body: string): string | null {
  if (!email) return null;
  const params = new URLSearchParams();
  if (subject) params.set('subject', subject);
  if (body) params.set('body', body);
  // URLSearchParams кодує пробіл як +, а поштові клієнти чекають %20.
  return `mailto:${email}?${params.toString().replace(/\+/g, '%20')}`;
}
