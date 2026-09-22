import { describe, expect, it, vi, afterEach } from 'vitest';
import { setAiBinding, runWorkersAi, textFromAi, aiAvailable } from '../src/lib/workers-ai.js';
import { setRuntimeEnv } from '../src/config.js';

afterEach(() => setAiBinding(null));

describe('textFromAi', () => {
  it('reads the response field from llama models', () => {
    const parsed = textFromAi({ response: '{"is_vacancy":true}', usage: { prompt_tokens: 10, completion_tokens: 4 } });
    expect(parsed.text).toBe('{"is_vacancy":true}');
    expect(parsed.inputTokens).toBe(10);
    expect(parsed.outputTokens).toBe(4);
  });

  it('reads choices from OpenAI-compatible models', () => {
    expect(textFromAi({ choices: [{ message: { content: 'ok' } }] }).text).toBe('ok');
  });

  it('reads the output array from gpt-oss', () => {
    const payload = { output: [{ content: [{ text: 'part1 ' }, { text: 'part2' }] }] };
    expect(textFromAi(payload).text).toBe('part1 part2');
  });

  // Rule 3 in CLAUDE.md: an empty result is an error, not a success.
  it('throws an error instead of returning an empty string', () => {
    expect(() => textFromAi({ result: 'something unrecognized' })).toThrow(/no text/);
  });

  it('tokens without usage are counted as zero, not NaN', () => {
    const parsed = textFromAi({ response: 'ok' });
    expect(parsed.inputTokens).toBe(0);
    expect(parsed.outputTokens).toBe(0);
  });
});

describe('runWorkersAi', () => {
  it('goes through the binding when it is present', async () => {
    const run = vi.fn().mockResolvedValue({ response: 'ok' });
    setAiBinding({ run });
    await expect(runWorkersAi('@cf/test', { messages: [] })).resolves.toEqual({ response: 'ok' });
    expect(run).toHaveBeenCalledWith('@cf/test', { messages: [] });
    expect(aiAvailable()).toBe(true);
  });

  // No keys from a real .env are needed here: the test must not hit the network.
  it('without a binding and without a token it fails loudly, not silently', async () => {
    setRuntimeEnv({ CF_AI_ACCOUNT_ID: '', CF_AI_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_API_TOKEN: '' });
    expect(aiAvailable()).toBe(false);
    await expect(runWorkersAi('@cf/test', {})).rejects.toThrow(/CF_AI_ACCOUNT_ID/);
  });

  // The old names keep working: someone else's local .env must not break from a rename.
  it('the old CLOUDFLARE_* names are still read', async () => {
    setRuntimeEnv({ CF_AI_ACCOUNT_ID: '', CF_AI_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: 'acc', CLOUDFLARE_API_TOKEN: 'token' });
    expect(aiAvailable()).toBe(true);
  });

  it('unwraps the success/result envelope over REST', async () => {
    setRuntimeEnv({ CF_AI_ACCOUNT_ID: 'acc', CF_AI_API_TOKEN: 'token' });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true, result: { response: 'ok' } }), { status: 200 }),
      );

    await expect(runWorkersAi('@cf/test', {})).resolves.toEqual({ response: 'ok' });
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/accounts/acc/ai/run/@cf/test');
    fetchMock.mockRestore();
  });
});
