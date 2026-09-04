import 'dotenv/config';

/**
 * Конфіг читається лениво через геттери. Причина: на Cloudflare змінні приходять
 * біндінгами воркера вже після завантаження модулів, тому обчислення при імпорті
 * давало порожній ключ Anthropic і вимкнений телеграм, причому мовчки.
 */

let runtime: Record<string, string | undefined> =
  typeof process !== 'undefined' && process.env ? { ...process.env } : {};

/** Викликається воркером на кожен запит, до обробки. */
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
  /** Токен доступу. Порожній означає, що радар локальний і перевірки немає. */
  get token() {
    return str('RADAR_TOKEN', '');
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
   * Доступ до Workers AI поза Workers: локальний CLI і тести.
   *
   * Імена навмисно свої, а не `CLOUDFLARE_API_TOKEN`. Wrangler читає `.env` і бере
   * звідти саме `CLOUDFLARE_API_TOKEN` як свій ключ авторизації, тобто токен,
   * виданий лише на Workers AI, підмінював логін власника і ламав усе інше:
   * `wrangler d1 migrations apply` падав з 7403 "account is not authorized".
   * Старі імена читаються далі, щоб нічий локальний .env не зламався.
   */
  cloudflare: {
    get accountId() {
      return str('CF_AI_ACCOUNT_ID', str('CLOUDFLARE_ACCOUNT_ID', ''));
    },
    get apiToken() {
      return str('CF_AI_API_TOKEN', str('CLOUDFLARE_API_TOKEN', ''));
    },
  },

  llm: {
    /**
     * Хто класифікує: `anthropic` або `workers-ai`.
     *
     * Workers AI входить у платний план Cloudflare, який власник уже оплачує,
     * тому класифікація там коштує нейрони з включеної квоти, а не окремі долари.
     * Anthropic лишається за замовчуванням: якість вища, і саме на ній зібрано кеш.
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
    /** Модель Workers AI. Llama 3.3 обрана як найдешевша з тих, що тримають строгий JSON. */
    get workersModel() {
      return str('WORKERS_AI_MODEL', '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
    },
    /**
     * Модель, яка реально працюватиме. Ключ кешу будується саме з неї: відповіді
     * різних моделей не можна змішувати в одному кеші, інакше зміна провайдера
     * мовчки віддавала б чужі класифікації.
     */
    get activeModel() {
      return this.provider === 'workers-ai' ? this.workersModel : this.model;
    },
    /**
     * Базова адреса Anthropic. Порожня означає прямий виклик.
     *
     * Якщо вказати шлюз AI Gateway, усі виклики йдуть через нього і зʼявляються
     * кеш, жорсткий ліміт витрат і лог кожного запиту. Зараз видно лише лічильник
     * у `llm_usage`, тобто скільки викликів, але не що саме і чому.
     * Формат: https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic
     */
    get baseUrl() {
      return str('ANTHROPIC_BASE_URL', '');
    },
    /**
     * Стеля викликів на добу. Різна для двох провайдерів навмисно: у Anthropic
     * кожен виклик це гроші за токени, і 500 на добу це запобіжник від тихо
     * спаленого бюджету. У Workers AI це нейрони вже оплаченого плану, тому
     * та сама стеля означала б просто недороблену роботу.
     */
    get dailyCallLimit() {
      return this.provider === 'workers-ai'
        ? num('WORKERS_AI_DAILY_CALL_LIMIT', 5000)
        : num('LLM_DAILY_CALL_LIMIT', 500);
    },
    /** Скільки символів тексту вакансії йде в модель. Довший хвіст майже не додає користі. */
    get maxInputChars() {
      return num('LLM_MAX_INPUT_CHARS', 8000);
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
