/**
 * Перевірка, чи довантажена сторінка вакансії справді містить опис.
 *
 * Половина бордів це SPA: у HTML лежить лише навігація, а текст вакансії
 * підвантажує JS. Без цієї перевірки радар зберігав як опис вакансії список
 * пунктів меню ("startups, corporations, communities, investors"), і далі цей
 * текст ішов у модель, коштував токенів і давав безглузду класифікацію.
 *
 * Перевірка структурна, а не за словами: рахуємо, скільки в тексті звʼязної
 * прози. Меню з коротких рядків її не має за будь-якою мовою і будь-яким
 * дизайном, а опис вакансії має завжди.
 */

/**
 * Опис вакансії з `__NEXT_DATA__`.
 *
 * Борди на Getro (Techstars, Underscore і решта мереж) це Next.js: у розмітці
 * лежить хедер і футер мережі на 70 тисяч символів, а сам опис вакансії тільки
 * у вбудованому JSON. Через це радар зберігав як текст вакансії пункти меню
 * "startups, corporations, communities" і платив за їх класифікацію.
 *
 * Шукаємо не за фіксованим шляхом, а обходом: структура сторінки в них уже
 * мінялась, а поле `description` всередині обʼєкта вакансії лишалось.
 */
export function jobTextFromNextData(html: string): string | null {
  const match = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!match) return null;

  let data: unknown;
  try {
    data = JSON.parse(match[1]!);
  } catch {
    return null;
  }

  const job = findJob(data);
  if (!job) return null;

  const parts = [job.title, job.locations, job.description].filter(Boolean) as string[];
  const text = parts.join('\n');
  return text.trim() ? text : null;
}

interface JobLike {
  title?: string;
  locations?: string;
  description?: string;
}

/** Обʼєкт вакансії це той, у якого є довгий `description`. */
function findJob(node: unknown, depth = 0): JobLike | null {
  if (depth > 8 || node === null || typeof node !== 'object') return null;

  if (!Array.isArray(node)) {
    const record = node as Record<string, unknown>;
    const description = record.description;
    if (typeof description === 'string' && description.length > 200) {
      return {
        title: typeof record.title === 'string' ? record.title : undefined,
        locations: Array.isArray(record.locations)
          ? record.locations.filter((item) => typeof item === 'string').join(', ')
          : undefined,
        description,
      };
    }
  }

  for (const value of Array.isArray(node) ? node : Object.values(node as object)) {
    const found = findJob(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/** Рядок вважається прозою, якщо він схожий на речення, а не на пункт меню. */
function isProse(line: string): boolean {
  const clean = line.replace(/^[-•*\s]+/, '').trim();
  if (clean.length < 40) return false;
  const words = clean.split(/\s+/).length;
  return words >= 8;
}

export function proseChars(text: string): number {
  return text
    .split('\n')
    .filter(isProse)
    .reduce((sum, line) => sum + line.trim().length, 0);
}

/**
 * Мінімум прози, після якого текст вважається описом. Одне справжнє речення.
 *
 * Поріг навмисно низький. Він ловить рівно один випадок: сторінку, де немає
 * нічого, крім меню і кнопок. Відсіювати за обсягом марно, бо лендінг мережі
 * з маркетинговими абзацами набирає прози більше, ніж коротка вакансія, і саме
 * тому опис береться з `__NEXT_DATA__`, а не вгадується за виглядом тексту.
 */
export const MIN_PROSE_CHARS = 60;

export function isUsefulDetail(text: string | null | undefined): boolean {
  if (!text) return false;
  return proseChars(text) >= MIN_PROSE_CHARS;
}
