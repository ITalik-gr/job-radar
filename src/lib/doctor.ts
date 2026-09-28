import { config } from '../config.js';
import { modelAvailable } from '../pipeline/classify.js';
import { isConfigured as telegramConfigured } from '../notify/telegram.js';
import { mailer } from './mailer.js';

export interface Check {
  level: 'ok' | 'warn' | 'info';
  what: string;
  message: string;
}

/**
 * What a local install is missing, from the configuration alone. `pnpm cli doctor` without an
 * address prints this; README sends newcomers there, and it used to demand a worker URL.
 */
export function localChecks(): Check[] {
  const checks: Check[] = [];

  checks.push(
    modelAvailable()
      ? { level: 'ok', what: 'model', message: `${config.llm.provider}, ${config.llm.activeModel}` }
      : {
          level: 'warn',
          what: 'model',
          message:
            config.llm.provider === 'workers-ai'
              ? 'no CF_AI_ACCOUNT_ID and CF_AI_API_TOKEN: vacancies are collected and scored by keywords, not classified'
              : 'no ANTHROPIC_API_KEY: vacancies are collected and scored by keywords, not classified',
        },
  );

  checks.push(
    config.http.userAgent.includes('mailto:unknown')
      ? {
          level: 'warn',
          what: 'user agent',
          message: 'USER_AGENT_CONTACT is empty: site owners see "unknown" instead of a way to reach you',
        }
      : { level: 'ok', what: 'user agent', message: config.http.userAgent },
  );

  checks.push(
    telegramConfigured()
      ? { level: 'ok', what: 'telegram', message: 'configured' }
      : { level: 'info', what: 'telegram', message: 'off, no TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID' },
  );

  const mail = mailer().status();
  checks.push(
    mail.connected
      ? { level: 'ok', what: 'mail', message: `${mail.id}, from ${mail.fromEmail ?? 'unknown'}` }
      : { level: 'info', what: 'mail', message: `${mail.id} not connected${mail.hint ? `: ${mail.hint}` : ''}` },
  );
  if (mail.connected && !config.gmail.fromName) {
    checks.push({
      level: 'warn',
      what: 'from name',
      message: 'GMAIL_FROM_NAME is empty: letters go out from a bare address',
    });
  }

  checks.push(
    config.token
      ? { level: 'ok', what: 'token', message: 'RADAR_TOKEN is set' }
      : { level: 'info', what: 'token', message: 'no RADAR_TOKEN: fine locally, required on a deployed worker' },
  );

  return checks;
}
