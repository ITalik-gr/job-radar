import { describe, expect, it } from 'vitest';
import { commonAffixes, stripBoilerplate } from '../src/pipeline/boilerplate.js';

const about = 'A'.repeat(500);
const benefits = 'B'.repeat(400);
const body = (n: number) => `${n}. Роль з унікальним описом. `.padEnd(900, String(n));

describe('спільні частини тексту вакансій', () => {
  it('знаходить і вступ, і хвіст', () => {
    const texts = [1, 2, 3].map((n) => about + body(n) + benefits);
    const { prefix, suffix } = commonAffixes(texts);

    expect(prefix).toBe(about.length);
    expect(suffix).toBe(benefits.length);
  });

  it('менше трьох вакансій це не вибірка', () => {
    const texts = [about + body(1), about + body(2)];
    expect(commonAffixes(texts)).toEqual({ prefix: 0, suffix: 0 });
  });

  it('короткий збіг не вважається шаблоном', () => {
    // Кілька спільних слів на початку це випадковість, а не блок про компанію.
    const texts = [1, 2, 3].map((n) => 'We are hiring. ' + body(n));
    expect(commonAffixes(texts).prefix).toBe(0);
  });

  it('порожні тексти не ламають розрахунок', () => {
    expect(commonAffixes(['', '', ''])).toEqual({ prefix: 0, suffix: 0 });
    expect(commonAffixes([])).toEqual({ prefix: 0, suffix: 0 });
  });
});

describe('обрізання', () => {
  it('вирізає вступ і хвіст, лишаючи саму вакансію', () => {
    const text = about + body(1) + benefits;
    const result = stripBoilerplate(text, { prefix: about.length, suffix: benefits.length });

    expect(result).not.toContain('AAAA');
    expect(result).not.toContain('BBBB');
    expect(result).toContain('Роль з унікальним описом');
  });

  it('не ріже, коли лишається надто мало', () => {
    // Краще заплатити за зайві токени, ніж дати моделі недогризок і отримати вигадану вилку.
    const text = about + 'коротка вакансія' + benefits;
    expect(stripBoilerplate(text, { prefix: about.length, suffix: benefits.length })).toBe(text);
  });

  it('без спільних частин текст лишається як є', () => {
    const text = body(1);
    expect(stripBoilerplate(text, { prefix: 0, suffix: 0 })).toBe(text);
  });

  it('економія на реальних пропорціях відчутна', () => {
    const texts = [1, 2, 3].map((n) => about + body(n) + benefits);
    const affixes = commonAffixes(texts);
    const before = texts[0]!.length;
    const after = stripBoilerplate(texts[0]!, affixes).length;

    expect(after).toBeLessThan(before * 0.6);
  });
});
