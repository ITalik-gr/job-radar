import 'dotenv/config';

/**
 * The config is read lazily through getters. The reason: on Cloudflare variables arrive as worker
 * bindings after the modules have loaded, so computing at import time gave an empty Anthropic
 * key and a disabled Telegram, silently.
 */

let runtime: Record<string, string | undefined> =
  typeof process !== 'undefined' && process.env ? { ...process.env } : {};

/** Called by the worker on every request, before handling it. */
export function setRuntimeEnv(env: Record<string, unknown>): void {
  const clean: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') clean[key] = value;
  }
  runtime = { ...runtime, ...clean };
}

export function envValue(key: string): string | undefined {
  return runtime[key];
}

function num(key: string, fallback: number): number {
  const parsed = Number(runtime[key]);
  return Number.isFinite(parsed) && runtime[key] !== undefined && runtime[key] !== '' ? parsed : fallback;
}

function str(key: string, fallback: string): string {
  const value = runtime[key];
  return value === undefined || value === '' ? fallback : value;
}

export const config = {
  get dbPath() {
    return str('DB_PATH', 'data/radar.db');
  },
  /** Access token. Empty means the radar is local and there is no check. */
  get token() {
    return str('RADAR_TOKEN', '');
  },
  /**
   * The owner's time zone: the schedule, the daily queue and model budget, the send window.
   * It used to be Kyiv in some places and UTC in others, so the queue day rolled over at 03:00.
   */
  get timezone() {
    return str('TZ', 'Europe/Kyiv');
  },
  log: {
    get level() {
      return str('LOG_LEVEL', 'info');
    },
  },
  http: {
    get userAgent() {
      return `JobRadar/0.1 (+mailto:${str('USER_AGENT_CONTACT', 'unknown')})`;
    },
    get concurrency() {
      return num('HTTP_CONCURRENCY', 4);
    },
    get domainDelayMs() {
      return num('HTTP_DOMAIN_DELAY_MS', 1000);
    },
    get timeoutMs() {
      return num('HTTP_TIMEOUT_MS', 20000);
    },
    get retries() {
      return num('HTTP_RETRIES', 3);
    },
  },
  /**
   * Access to Workers AI outside Workers: the local CLI and tests.
   *
   * The names are our own on purpose, not `CLOUDFLARE_API_TOKEN`. Wrangler reads `.env` and takes
   * exactly `CLOUDFLARE_API_TOKEN` from it as its own credentials, so a token issued only for
   * Workers AI replaced the owner's login and broke everything else: `wrangler d1 migrations
   * apply` failed with 7403 "account is not authorized". The old names are still read so that
   * nobody's local .env breaks.
   */
  cloudflare: {
    get accountId() {
      return str('CF_AI_ACCOUNT_ID', str('CLOUDFLARE_ACCOUNT_ID', ''));
    },
    get apiToken() {
      return str('CF_AI_API_TOKEN', str('CLOUDFLARE_API_TOKEN', ''));
    },
    /**
     * AI Gateway name. Through it every model request is visible, with its cost and cache hits,
     * which the counter in `llm_usage` does not show.
     */
    get gatewayId() {
      return str('AI_GATEWAY_ID', '');
    },
    /**
     * Token for an Authenticated Gateway. If authentication is enabled in the gateway settings, a
     * request without the `cf-aig-authorization` header is rejected with 401 before reaching the
     * provider, and it looks like "the model does not answer".
     *
     * Calls through the `AI` binding in the worker need no token.
     */
    get gatewayToken() {
      return str('AI_GATEWAY_TOKEN', '');
    },
    /** Gateway base URL. Empty if no gateway is configured. */
    get gatewayUrl() {
      const { accountId, gatewayId } = this;
      return accountId && gatewayId
        ? `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}`
        : '';
    },
  },

  llm: {
    /**
     * Who classifies: `anthropic` or `workers-ai`.
     *
     * Workers AI is part of the paid Cloudflare plan, so classification there costs neurons from
     * the included quota rather than separate dollars. Anthropic stays the default: the quality is
     * higher, and the cache was built on it.
     */
    get provider(): 'anthropic' | 'workers-ai' {
      return str('LLM_PROVIDER', 'anthropic') === 'workers-ai' ? 'workers-ai' : 'anthropic';
    },
    get apiKey() {
      return str('ANTHROPIC_API_KEY', '');
    },
    get model() {
      return str('ANTHROPIC_MODEL', 'claude-haiku-4-5-20251001');
    },
    /**
     * Model for the first paragraph of a letter. Deliberately stronger than the classifier.
     *
     * The bill differs by two orders of magnitude in volume, not in price: classification is
     * thousands of calls for thousands of vacancies, while the paragraph is one call per company
     * that really gets a letter, that is, dozens a month. Saving on what a person will read costs
     * more than a few dollars of difference.
     */
    get outreachModel() {
      return str('OUTREACH_MODEL', 'claude-sonnet-5');
    },
    /**
     * Model for the company verdict. By default the same one that writes the first paragraph.
     *
     * The task is of the same order in volume and cost of error: one decision per company the
     * owner is about to write to, dozens a month rather than thousands. Haiku works here too, but
     * confuses similar templates more often than the saved cent is worth, and prompt caching barely
     * applies to it: the minimum cacheable block is 4096 tokens, and the template system block is shorter.
     */
    get verdictModel() {
      return str('VERDICT_MODEL', this.outreachModel);
    },
    /** Workers AI model. Llama 3.3 is the cheapest of those that hold strict JSON. */
    get workersModel() {
      return str('WORKERS_AI_MODEL', '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    },
    /**
     * The model that will actually run. The cache key is built from it: answers from different
     * models must not mix in one cache, otherwise switching providers would silently serve
     * someone else's classifications.
     */
    get activeModel() {
      return this.provider === 'workers-ai' ? this.workersModel : this.model;
    },
    /**
     * Anthropic base URL. Empty means a direct call.
     *
     * With an AI Gateway set, every call goes through it and gains a cache, a hard spend limit and
     * a log of each request. Without it only the `llm_usage` counter is visible, that is, how many
     * calls, but not what or why.
     * Format: https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic
     */
    get baseUrl() {
      const explicit = str('ANTHROPIC_BASE_URL', '');
      if (explicit) return explicit;
      // The gateway is configured once, and Anthropic goes through it without a separate variable.
      const gateway = config.cloudflare.gatewayUrl;
      return gateway ? `${gateway}/anthropic` : '';
    },
    /**
     * Daily call cap. Different for the two providers on purpose: with Anthropic every call is
     * money for tokens, and 500 a day is a guard against a silently burned budget. With Workers AI
     * it is neurons of an already paid plan, so the same cap would just mean unfinished work.
     */
    get dailyCallLimit() {
      return this.provider === 'workers-ai'
        ? num('WORKERS_AI_DAILY_CALL_LIMIT', 5000)
        : num('LLM_DAILY_CALL_LIMIT', 500);
    },
    /** How many characters of vacancy text go to the model. A longer tail adds almost nothing. */
    get maxInputChars() {
      return num('LLM_MAX_INPUT_CHARS', 8000);
    },
  },
  /**
   * Gmail for sending. OAuth2, not SMTP with an app password: without `threadId` and reading the
   * inbox neither reply detection nor correct follow-up threading is possible.
   *
   * The token lives in a separate file, not in the database: OUTREACH.md, section 0, rule 6.
   * It must not be kept together with the data, and a database backup with the refresh token
   * inside is access to the owner's mailbox in an archive.
   */
  /**
   * Who sends the letters. `gmail` is the default and the only provider that can
   * also read the mailbox, which is what reply detection needs. `resend` is an
   * HTTPS call with no token file, so it is the only one that works on a worker.
   */
  mail: {
    get provider(): 'gmail' | 'resend' {
      return str('MAIL_PROVIDER', 'gmail') === 'resend' ? 'resend' : 'gmail';
    },
    get resendKey() {
      return str('RESEND_API_KEY', '');
    },
  },
  gmail: {
    get clientId() {
      return str('GOOGLE_CLIENT_ID', '');
    },
    get clientSecret() {
      return str('GOOGLE_CLIENT_SECRET', '');
    },
    get tokenPath() {
      return str('GMAIL_TOKEN_PATH', 'data/.gmail-token.json');
    },
    /**
     * Name in the From field. A letter from a bare address reads as bulk mail,
     * so this should be filled in. Empty by default: a fork must not send mail
     * signed with someone else's name.
     */
    get fromName() {
      return str('GMAIL_FROM_NAME', '');
    },
    get fromEmail() {
      return str('GMAIL_FROM_EMAIL', '');
    },
    /**
     * Port of the local code catcher during `auth:gmail`. Fixed, because the same redirect_uri
     * has to be registered in the Google console.
     */
    get authPort() {
      return num('GMAIL_AUTH_PORT', 53682);
    },
    /**
     * Where Google returns the code. Empty means the local catcher.
     *
     * In production this is the worker address, for example
     * https://job-radar.example.workers.dev/api/gmail/callback, and then connecting happens from
     * the browser, without running the project on a laptop.
     */
    get redirectUri() {
      return str('GMAIL_REDIRECT_URI', '');
    },
    /**
     * The refresh token as an environment secret. This is the path for Workers, which have no
     * filesystem: `wrangler secret put GMAIL_REFRESH_TOKEN`.
     *
     * It has no place in the database on purpose, section 0 of OUTREACH.md: a database backup
     * with the token inside is access to the owner's mailbox in every archive.
     */
    get refreshToken() {
      return str('GMAIL_REFRESH_TOKEN', '');
    },
  },
  telegram: {
    get token() {
      return str('TELEGRAM_BOT_TOKEN', '');
    },
    get chatId() {
      return str('TELEGRAM_CHAT_ID', '');
    },
  },
  pipeline: {
    get scoreThreshold() {
      return num('SCORE_THRESHOLD', 6);
    },
    get recontactAfterDays() {
      return num('RECONTACT_AFTER_DAYS', 90);
    },
    get queueDailyLimit() {
      return num('QUEUE_DAILY_LIMIT', 10);
    },
    get snapshotsPerCompany() {
      return num('SNAPSHOTS_PER_COMPANY', 5);
    },
  },
};
