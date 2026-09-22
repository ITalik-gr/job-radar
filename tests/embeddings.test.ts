import { describe, expect, it } from 'vitest';
import { cosine, packVector, unpackVector } from '../src/lib/embeddings.js';
import { companyText } from '../src/pipeline/similar.js';

describe('cosine similarity', () => {
  it('identical vectors give one', () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
  });

  it('scale does not matter, since vectors are normalized', () => {
    expect(cosine([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 6);
  });

  it('perpendicular gives zero', () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it('opposite gives minus one', () => {
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });

  it('mismatched length or an empty vector give zero, not a crash', () => {
    // An empty vector happens when a database record is corrupted. Zero means
    // "not similar", and that is more honest than a random number.
    expect(cosine([1, 2, 3], [1, 2])).toBe(0);
    expect(cosine([], [])).toBe(0);
  });

  it('a zero vector does not divide by zero', () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe('vector storage', () => {
  it('a vector survives being written and read back', () => {
    const vector = [0.12345, -0.98765, 0.5];
    const restored = unpackVector(packVector(vector))!;

    expect(restored).toHaveLength(3);
    expect(cosine(vector, restored)).toBeCloseTo(1, 5);
  });

  it('rounding to four decimals barely changes similarity', () => {
    // Over a 1024-dimension vector the deviation comes out to roughly a millionth,
    // two orders of magnitude smaller than the gap between truly similar and dissimilar companies.
    const vector = Array.from({ length: 1024 }, (_, i) => Math.sin(i) / 32);
    expect(cosine(vector, unpackVector(packVector(vector))!)).toBeCloseTo(1, 5);
  });

  it('compression really does save space', () => {
    const vector = Array.from({ length: 1024 }, (_, i) => Math.sin(i) * 0.123456789);
    expect(packVector(vector).length).toBeLessThan(JSON.stringify(vector).length / 2);
  });

  it('a corrupted or empty record does not break reading', () => {
    expect(unpackVector(null)).toBeNull();
    expect(unpackVector('not json')).toBeNull();
    expect(unpackVector('{"a":1}')).toBeNull();
  });
});

describe('company text for the model', () => {
  const base = { name: 'Acme', description: null, tags: [], techHints: [], kind: 'studio' };

  it('assembles the name, description, tags and stack', () => {
    const text = companyText({
      ...base,
      description: 'A web studio from Kyiv',
      tags: ['Web Design'],
      techHints: ['react'],
    });

    expect(text).toContain('Acme');
    expect(text).toContain('A web studio from Kyiv');
    expect(text).toContain('Web Design');
    expect(text).toContain('react');
  });

  it('empty fields do not leave empty lines', () => {
    expect(companyText(base)).toBe('Acme');
  });
});
