import { describe, expect, it } from 'vitest';
import { cosine, packVector, unpackVector } from '../src/lib/embeddings.js';
import { companyText } from '../src/pipeline/similar.js';

describe('косинусна близькість', () => {
  it('однакові вектори це одиниця', () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });

  it('масштаб не впливає, бо вектори нормалізуються', () => {
    expect(cosine([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 6);
  });

  it('перпендикулярні це нуль', () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it('протилежні це мінус одиниця', () => {
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });

  it('різна довжина або порожній вектор дають нуль, а не падіння', () => {
    // Порожній вектор трапляється, якщо в базі зіпсований запис. Нуль означає
    // "не схожі", і це чесніше за випадкове число.
    expect(cosine([1, 2, 3], [1, 2])).toBe(0);
    expect(cosine([], [])).toBe(0);
  });

  it('нульовий вектор не ділиться на нуль', () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe('зберігання векторів', () => {
  it('вектор переживає запис і читання', () => {
    const vector = [0.12345, -0.98765, 0.5];
    const restored = unpackVector(packVector(vector))!;

    expect(restored).toHaveLength(3);
    expect(cosine(vector, restored)).toBeCloseTo(1, 5);
  });

  it('округлення до чотирьох знаків майже не міняє близькість', () => {
    // На векторі в 1024 виміри відхилення виходить близько мільйонної, тобто
    // на два порядки менше за різницю між справді схожими і несхожими компаніями.
    const vector = Array.from({ length: 1024 }, (_, i) => Math.sin(i) / 32);
    expect(cosine(vector, unpackVector(packVector(vector))!)).toBeCloseTo(1, 5);
  });

  it('стиснення справді економить місце', () => {
    const vector = Array.from({ length: 1024 }, (_, i) => Math.sin(i) * 0.123456789);
    expect(packVector(vector).length).toBeLessThan(JSON.stringify(vector).length / 2);
  });

  it('пошкоджений або порожній запис не валить читання', () => {
    expect(unpackVector(null)).toBeNull();
    expect(unpackVector('не json')).toBeNull();
    expect(unpackVector('{"a":1}')).toBeNull();
  });
});

describe('текст компанії для моделі', () => {
  const base = { name: 'Acme', description: null, tags: [], techHints: [], kind: 'studio' };

  it('складає назву, опис, теги і стек', () => {
    const text = companyText({
      ...base,
      description: 'Веб-студія з Києва',
      tags: ['Web Design'],
      techHints: ['react'],
    });

    expect(text).toContain('Acme');
    expect(text).toContain('Веб-студія з Києва');
    expect(text).toContain('Web Design');
    expect(text).toContain('react');
  });

  it('порожні поля не лишають порожніх рядків', () => {
    expect(companyText(base)).toBe('Acme');
  });
});
