import { config } from '../config.js';

/**
 * Один вхід у Workers AI для всього проєкту: і вектори компаній, і класифікація.
 *
 * Два шляхи виклику навмисно. На Workers є біндінг `AI`, там ні токена, ні виходу
 * в мережу назовні не потрібно. Локально біндінга немає, тому REST і токен з `.env`.
 * Без жодного з них функція чесно кидає помилку, а не повертає порожню відповідь:
 * мовчазний нуль тут гірший за падіння.
 */

export interface AiBinding {
  run: (model: string, input: unknown) => Promise<unknown>;
}

let binding: AiBinding | null = null;

/** Ставиться в `worker.ts` на кожен запит. Поза Workers лишається порожнім. */
export function setAiBinding(value: AiBinding | null): void {
  binding = value;
}

export function hasAiBinding(): boolean {
  return binding !== null;
}

/** Чи є взагалі чим викликати Workers AI: біндінг або пара account + token. */
export function aiAvailable(): boolean {
  const { accountId, apiToken } = config.cloudflare;
  return binding !== null || Boolean(accountId && apiToken);
}

export async function runWorkersAi(model: string, input: unknown): Promise<unknown> {
  if (binding) return binding.run(model, input);

  const { accountId, apiToken } = config.cloudflare;
  if (!accountId || !apiToken) {
    throw new Error(
      'немає CLOUDFLARE_ACCOUNT_ID або CLOUDFLARE_API_TOKEN у .env, а біндінга AI поза Workers не буває',
    );
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
  );

  if (!response.ok) {
    throw new Error(`Workers AI: ${response.status} ${(await response.text()).slice(0, 200)}`);
  }

  const body = (await response.json()) as { result?: unknown; success?: boolean; errors?: unknown[] };
  if (!body.success) throw new Error(`Workers AI: ${JSON.stringify(body.errors).slice(0, 200)}`);
  return body.result;
}

interface AiText {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Витягти текст із відповіді генеративної моделі.
 *
 * Форма відповіді залежить від моделі: llama віддає `response`, сумісні з OpenAI
 * моделі віддають `choices[0].message.content`, а gpt-oss кладе текст у масив
 * `output`. Розбирати це в кожному місці виклику означало б мовчазний порожній
 * рядок при зміні моделі, тому розбір один і кидає помилку, коли тексту немає.
 */
export function textFromAi(payload: unknown): AiText {
  const root = (payload ?? {}) as Record<string, unknown>;
  const usage = (root.usage ?? {}) as Record<string, number>;

  const fromChoices = (root.choices as { message?: { content?: unknown } }[] | undefined)?.[0]
    ?.message?.content;

  const fromOutput = Array.isArray(root.output)
    ? (root.output as Record<string, unknown>[])
        .flatMap((item) => (Array.isArray(item.content) ? (item.content as Record<string, unknown>[]) : []))
        .map((part) => (typeof part.text === 'string' ? part.text : ''))
        .join('')
    : '';

  const text =
    typeof root.response === 'string'
      ? root.response
      : typeof fromChoices === 'string'
        ? fromChoices
        : fromOutput;

  if (!text) throw new Error('Workers AI повернув відповідь без тексту');

  return {
    text,
    inputTokens: Number(usage.prompt_tokens ?? 0) || 0,
    outputTokens: Number(usage.completion_tokens ?? 0) || 0,
  };
}
