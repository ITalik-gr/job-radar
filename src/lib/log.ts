/**
 * A minimal logger with the same interface pino used to have.
 * Reason for the replacement: pino drags along Node-specific transports and a file
 * system, and the same code must also work on Cloudflare Workers, where neither exists.
 */

export type Level = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const COLORS: Record<Exclude<Level, 'silent'>, string> = {
  debug: '\x1b[90m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
};

export interface Logger {
  level: Level;
  debug(context: unknown, message?: string): void;
  info(context: unknown, message?: string): void;
  warn(context: unknown, message?: string): void;
  error(context: unknown, message?: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

function time(): string {
  return new Date().toISOString().slice(11, 19);
}

function isNode(): boolean {
  return typeof process !== 'undefined' && Boolean(process.stdout);
}

export function createLogger(level: Level, bindings: Record<string, unknown> = {}): Logger {
  const write = (target: Exclude<Level, 'silent'>, context: unknown, message?: string) => {
    if (ORDER[target] < ORDER[level]) return;

    const payload =
      typeof context === 'string' ? { ...bindings } : { ...bindings, ...(context as Record<string, unknown>) };
    const text = typeof context === 'string' ? context : (message ?? '');
    const details = Object.keys(payload).length > 0 ? ` ${JSON.stringify(payload)}` : '';

    const line = isNode()
      ? `${COLORS[target]}${time()} ${target.toUpperCase()}\x1b[0m ${text}${details}`
      : `${time()} ${target.toUpperCase()} ${text}${details}`;

    if (target === 'error') console.error(line);
    else if (target === 'warn') console.warn(line);
    else console.log(line);
  };

  return {
    level,
    debug: (context, message) => write('debug', context, message),
    info: (context, message) => write('info', context, message),
    warn: (context, message) => write('warn', context, message),
    error: (context, message) => write('error', context, message),
    child: (extra) => createLogger(level, { ...bindings, ...extra }),
  };
}

const configured = (typeof process !== 'undefined' ? process.env.LOG_LEVEL : undefined) as Level | undefined;

export const log = createLogger(configured ?? 'info');
