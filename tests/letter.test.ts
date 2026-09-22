import { describe, expect, it } from 'vitest';
import { LETTER_PLACEHOLDERS, mailtoLink, renderLetter } from '../src/lib/letter.js';

const context = {
  company: 'Acme Studio',
  domain: 'acme.com',
  contactName: 'Anton Malyy',
  kind: 'design',
  stack: ['react', 'next.js'],
  vacancyTitle: 'Frontend Developer',
};

describe('filling a letter template', () => {
  it('fills in every supported value', () => {
    const { text } = renderLetter(
      'Hi {{first_name}}. Saw {{domain}}, you are {{niche}}. Stack: {{their_stack}}.',
      context,
    );
    expect(text).toBe('Hi Anton. Saw acme.com, you are a design studio. Stack: react, next.js.');
  });

  it('a Ukrainian letter gets the niche in Ukrainian', () => {
    const { text } = renderLetter('Вітаю. Ви {{niche}}.', { ...context, language: 'uk' });
    expect(text).toBe('Вітаю. Ви дизайн-студія.');
  });

  it('the full name and the first word are different tokens', () => {
    const { text } = renderLetter('{{contact_name}} | {{first_name}}', context);
    expect(text).toBe('Anton Malyy | Anton');
  });

  it('an empty value leaves no curly braces in the letter', () => {
    const { text, missing } = renderLetter('Hi {{contact_name}}.', {
      company: 'Acme',
      domain: 'acme.com',
    });

    expect(text).not.toContain('{{');
    expect(missing).toContain('contact_name');
  });

  it('an unknown token is reported separately from an empty one', () => {
    const { missing, unknown } = renderLetter('{{compnay}} {{contact_name}}', {
      company: 'Acme',
      domain: 'acme.com',
    });

    expect(unknown).toEqual(['compnay']);
    expect(missing).toEqual(['contact_name']);
  });

  it('spaces inside the braces do not break substitution', () => {
    expect(renderLetter('{{ company }}', context).text).toBe('Acme Studio');
  });

  it('double spaces and dangling commas after an empty value are cleaned up', () => {
    const { text } = renderLetter('Hi {{contact_name}} , I have an offer', {
      company: 'Acme',
      domain: 'acme.com',
    });
    expect(text).toBe('Hi, I have an offer');
  });

  it('a template without placeholders stays as is', () => {
    expect(renderLetter('Just text', context).text).toBe('Just text');
  });

  it('the placeholder list for the editor is not empty and has hints', () => {
    expect(LETTER_PLACEHOLDERS.length).toBeGreaterThan(4);
    expect(LETTER_PLACEHOLDERS.every((item) => item.token && item.hint)).toBe(true);
  });
});

describe('mailto', () => {
  it('builds a link with subject and body', () => {
    const link = mailtoLink('a@acme.com', 'Offer', 'Hello');
    expect(link).toMatch(/^mailto:a@acme\.com\?/);
    expect(link).toContain('subject=');
    expect(link).toContain('body=');
  });

  it('a space is encoded as %20, because mail clients do not understand plus', () => {
    expect(mailtoLink('a@acme.com', 'two words', '')).toContain('%20');
    expect(mailtoLink('a@acme.com', 'two words', '')).not.toContain('+');
  });

  it('no address means no link', () => {
    expect(mailtoLink(null, 'Subject', 'Body')).toBeNull();
  });
});

/*
 * The first paragraph is the owner's text just like the letter body, and placeholders must work
 * in it. It used to be inserted as a ready string, and `{{company}}` typed into the paragraph
 * field reached the mail as curly braces.
 */
describe('placeholders inside the first paragraph', () => {
  it('the paragraph goes through substitution rather than being inserted as is', () => {
    const { text } = renderLetter('{{intro}} More text.', {
      ...context,
      intro: 'Saw {{company}} and their {{their_stack}}.',
    });

    expect(text).toBe('Saw Acme Studio and their react, next.js. More text.');
  });

  it('an empty placeholder in the paragraph is reported when the template uses the paragraph', () => {
    const { text, missing } = renderLetter('{{intro}}', {
      company: 'Acme',
      domain: 'acme.com',
      intro: 'Hi {{contact_name}}.',
    });

    expect(text).not.toContain('{{');
    expect(missing).toContain('contact_name');
  });

  it('a template without the paragraph marker does not complain about its contents', () => {
    const { missing, unknown } = renderLetter('Just text about {{company}}.', {
      company: 'Acme',
      domain: 'acme.com',
      intro: 'A draft with {{compnay}} and {{contact_name}}.',
    });

    expect(missing).toEqual([]);
    expect(unknown).toEqual([]);
  });

  it('the paragraph marker inside the paragraph itself is an error, not recursion', () => {
    const { text, unknown } = renderLetter('{{intro}}', {
      company: 'Acme',
      domain: 'acme.com',
      intro: 'Text {{intro}} text',
    });

    expect(text).toBe('Text text');
    expect(unknown).toContain('intro');
  });

  it('placeholders work in the subject too', () => {
    const { text } = renderLetter('Frontend for {{company}}, {{country}}', {
      ...context,
      country: 'Poland',
    });

    expect(text).toBe('Frontend for Acme Studio, Poland');
  });
});

describe('signature', () => {
  it('is placed where the marker stands', () => {
    const { text } = renderLetter('Text.\n\n{{signature}}', {
      company: 'Acme',
      domain: 'acme.com',
      signature: 'Olena\nolena.dev',
    });

    expect(text).toBe('Text.\n\nOlena\nolena.dev');
  });

  it('an empty signature leaves no braces and is reported', () => {
    const { text, missing } = renderLetter('Text.\n\n{{signature}}', {
      company: 'Acme',
      domain: 'acme.com',
    });

    expect(text).not.toContain('{{');
    expect(missing).toContain('signature');
  });
});
