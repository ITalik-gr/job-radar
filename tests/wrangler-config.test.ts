import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script without type declarations
import { mergeConfig, parseJsonc } from '../scripts/wrangler-config.mjs';

describe('wrangler config merge', () => {
  it('strips comments but keeps comment-like text inside strings', () => {
    const parsed = parseJsonc('{\n  // line\n  "a": ["/api/*"], /* block */\n  "b": "//x",\n}');
    expect(parsed).toEqual({ a: ['/api/*'], b: '//x' });
  });

  it('adds a database id by binding and merges vars key by key', () => {
    const base = {
      name: 'job-radar',
      d1_databases: [{ binding: 'DB', database_name: 'job-radar', migrations_dir: 'm' }],
      vars: { LLM_PROVIDER: 'anthropic' },
    };
    const merged = mergeConfig(base, {
      d1_databases: [{ binding: 'DB', database_id: 'abc' }],
      vars: { GMAIL_FROM_NAME: 'Someone' },
    });
    expect(merged.d1_databases).toEqual([
      { binding: 'DB', database_name: 'job-radar', migrations_dir: 'm', database_id: 'abc' },
    ]);
    expect(merged.vars).toEqual({ LLM_PROVIDER: 'anthropic', GMAIL_FROM_NAME: 'Someone' });
    expect(merged.name).toBe('job-radar');
  });
});
