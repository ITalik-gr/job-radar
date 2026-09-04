import { describe, expect, it, vi, afterEach } from 'vitest';
import { setAiBinding, runWorkersAi, textFromAi, aiAvailable } from '../src/lib/workers-ai.js';
import { setRuntimeEnv } from '../src/config.js';

afterEach(() => setAiBinding(null));

describe('textFromAi', () => {
  it('читає поле response у моделей llama', () => {
    const parsed = textFromAi({ response: '{"is_vacancy":true}', usage: { prompt_tokens: 10, completion_tokens: 4 } });
    expect(parsed.text).toBe('{"is_vacancy":true}');
    expect(parsed.inputTokens).toBe(10);
    expect(parsed.outputTokens).toBe(4);
  });

  it('читає choices у моделей, сумісних з OpenAI', () => {
    expect(textFromAi({ choices: [{ message: { content: 'ok' } }] }).text).toBe('ok');
  });

  it('читає масив output у gpt-oss', () => {
    const payload = { output: [{ content: [{ text: 'part1 ' }, { text: 'part2' }] }] };
    expect(textFromAi(payload).text).toBe('part1 part2');
  });

  // Правило 3 в CLAUDE.md: порожній результат це помилка, а не успіх.
  it('кидає помилку, а не повертає порожній рядок', () => {
    expect(() => textFromAi({ result: 'щось незнайоме' })).toThrow(/без тексту/);
  });

  it('токени без usage рахуються нулем, а не NaN', () => {
    const parsed = textFromAi({ response: 'ok' });
    expect(parsed.inputTokens).toBe(0);
    expect(parsed.outputTokens).toBe(0);
  });
});

describe('runWorkersAi', () => {
  it('іде через біндінг, коли він є', async () => {
    const run = vi.fn().mockResolvedValue({ response: 'ok' });
    setAiBinding({ run });
    await expect(runWorkersAi('@cf/test', { messages: [] })).resolves.toEqual({ response: 'ok' });
    expect(run).toHaveBeenCalledWith('@cf/test', { messages: [] });
    expect(aiAvailable()).toBe(true);
  });

  // Ключі з реального .env тут не потрібні: тест не має ходити в мережу.
  it('без біндінга і без токена падає, а не мовчить', async () => {
    setRuntimeEnv({ CF_AI_ACCOUNT_ID: '', CF_AI_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_API_TOKEN: '' });
    expect(aiAvailable()).toBe(false);
    await expect(runWorkersAi('@cf/test', {})).rejects.toThrow(/CF_AI_ACCOUNT_ID/);
  });

  // Старі імена лишаються робочими: чужий локальний .env не має ламатись від перейменування.
  it('старі імена CLOUDFLARE_* читаються далі', async () => {
    setRuntimeEnv({ CF_AI_ACCOUNT_ID: '', CF_AI_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: 'acc', CLOUDFLARE_API_TOKEN: 'token' });
    expect(aiAvailable()).toBe(true);
  });

  it('через REST розгортає обгортку success/result', async () => {
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
