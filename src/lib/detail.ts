/**
 * Checks whether a loaded vacancy page actually contains a description.
 *
 * Half of the boards are SPAs: the HTML holds only navigation, and JS loads the
 * vacancy text. Without this check the radar used to save a menu item list
 * ("startups, corporations, communities, investors") as the vacancy description,
 * and that text then went to the model, cost tokens, and produced a meaningless
 * classification.
 *
 * The check is structural, not word-based: it counts how much connected prose is in
 * the text. A menu of short lines has none of it in any language or design, while a
 * vacancy description always does.
 */

/**
 * Vacancy text from `__NEXT_DATA__`.
 *
 * Boards on Getro (Techstars, Underscore, and the rest of the networks) are Next.js:
 * the markup holds the network's header and footer, 70 thousand characters of it,
 * while the vacancy description itself is only in the embedded JSON. Because of this
 * the radar used to save the menu items "startups, corporations, communities" as the
 * vacancy text and paid to classify them.
 *
 * The search is not by a fixed path but by traversal: the page structure has already
 * changed on them, while the `description` field inside the vacancy object stayed.
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

/** A vacancy object is one that has a long `description`. */
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

/** A line counts as prose if it looks like a sentence, not a menu item. */
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
 * The minimum prose above which text counts as a description. One real sentence.
 *
 * The threshold is deliberately low. It catches exactly one case: a page with
 * nothing but menus and buttons. Filtering by volume is pointless, because a
 * network's landing page with marketing paragraphs racks up more prose than a short
 * vacancy, which is exactly why the description is taken from `__NEXT_DATA__` rather
 * than guessed from how the text looks.
 */
export const MIN_PROSE_CHARS = 60;

export function isUsefulDetail(text: string | null | undefined): boolean {
  if (!text) return false;
  return proseChars(text) >= MIN_PROSE_CHARS;
}
