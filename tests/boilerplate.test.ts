import { describe, expect, it } from 'vitest';
import { commonAffixes, stripBoilerplate } from '../src/pipeline/boilerplate.js';

const about = 'A'.repeat(500);
const benefits = 'B'.repeat(400);
const body = (n: number) => `${n}. Role with a unique description. `.padEnd(900, String(n));

describe('shared parts of vacancy texts', () => {
  it('finds both the intro and the tail', () => {
    const texts = [1, 2, 3].map((n) => about + body(n) + benefits);
    const { prefix, suffix } = commonAffixes(texts);

    expect(prefix).toBe(about.length);
    expect(suffix).toBe(benefits.length);
  });

  it('fewer than three vacancies is not a sample', () => {
    const texts = [about + body(1), about + body(2)];
    expect(commonAffixes(texts)).toEqual({ prefix: 0, suffix: 0 });
  });

  it('a short match does not count as boilerplate', () => {
    // A few shared words at the start are a coincidence, not a block about the company.
    const texts = [1, 2, 3].map((n) => 'We are hiring. ' + body(n));
    expect(commonAffixes(texts).prefix).toBe(0);
  });

  it('empty texts do not break the calculation', () => {
    expect(commonAffixes(['', '', ''])).toEqual({ prefix: 0, suffix: 0 });
    expect(commonAffixes([])).toEqual({ prefix: 0, suffix: 0 });
  });
});

describe('trimming', () => {
  it('cuts the intro and the tail, leaving the vacancy itself', () => {
    const text = about + body(1) + benefits;
    const result = stripBoilerplate(text, { prefix: about.length, suffix: benefits.length });

    expect(result).not.toContain('AAAA');
    expect(result).not.toContain('BBBB');
    expect(result).toContain('Role with a unique description');
  });

  it('does not cut when too little would be left', () => {
    // Better to pay for extra tokens than to hand the model a scrap and get a made-up salary.
    const text = about + 'short vacancy' + benefits;
    expect(stripBoilerplate(text, { prefix: about.length, suffix: benefits.length })).toBe(text);
  });

  it('with no shared parts the text stays as is', () => {
    const text = body(1);
    expect(stripBoilerplate(text, { prefix: 0, suffix: 0 })).toBe(text);
  });

  it('the savings on real-world proportions are noticeable', () => {
    const texts = [1, 2, 3].map((n) => about + body(n) + benefits);
    const affixes = commonAffixes(texts);
    const before = texts[0]!.length;
    const after = stripBoilerplate(texts[0]!, affixes).length;

    expect(after).toBeLessThan(before * 0.6);
  });
});
