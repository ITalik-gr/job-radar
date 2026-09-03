import 'dotenv/config';

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  dbPath: process.env.DB_PATH ?? 'data/radar.db',
  log: {
    level: process.env.LOG_LEVEL ?? 'info',
  },
  http: {
    userAgent: `JobRadar/0.1 (+mailto:${process.env.USER_AGENT_CONTACT ?? 'unknown'})`,
    concurrency: num(process.env.HTTP_CONCURRENCY, 4),
    domainDelayMs: num(process.env.HTTP_DOMAIN_DELAY_MS, 1000),
    timeoutMs: num(process.env.HTTP_TIMEOUT_MS, 20000),
    retries: num(process.env.HTTP_RETRIES, 3),
  },
  llm: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    model: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001',
    dailyCallLimit: num(process.env.LLM_DAILY_CALL_LIMIT, 500),
  },
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN ?? '',
    chatId: process.env.TELEGRAM_CHAT_ID ?? '',
  },
  pipeline: {
    scoreThreshold: num(process.env.SCORE_THRESHOLD, 6),
    recontactAfterDays: num(process.env.RECONTACT_AFTER_DAYS, 90),
    queueDailyLimit: num(process.env.QUEUE_DAILY_LIMIT, 10),
    snapshotsPerCompany: num(process.env.SNAPSHOTS_PER_COMPANY, 5),
  },
} as const;
