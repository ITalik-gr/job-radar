import { config } from '../config.js';

/**
 * One entry point into Workers AI for the whole project: both company vectors and
 * classification.
 *
 * Two call paths on purpose. On Workers there is an `AI` binding, and it needs
 * neither a token nor outbound network access. Locally there is no binding, so it is
 * REST plus a token from `.env`. Without either of them, the function honestly
 * throws an error instead of returning an empty response: a silent zero here is
 * worse than a crash.
 */

export interface AiBinding {
  run: (model: string, input: unknown, options?: unknown) => Promise<unknown>;
}

let binding: AiBinding | null = null;

/** Set in `worker.ts` on every request. Stays empty outside of Workers. */
export function setAiBinding(value: AiBinding | null): void {
  binding = value;
}

export function hasAiBinding(): boolean {
  return binding !== null;
}

/** Whether there is anything at all to call Workers AI with: a binding, or an account + token pair. */
export function aiAvailable(): boolean {
  const { accountId, apiToken } = config.cloudflare;
  return binding !== null || Boolean(accountId && apiToken);
}

export async function runWorkersAi(model: string, input: unknown): Promise<unknown> {
  const { accountId, apiToken, gatewayId, gatewayToken, gatewayUrl } = config.cloudflare;

  /*
   * Through the binding, the gateway is turned on via the third argument. Without
   * it, the request to the model runs fine, but it is not visible in the AI Gateway
   * at all, which is exactly why it shows zeros while classification is live. No
   * token is needed here: the binding is already authenticated by the worker's account.
   */
  if (binding) {
    return gatewayId
      ? binding.run(model, input, { gateway: { id: gatewayId } })
      : binding.run(model, input);
  }

  if (!accountId || !apiToken) {
    throw new Error(
      'no CF_AI_ACCOUNT_ID or CF_AI_API_TOKEN in .env, and there is no AI binding outside of Workers',
    );
  }

  const url = gatewayUrl
    ? `${gatewayUrl}/workers-ai/${model}`
    : `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiToken}`,
      'content-type': 'application/json',
      // Needed only for an Authenticated Gateway, without it the gateway returns 401.
      ...(gatewayToken ? { 'cf-aig-authorization': `Bearer ${gatewayToken}` } : {}),
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const text = (await response.text()).slice(0, 200);
    const hint =
      response.status === 401 && gatewayUrl
        ? '. Looks like an Authenticated Gateway: needs AI_GATEWAY_TOKEN or the gateway authentication turned off'
        : '';
    throw new Error(`Workers AI: ${response.status} ${text}${hint}`);
  }

  const body = (await response.json()) as { result?: unknown; success?: boolean; errors?: unknown[] };
  /*
   * The gateway returns the model's response without the `success` wrapper, while
   * the direct API includes it. We tell them apart by whether the field is present,
   * otherwise everything through the gateway would fail this check.
   */
  if (body.success === false) throw new Error(`Workers AI: ${JSON.stringify(body.errors).slice(0, 200)}`);
  return body.success === true ? body.result : body;
}

interface AiText {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Extract text from a generative model's response.
 *
 * The response shape depends on the model: llama returns `response`, OpenAI-compatible
 * models return `choices[0].message.content`, and gpt-oss puts the text in the
 * `output` array. Parsing this at every call site would mean a silent empty string
 * whenever the model changes, so it is parsed in one place and throws when there is
 * no text.
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

  if (!text) throw new Error('Workers AI returned a response with no text');

  return {
    text,
    inputTokens: Number(usage.prompt_tokens ?? 0) || 0,
    outputTokens: Number(usage.completion_tokens ?? 0) || 0,
  };
}
