import * as cheerio from 'cheerio';

/** Unescapes HTML entities: Greenhouse returns vacancy markup double-escaped. */
export function decodeEntities(input: string): string {
  if (!input) return '';
  if (!input.includes('&')) return input;
  return cheerio.load(`<body>${input}</body>`)('body').text();
}

/**
 * HTML into flat text. This is not the normalization used for hashing (that comes in
 * Stage 3), just a readable `raw_text` for the classifier and for human eyes.
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

/** Text from HTML that may or may not be escaped. */
export function anyToText(input: string | null | undefined): string {
  if (!input) return '';
  const looksEscaped = /&lt;|&gt;|&amp;lt;/.test(input);
  return htmlToText(looksEscaped ? decodeEntities(input) : input);
}
