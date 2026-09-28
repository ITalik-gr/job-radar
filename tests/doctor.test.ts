import { afterEach, describe, expect, it } from 'vitest';
import { envValue, setRuntimeEnv } from '../src/config.js';
import { localChecks } from '../src/lib/doctor.js';

const KEYS = ['ANTHROPIC_API_KEY', 'LLM_PROVIDER', 'USER_AGENT_CONTACT'] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, envValue(key) ?? '']));

describe('local doctor', () => {
  afterEach(() => setRuntimeEnv(saved));

  it('an empty .env warns about the model key and the contact, not only a worker', () => {
    setRuntimeEnv({ ANTHROPIC_API_KEY: '', LLM_PROVIDER: 'anthropic', USER_AGENT_CONTACT: '' });
    const warned = localChecks()
      .filter((check) => check.level === 'warn')
      .map((check) => check.what);
    expect(warned).toEqual(expect.arrayContaining(['model', 'user agent']));
  });

  it('a filled .env passes those checks', () => {
    setRuntimeEnv({ ANTHROPIC_API_KEY: 'sk-test', LLM_PROVIDER: 'anthropic', USER_AGENT_CONTACT: 'me@example.com' });
    const byWhat = Object.fromEntries(localChecks().map((check) => [check.what, check.level]));
    expect(byWhat.model).toBe('ok');
    expect(byWhat['user agent']).toBe('ok');
  });
});
