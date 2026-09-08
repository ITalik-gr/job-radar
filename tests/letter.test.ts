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

describe('підстановка в шаблон листа', () => {
  it('підставляє всі підтримувані значення', () => {
    const { text } = renderLetter(
      'Вітаю, {{first_name}}. Бачив {{domain}}, ви {{niche}}. Стек: {{their_stack}}.',
      context,
    );
    expect(text).toBe('Вітаю, Anton. Бачив acme.com, ви дизайн-студія. Стек: react, next.js.');
  });

  it('повне імʼя і перше слово це різні токени', () => {
    const { text } = renderLetter('{{contact_name}} | {{first_name}}', context);
    expect(text).toBe('Anton Malyy | Anton');
  });

  it('порожнє значення не лишає фігурних дужок у листі', () => {
    const { text, missing } = renderLetter('Вітаю, {{contact_name}}.', {
      company: 'Acme',
      domain: 'acme.com',
    });

    expect(text).not.toContain('{{');
    expect(missing).toContain('contact_name');
  });

  it('невідомий токен повідомляється окремо від порожнього', () => {
    const { missing, unknown } = renderLetter('{{compnay}} {{contact_name}}', {
      company: 'Acme',
      domain: 'acme.com',
    });

    expect(unknown).toEqual(['compnay']);
    expect(missing).toEqual(['contact_name']);
  });

  it('пробіли всередині дужок не ламають підстановку', () => {
    expect(renderLetter('{{ company }}', context).text).toBe('Acme Studio');
  });

  it('подвійні пробіли і висячі коми після порожнього значення прибираються', () => {
    const { text } = renderLetter('Вітаю {{contact_name}} , маю пропозицію', {
      company: 'Acme',
      domain: 'acme.com',
    });
    expect(text).toBe('Вітаю, маю пропозицію');
  });

  it('шаблон без плейсхолдерів лишається як є', () => {
    expect(renderLetter('Просто текст', context).text).toBe('Просто текст');
  });

  it('перелік плейсхолдерів для редактора не порожній і має підписи', () => {
    expect(LETTER_PLACEHOLDERS.length).toBeGreaterThan(4);
    expect(LETTER_PLACEHOLDERS.every((item) => item.token && item.hint)).toBe(true);
  });
});

describe('mailto', () => {
  it('складає посилання з темою і тілом', () => {
    const link = mailtoLink('a@acme.com', 'Пропозиція', 'Вітаю');
    expect(link).toMatch(/^mailto:a@acme\.com\?/);
    expect(link).toContain('subject=');
    expect(link).toContain('body=');
  });

  it('пробіл кодується як %20, бо поштові клієнти не розуміють плюс', () => {
    expect(mailtoLink('a@acme.com', 'дві теми', '')).toContain('%20');
    expect(mailtoLink('a@acme.com', 'дві теми', '')).not.toContain('+');
  });

  it('без адреси посилання немає', () => {
    expect(mailtoLink(null, 'Тема', 'Текст')).toBeNull();
  });
});

/*
 * Перший абзац це такий самий текст власника, як і тіло листа, і мітки в ньому
 * мусять працювати. До цього він вставлявся готовим рядком, і `{{company}}`,
 * написаний в полі абзацу, доїжджав до пошти фігурними дужками.
 */
describe('мітки всередині першого абзацу', () => {
  it('абзац проходить підстановку, а не вставляється як є', () => {
    const { text } = renderLetter('{{intro}} Далі текст.', {
      ...context,
      intro: 'Бачив {{company}} і їхній {{their_stack}}.',
    });

    expect(text).toBe('Бачив Acme Studio і їхній react, next.js. Далі текст.');
  });

  it('порожня мітка в абзаці повідомляється, коли шаблон абзац бере', () => {
    const { text, missing } = renderLetter('{{intro}}', {
      company: 'Acme',
      domain: 'acme.com',
      intro: 'Вітаю, {{contact_name}}.',
    });

    expect(text).not.toContain('{{');
    expect(missing).toContain('contact_name');
  });

  it('шаблон без мітки абзацу не скаржиться на його вміст', () => {
    const { missing, unknown } = renderLetter('Просто текст про {{company}}.', {
      company: 'Acme',
      domain: 'acme.com',
      intro: 'Заготовка з {{compnay}} і {{contact_name}}.',
    });

    expect(missing).toEqual([]);
    expect(unknown).toEqual([]);
  });

  it('мітка абзацу всередині самого абзацу це помилка, а не рекурсія', () => {
    const { text, unknown } = renderLetter('{{intro}}', {
      company: 'Acme',
      domain: 'acme.com',
      intro: 'Текст {{intro}} текст',
    });

    expect(text).toBe('Текст текст');
    expect(unknown).toContain('intro');
  });

  it('мітки працюють і в темі листа', () => {
    const { text } = renderLetter('Frontend для {{company}}, {{country}}', {
      ...context,
      country: 'Poland',
    });

    expect(text).toBe('Frontend для Acme Studio, Poland');
  });
});

describe('підпис', () => {
  it('підставляється на місце мітки', () => {
    const { text } = renderLetter('Текст.\n\n{{signature}}', {
      company: 'Acme',
      domain: 'acme.com',
      signature: 'Alex\nexample.dev',
    });

    expect(text).toBe('Текст.\n\nAlex\nexample.dev');
  });

  it('порожній підпис не лишає дужок і повідомляється', () => {
    const { text, missing } = renderLetter('Текст.\n\n{{signature}}', {
      company: 'Acme',
      domain: 'acme.com',
    });

    expect(text).not.toContain('{{');
    expect(missing).toContain('signature');
  });
});
