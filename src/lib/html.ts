import * as cheerio from 'cheerio';

/** Розгортає HTML-сутності: Greenhouse віддає розмітку вакансії подвійно екранованою. */
export function decodeEntities(input: string): string {
  if (!input) return '';
  if (!input.includes('&')) return input;
  return cheerio.load(`<body>${input}</body>`)('body').text();
}

/**
 * HTML у плаский текст. Це не нормалізація для хешування (вона буде на Етапі 3),
 * а лише читабельний `raw_text` для класифікатора і для очей.
 */
export function htmlToText(input: string): string {
  if (!input) return '';
  const $ = cheerio.load(`<body>${input}</body>`);
  $('script, style, svg, noscript, iframe').remove();
  $('br').replaceWith('\n');
  $('p, div, li, tr, h1, h2, h3, h4, h5, h6, section, article').each((_, el) => {
    $(el).after('\n');
  });
  $('li').each((_, el) => {
    $(el).before('- ');
  });
  return $('body')
    .text()
    .replace(/ /g, ' ')
    .replace(/[\t\f\r ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Текст із можливо екранованого HTML. */
export function anyToText(input: string | null | undefined): string {
  if (!input) return '';
  const looksEscaped = /&lt;|&gt;|&amp;lt;/.test(input);
  return htmlToText(looksEscaped ? decodeEntities(input) : input);
}
